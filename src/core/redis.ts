/**
 * Redis 客户端
 * 连接真实 Redis；本机地址连接失败时尝试拉起本地 redis-server；
 * 仍失败则按 cfg.jiuli.redis_fallback 决定降级为内存实现（未实现的命令返回 null 并告警一次）或退出。
 */
import { createClient } from 'redis'
import { spawn } from 'node:child_process'
import cfg from './config/index.js'
import { logger } from './log.js'
import util from './util.js'

/** ============ 内存降级实现 ============ */
type Entry = { type: 'string' | 'hash' | 'set' | 'zset' | 'list'; value: any; expireAt?: number }

class MemoryRedis {
  store = new Map<string, Entry>()
  warned = new Set<string>()
  isOpen = true
  isReady = true
  process: any = undefined

  private alive(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expireAt && entry.expireAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  private entry(key: string, type: Entry['type']): Entry {
    const exist = this.alive(key)
    if (exist) {
      if (exist.type !== type) {
        // 类型冲突时覆盖（简化处理）
        const fresh: Entry = { type, value: this.empty(type) }
        this.store.set(key, fresh)
        return fresh
      }
      return exist
    }
    const fresh: Entry = { type, value: this.empty(type) }
    this.store.set(key, fresh)
    return fresh
  }

  private empty(type: Entry['type']) {
    switch (type) {
      case 'string':
        return ''
      case 'hash':
        return new Map<string, any>()
      case 'set':
        return new Set<string>()
      case 'zset':
        return new Map<string, number>()
      case 'list':
        return [] as any[]
    }
  }

  private unsupported(cmd: string) {
    if (!this.warned.has(cmd)) {
      this.warned.add(cmd)
      util.makeLog('warn', `内存降级模式暂不支持命令 ${cmd}，返回 null`, 'Redis')
    }
    return null
  }

  /* -------- string -------- */
  async get(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'string' ? entry.value : null
  }
  async set(key: string, value: any, opts: any = {}) {
    const entry = this.entry(key, 'string')
    entry.value = String(value)
    entry.expireAt = undefined
    const ex = opts.EX ?? opts.ex ?? (opts.PX ?? opts.px ? undefined : undefined)
    if (opts.EX || opts.ex) entry.expireAt = Date.now() + (opts.EX ?? opts.ex) * 1000
    else if (opts.PX || opts.px) entry.expireAt = Date.now() + (opts.PX ?? opts.px)
    else if (typeof ex === 'number') entry.expireAt = Date.now() + ex * 1000
    return 'OK'
  }
  async setEx(key: string, seconds: number, value: any) {
    return this.set(key, value, { EX: seconds })
  }
  async del(keys: string | string[]) {
    let count = 0
    for (const key of Array.isArray(keys) ? keys : [keys]) if (this.store.delete(key)) count++
    return count
  }
  async exists(keys: string | string[]) {
    let count = 0
    for (const key of Array.isArray(keys) ? keys : [keys]) if (this.alive(key)) count++
    return count
  }
  async expire(key: string, seconds: number) {
    const entry = this.alive(key)
    if (!entry) return 0
    entry.expireAt = Date.now() + seconds * 1000
    return 1
  }
  async ttl(key: string) {
    const entry = this.alive(key)
    if (!entry) return -2
    if (!entry.expireAt) return -1
    return Math.ceil((entry.expireAt - Date.now()) / 1000)
  }
  async incr(key: string) {
    return this.incrBy(key, 1)
  }
  async incrBy(key: string, value: number) {
    const entry = this.entry(key, 'string')
    entry.value = String((Number(entry.value) || 0) + Number(value))
    return Number(entry.value)
  }
  async decr(key: string) {
    return this.incrBy(key, -1)
  }
  async decrBy(key: string, value: number) {
    return this.incrBy(key, -value)
  }
  async mGet(keys: string[]) {
    return Promise.all(keys.map(key => this.get(key)))
  }
  async mSet(pairs: any) {
    const list = Array.isArray(pairs) ? pairs : Object.entries(pairs)
    for (const [key, value] of list) await this.set(key, value)
    return 'OK'
  }
  async keys(pattern: string) {
    const reg = this.patternToReg(pattern)
    return [...this.store.keys()].filter(key => this.alive(key) && reg.test(key))
  }
  async scan(cursor: string | number, opts: any = {}) {
    const all = await this.keys(opts.MATCH ?? opts.match ?? '*')
    const count = Number(opts.COUNT ?? opts.count ?? 10)
    const index = Number(cursor) || 0
    const slice = all.slice(index, index + count)
    const next = index + count >= all.length ? '0' : String(index + count)
    return { cursor: next, keys: slice }
  }
  private patternToReg(pattern: string) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
  }

  /* -------- hash -------- */
  async hGet(key: string, field: string) {
    const entry = this.alive(key)
    return entry?.type === 'hash' ? (entry.value.get(field) ?? null) : null
  }
  async hSet(key: string, field: any, value?: any) {
    const entry = this.entry(key, 'hash')
    const pairs = typeof field === 'object' ? Object.entries(field) : [[field, value]]
    let added = 0
    for (const [f, v] of pairs as any[]) {
      if (!entry.value.has(String(f))) added++
      entry.value.set(String(f), String(v))
    }
    return added
  }
  async hGetAll(key: string) {
    const entry = this.alive(key)
    if (entry?.type !== 'hash') return {}
    return Object.fromEntries(entry.value)
  }
  async hDel(key: string, fields: string | string[]) {
    const entry = this.alive(key)
    if (entry?.type !== 'hash') return 0
    let count = 0
    for (const field of Array.isArray(fields) ? fields : [fields]) if (entry.value.delete(field)) count++
    return count
  }
  async hKeys(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'hash' ? [...entry.value.keys()] : []
  }
  async hVals(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'hash' ? [...entry.value.values()] : []
  }
  async hIncrBy(key: string, field: string, value: number) {
    const entry = this.entry(key, 'hash')
    const next = (Number(entry.value.get(field)) || 0) + Number(value)
    entry.value.set(field, String(next))
    return next
  }

  /* -------- set -------- */
  async sAdd(key: string, members: string | string[]) {
    const entry = this.entry(key, 'set')
    let count = 0
    for (const member of Array.isArray(members) ? members : [members])
      if (!entry.value.has(String(member))) {
        entry.value.add(String(member))
        count++
      }
    return count
  }
  async sMembers(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'set' ? [...entry.value] : []
  }
  async sRem(key: string, members: string | string[]) {
    const entry = this.alive(key)
    if (entry?.type !== 'set') return 0
    let count = 0
    for (const member of Array.isArray(members) ? members : [members]) if (entry.value.delete(String(member))) count++
    return count
  }
  async sIsMember(key: string, member: string) {
    const entry = this.alive(key)
    return entry?.type === 'set' ? entry.value.has(String(member)) : false
  }
  async sCard(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'set' ? entry.value.size : 0
  }

  /* -------- zset -------- */
  async zAdd(key: string, members: any) {
    const entry = this.entry(key, 'zset')
    const list = Array.isArray(members) ? members : [members]
    let added = 0
    for (const item of list) {
      const score = Number(item.score)
      const member = String(item.value ?? item.member)
      if (!entry.value.has(member)) added++
      entry.value.set(member, score)
    }
    return added
  }
  async zRange(key: string, start: number, stop: number, opts: any = {}) {
    const entry = this.alive(key)
    if (entry?.type !== 'zset') return []
    const sorted = [...entry.value.entries()].sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])))
    const end = stop === -1 ? sorted.length : stop + 1
    const slice = sorted.slice(start < 0 ? Math.max(0, sorted.length + start) : start, end)
    return opts.REV ? slice.reverse().map(i => i[0]) : slice.map(i => i[0])
  }
  async zRangeWithScores(key: string, start: number, stop: number) {
    const entry = this.alive(key)
    if (entry?.type !== 'zset') return []
    const sorted = [...entry.value.entries()].sort((a, b) => a[1] - b[1])
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end).map(([value, score]) => ({ value, score }))
  }
  async zRem(key: string, members: string | string[]) {
    const entry = this.alive(key)
    if (entry?.type !== 'zset') return 0
    let count = 0
    for (const member of Array.isArray(members) ? members : [members]) if (entry.value.delete(String(member))) count++
    return count
  }
  async zRemRangeByScore(key: string, min: number | string, max: number | string) {
    const entry = this.alive(key)
    if (entry?.type !== 'zset') return 0
    const lower = min === '-inf' ? -Infinity : Number(min)
    const upper = max === '+inf' ? Infinity : Number(max)
    let count = 0
    for (const [member, score] of [...entry.value.entries()])
      if (score >= lower && score <= upper) {
        entry.value.delete(member)
        count++
      }
    return count
  }
  async zCard(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'zset' ? entry.value.size : 0
  }
  async zScore(key: string, member: string) {
    const entry = this.alive(key)
    return entry?.type === 'zset' ? (entry.value.get(String(member)) ?? null) : null
  }
  async zRank(key: string, member: string) {
    const entry = this.alive(key)
    if (entry?.type !== 'zset') return null
    const sorted = [...entry.value.entries()].sort((a, b) => a[1] - b[1]).map(i => i[0])
    const index = sorted.indexOf(String(member))
    return index === -1 ? null : index
  }
  async zRevRank(key: string, member: string) {
    const rank = await this.zRank(key, member)
    if (rank === null) return null
    const entry = this.alive(key)
    return (entry as any).value.size - 1 - rank
  }

  /* -------- list -------- */
  async lPush(key: string, values: any) {
    const entry = this.entry(key, 'list')
    const list = Array.isArray(values) ? values : [values]
    entry.value.unshift(...list)
    return entry.value.length
  }
  async rPush(key: string, values: any) {
    const entry = this.entry(key, 'list')
    const list = Array.isArray(values) ? values : [values]
    entry.value.push(...list)
    return entry.value.length
  }
  async lRange(key: string, start: number, stop: number) {
    const entry = this.alive(key)
    if (entry?.type !== 'list') return []
    const end = stop === -1 ? entry.value.length : stop + 1
    return entry.value.slice(start < 0 ? Math.max(0, entry.value.length + start) : start, end)
  }
  async lPop(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'list' ? (entry.value.shift() ?? null) : null
  }
  async rPop(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'list' ? (entry.value.pop() ?? null) : null
  }
  async lLen(key: string) {
    const entry = this.alive(key)
    return entry?.type === 'list' ? entry.value.length : 0
  }

  /* -------- 其他 -------- */
  async ping(id?: string) {
    return id ?? 'PONG'
  }
  async info() {
    return '# MemoryRedis (fallback)\r\nredis_version:7.0.0-jiuli-memory\r\n'
  }
  async flushAll() {
    this.store.clear()
    return 'OK'
  }
  async sendCommand(args: any[]) {
    const cmd = String(args[0] ?? '').toLowerCase()
    const fn = (this as any)[cmd]
    if (typeof fn === 'function') return fn.apply(this, args.slice(1))
    return this.unsupported(cmd)
  }
  multi() {
    const queue: Array<() => Promise<any>> = []
    const self = this
    const chain: any = {
      exec: async () => {
        const ret = []
        for (const job of queue) ret.push(await job())
        return ret
      },
    }
    const proxy = new Proxy(chain, {
      get: (target, prop: string) => {
        if (prop in target) return (target as any)[prop]
        return (...args: any[]) => {
          queue.push(async () => (self as any)[prop]?.(...args))
          return proxy
        }
      },
    })
    return proxy
  }
  duplicate() {
    return this
  }
  on() {
    return this
  }
  once() {
    return this
  }
  off() {
    return this
  }
  async quit() {
    this.isOpen = false
    return 'OK'
  }
  async disconnect() {
    this.isOpen = false
    return undefined
  }
}

/** ============ 真实客户端封装（兼容 TRSS 的 Redis 类行为） ============ */
export class Redis {
  opts: any
  redis: any
  err: any
  lock = false
  exit?: boolean

  constructor(opts: any, exit?: boolean) {
    this.opts = opts
    this.exit = exit
    this.redis = createClient(opts)
    this.redis.class = this
  }

  async connect(force?: boolean) {
    if (this.lock && !force) return
    this.lock = true

    try {
      await this.redis.connect()
    } catch (err) {
      await this.redis.disconnect().catch(() => {})
      this.err = err
      this.lock = false
      if (!force) return this.start()
      return false
    }

    for (let i = 0; i < 5; i++) {
      try {
        const id = Date.now().toString(36)
        if ((await this.redis.ping(id)) === id) break
      } catch (err) {
        util.makeLog('error', err, 'Redis')
      }
      await util.sleep(1000)
    }

    this.lock = false
    return this.redis.once('error', this.onerror)
  }

  /**
   * 本机没有 Redis 时尝试自动安装（仅 root + 已知包管理器，装不上就按 redis_fallback 降级）
   * 首次部署最常见的缺件就是它，与其让日志报一堆 ECONNREFUSED 不如直接补齐
   */
  private async installLocal(): Promise<boolean> {
    if (process.env.JIULI_NO_AUTO_INSTALL) return false
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false
    const pick = async (bin: string, args: string[]) =>
      (await util.cmdPath(bin)) ? [bin, ...args] : null
    const cmd =
      (await pick('apt-get', ['update', '-qq'])) && (await pick('apt-get', ['install', '-y', '-qq', 'redis-server']))
    const dnf = (await pick('dnf', ['install', '-y', 'redis'])) || (await pick('yum', ['install', '-y', 'redis']))
    const use = cmd || dnf
    if (!use) return false

    util.makeLog(
      'warn',
      `本机没有 Redis，正在自动安装：${use.join(' ')}\n` +
        `        （不想自动装可执行 redis.yaml → path 指定自己的 redis-server，或关掉 redis_fallback）`,
      'Redis',
    )
    const ret: any = await util.exec(use.join(' '), { quiet: true, timeout: 300000 })
    if (ret.error) {
      util.makeLog('error', `自动安装 Redis 失败：${ret.stderr || ret.error.message || ret.error}`, 'Redis')
      return false
    }
    if (await util.cmdPath('systemctl')) {
      const svc: any = await util.exec('systemctl enable --now redis-server', { quiet: true })
      if (!svc.error) util.makeLog('mark', 'Redis 已安装并设为开机自启', 'Redis')
    }
    return true
  }

  async start(): Promise<any> {
    const host = this.opts.socket.host
    if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) {
      util.makeLog('error', `连接 ${host} 失败，请确认连接地址正确`, 'Redis')
      if (this.exit) return (globalThis as any).Bot?.exit?.()
      return false
    }

    const cmd = String(cfg.redis.path || 'redis-server')
    let pathOk = await util.cmdPath(cmd.split(' ')[0])
    /** 没装就先试着装上（首次部署的常见缺件） */
    if (!pathOk && (await this.installLocal())) pathOk = await util.cmdPath(cmd.split(' ')[0])
    if (pathOk) {
      util.makeLog('info', `正在启动 ${cmd} --port ${this.opts.socket.port}`, 'Redis')
      const proc: any = spawn(cmd, ['--port', String(this.opts.socket.port)], { shell: true })
        .on('error', err => {
          util.makeLog('error', ['启动错误', err], 'Redis')
          proc.exit = true
        })
        .on('exit', () => (proc.exit = true))
      proc.stdout?.on('data', (data: any) => util.makeLog('info', String(data).trim(), 'Redis'))
      proc.stderr?.on('data', (data: any) => util.makeLog('error', String(data).trim(), 'Redis'))

      for (let i = 0; i < 15; i++) {
        await util.sleep(1000)
        if (proc.exit) break
        const ret = await this.connect(true)
        if (ret) {
          ;(this.redis as any).process = proc
          return ret
        }
      }
      proc.kill()
    }

    util.makeLog('error', `连接失败：${this.err?.message || this.err}`, 'Redis')
    util.makeLog(
      'error',
      `        本机没有可用的 Redis：装一个（apt install redis-server / 或用 redis.yaml → path 指定路径），` +
        `或把 config/jiuli.yaml → redis_fallback 设为 true 用内存实现（数据重启后丢失）`,
      'Redis',
    )
    if (this.exit) return (globalThis as any).Bot?.exit?.()
    return false
  }

  /** 连续失败次数与上次报错时间：Redis 挂掉时避免每秒刷屏 */
  private errCount = 0
  private errAt = 0

  onerror = async (err: any) => {
    const now = Date.now()
    this.errCount++
    /** 每 10 秒最多报一次，且带上累计次数 */
    if (now - this.errAt > 10000) {
      this.errAt = now
      util.makeLog(
        'error',
        `连接中断（第 ${this.errCount} 次）：${err?.message || err}\n` +
          `        Redis 可能已停止；重启前数据操作会失败，插件自建的 Redis 连接也会报错`,
        'Redis',
      )
    }
    await this.redis.disconnect().catch(() => {})
    /** 反复连不上且允许降级时，换成内存实现，避免一直重试 */
    if (this.errCount >= 3 && (cfg.getCompat().redis_fallback ?? cfg.getAllCfg('jiuli').redis_fallback ?? true)) {
      util.makeLog('warn', 'Redis 多次重连失败，已切换为内存实现（数据重启后丢失）', 'Redis')
      ;(globalThis as any).redis = new MemoryRedis()
      return
    }
    return this.connect()
  }
}

/** 注入全局 redis */
export async function redisInit(): Promise<any> {
  if (process.env.JIULI_REDIS === 'memory') {
    util.makeLog('warn', 'JIULI_REDIS=memory，使用内存实现', 'Redis')
    return ((globalThis as any).redis = new MemoryRedis())
  }

  const rc = cfg.redis
  const client: any = await new Redis(
    {
      socket: { host: rc.host, port: Number(rc.port) },
      username: rc.username || undefined,
      password: rc.password || undefined,
      database: Number(rc.db) || 0,
    },
    false,
  ).connect()

  if (client) {
    util.makeLog('info', `已连接 redis://${rc.host}:${rc.port}/${rc.db || 0}`, 'Redis')
    return ((globalThis as any).redis = client)
  }

  if (cfg.getCompat().redis_fallback ?? cfg.getAllCfg('jiuli').redis_fallback ?? true) {
    util.makeLog('warn', '使用内存降级实现，数据重启后丢失（config/config/jiuli.yaml → redis_fallback）', 'Redis')
    return ((globalThis as any).redis = new MemoryRedis())
  }

  util.makeLog('error', '无法连接且未开启内存降级，进程退出', 'Redis')
  return (globalThis as any).Bot?.exit?.()
}

export { MemoryRedis }
export default redisInit
