/**
 * 配置中心（兼容云崽 config 形态）
 * cfg 是 Proxy：未定义的属性回落为 getAllCfg(prop)，即 default_config 与用户配置的合并结果。
 */
import YAML from 'yaml'
import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import EventEmitter from 'node:events'
import { logger } from '../log.js'

/** id 对齐到 log_align 宽度（此处自带实现：util 依赖 config，反向 import 会成环） */
function makeId(id: string) {
  const align: string | undefined = (globalThis as any).cfg?.bot?.log_align
  if (!align) return id
  const pad = (align.length - id.length) / 2
  if (pad > 0) return `${' '.repeat(Math.ceil(pad))}${id}${' '.repeat(Math.floor(pad))}`
  if (pad < 0) return `${id.slice(0, align.length - 1)}.`
  return id
}

/** 配置文件读取错误时安全记录（Bot 可能尚未创建） */
function safeLog(msg: any) {
  try {
    logger.warn(logger.blue(`[${makeId('Config')}]`), msg)
  } catch {
    /* ignore */
  }
}

/**
 * 递归复制目录（等价 fs.cpSync(src, dst, { recursive: true })）
 *
 * 为什么不用 fs.cpSync：Node 25（Windows）上递归拷贝「源路径含非 ASCII 字符」的目录
 * 会直接崩掉进程——退出码 0xC0000409(STATUS_STACK_BUFFER_OVERRUN)、没有任何 JS 报错、
 * 连 catch 都进不去。于是把 JiuLi 装在中文路径（如 D:\yunzaibot\测试\测试jiuli\jiuli）的用户
 * 首次启动会在 initCfg() 里静默死掉，看起来就像「node . 什么都不做就退出了」。
 * 手写递归用 readdirSync + copyFileSync，对非 ASCII 路径正常。
 */
function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name)
    const to = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

/** file_watch=false 时使用的空 watcher */
class NullWatcher extends EventEmitter {
  on() {
    return this
  }
  addListener() {
    return this
  }
  start() {}
  close() {}
  ref() {
    return this
  }
  unref() {
    return this
  }
}

class Cfg {
  config: Record<string, any> = {}
  watcher: Record<string, any> = {}
  _package?: Record<string, any>
  /** getAllCfg 合并结果缓存，配置变更时失效 */
  mergedCache = new Map<string, any>()
  /** 群配置 4 层合并结果缓存，(bot_id,group_id) → 配置 */
  groupCache = new Map<string, any>()

  /** 用户配置目录，可用 JIULI_CONFIG_DIR 覆盖（测试/多实例隔离） */
  get userDir(): string {
    return process.env.JIULI_CONFIG_DIR || 'config/config/'
  }

  constructor() {
    this.initCfg()
    return new Proxy(this, {
      get: (target: any, prop: string | symbol) => {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'inspect') {
          return Reflect.get(target, prop)
        }
        const value = target[prop]
        if (value !== undefined) return value
        return target.getAllCfg(String(prop))
      },
    })
  }

  /** 初始化配置目录：default_config → 用户配置目录 */
  initCfg() {
    const dir = this.userDir
    const defDir = 'config/default_config/'
    try {
      const filesDef = fs.readdirSync(defDir).filter(f => f !== 'pm2.yaml')
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
        for (const i of filesDef)
          if (!files.includes(i)) fs.copyFileSync(`${defDir}${i}`, `${dir}${i}`)
      } else copyDir(defDir, dir)
      /** pm2 配置放在 config/ 下，供 pnpm start 使用 */
      const pm2File = 'config/pm2.yaml'
      if (!fs.existsSync(pm2File) && fs.existsSync(`${defDir}pm2.yaml`))
        fs.copyFileSync(`${defDir}pm2.yaml`, pm2File)
      /** 清理被误复制进用户配置目录的 pm2.yaml
       *  用 unlinkSync 而不是 rmSync：Node 25（Windows）在非 ASCII 路径下 rmSync 会静默失效 */
      const stray = `${dir}pm2.yaml`
      if (fs.existsSync(stray)) {
        try {
          fs.unlinkSync(stray)
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      safeLog(`[Config] 初始化配置目录失败：${err}`)
    }

    if (this.getAllCfg('bot').file_watch === false) {
      const watcher = new NullWatcher() as any
      fs.watch = (() => watcher) as any
      chokidar.watch = (() => watcher) as any
      ;(chokidar as any).FSWatcher = NullWatcher
      for (const i in this.watcher) {
        this.watcher[i]?.close?.()
        delete this.watcher[i]
      }
      this.watch = () => {}
      safeLog('[Config] file_watch=false，已关闭文件监听')
    }
  }

  /** 主人账号 [bot_id, user_id][] */
  get master(): Record<string, string[]> {
    const other = this.getAllCfg('other')
    if (other.masters) return other.masters
    let master = other.master || []
    if (!Array.isArray(master)) master = [master]

    const masters: Record<string, string[]> = {}
    for (let i of master) {
      i = String(i).split(':')
      const bot_id = i.shift() as string
      const user_id = i.join(':')
      if (Array.isArray(masters[bot_id])) masters[bot_id].push(user_id)
      else masters[bot_id] = [user_id]
    }
    return (this.config['config.other'].masters = masters)
  }

  get masterQQ(): Array<number | string> {
    const other = this.getAllCfg('other')
    if (other.masterQQs) return other.masterQQs
    let masterQQ = other.masterQQ || []
    if (!Array.isArray(masterQQ)) masterQQ = [masterQQ]
    return (this.config['config.other'].masterQQs = masterQQ.map((i: any) => Number(i) || i))
  }

  /** 机器人账号 */
  get uin(): string[] {
    return Object.keys(this.master)
  }
  get qq(): string[] {
    return this.uin
  }

  /** package.json；启用框架伪装时对外以框架标识替换 name / version */
  get package(): Record<string, any> {
    if (this._package) return this._package
    let pkg: Record<string, any> = {}
    try {
      pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    } catch (err) {
      safeLog(`[Config] 读取 package.json 失败：${err}`)
    }
    const name = this.frameworkName
    const version = this.frameworkVersion
    /** 对外名与真实包名不一致时，保留真实值到 real_name / real_version */
    if (name && name !== pkg.name)
      pkg = { ...pkg, real_name: pkg.name, real_version: pkg.version, name, version }
    return (this._package = pkg)
  }

  /** 对外暴露的框架名，仅 compat.spoof_yunzai 时显示为 trss-yunzai */
  get frameworkName(): string {
    return this.getCompat().spoof_yunzai === true ? 'trss-yunzai' : 'JiuLi'
  }

  /** 对外版本号；默认 3.1.3，避免老插件判定"版本过低" */
  get frameworkVersion(): string {
    const compat = this.getCompat()
    return String(compat.framework_version ?? compat.version ?? '3.1.3')
  }

  getCompat() {
    return this.getAllCfg('jiuli').compat || {}
  }

  getPerf() {
    return this.getAllCfg('jiuli').perf || {}
  }

  /** 群配置 4 层合并：default → bot:default → group → bot:group */
  getGroup(bot_id: string | number = '', group_id: string | number = ''): Record<string, any> {
    const key = `${bot_id}:${group_id}`
    const cached = this.groupCache.get(key)
    if (cached) return cached
    const config = this.getAllCfg('group')
    const merged = {
      ...config.default,
      ...config[`${bot_id}:default`],
      ...config[group_id],
      ...config[`${bot_id}:${group_id}`],
    }
    this.groupCache.set(key, merged)
    return merged
  }

  /** other 配置 */
  getOther(): Record<string, any> {
    return this.getAllCfg('other')
  }

  getdefSet(name: string) {
    return this.getYaml('default_config', name)
  }

  getConfig(name: string) {
    return this.getYaml('config', name)
  }

  /** default_config 与用户配置合并；结果缓存于消息分发热路径，配置变更时失效 */
  getAllCfg(name: string): Record<string, any> {
    const cached = this.mergedCache.get(name)
    if (cached) return cached
    const merged = {
      ...this.getdefSet(name),
      ...this.getConfig(name),
    }
    this.mergedCache.set(name, merged)
    return merged
  }

  /** 使某配置及其群配置缓存失效（含 getYaml 自己的解析缓存，否则写完配置再读还是旧值） */
  invalidate(name: string) {
    this.mergedCache.delete(name)
    this.groupCache.clear()
    delete this.config[`config.${name}`]
    delete this.config[`default_config.${name}`]
  }

  getYaml(type: string, name: string): any {
    const key = `${type}.${name}`
    if (key in this.config) return this.config[key]
    const base = type === 'config' ? this.userDir : `config/${type}/`
    const file = path.join(base, `${name}.yaml`)
    /** 用户配置缺失时从默认配置重建，运行期误删可自愈 */
    if (type === 'config' && !fs.existsSync(file)) {
      try {
        fs.mkdirSync(base, { recursive: true })
        const defFile = `config/default_config/${name}.yaml`
        if (fs.existsSync(defFile)) {
          fs.copyFileSync(defFile, file)
          safeLog(`[Config] 用户配置 ${file} 缺失，已从默认配置重建`)
        }
      } catch (err) {
        safeLog(`[Config] 重建 ${file} 失败：${err}`)
      }
    }
    try {
      this.config[key] = YAML.parse(fs.readFileSync(file, 'utf8'))
    } catch (err: any) {
      if (err?.code !== 'ENOENT') safeLog(`[Config] 读取配置文件 ${file} 错误：${err}`)
      return (this.config[key] = undefined)
    }
    this.watch(file, name, type)
    return this.config[key]
  }

  watch(file: string, name: string, type = 'default_config') {
    const key = `${type}.${name}`
    if (this.watcher[key]) return
    const watcher = chokidar.watch(file)
    let timer: NodeJS.Timeout | undefined
    watcher.on('change', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        delete this.config[key]
        this.invalidate(name)
        // package.json 相关内容可能随配置变化
        if (name === 'jiuli') this._package = undefined
        if (typeof (globalThis as any).Bot !== 'object') return
        logger.mark(logger.blue(`[${makeId('Config')}]`), `修改配置文件 [${type}] [${name}]`)
        const hook = `change_${name}`
        if (hook in this) (this as any)[hook]()
      }, 5000)
    })
    this.watcher[key] = watcher
  }

  async change_bot() {
    const { setLog } = await import('../log.js')
    setLog(this.getAllCfg('bot').log_level)
  }
}

const cfg = new Cfg() as Cfg & Record<string, any>
/** 日志对齐（log.ts）与配置模块自身都要读它，挂到全局可避免 log ←→ config 循环 import */
;(globalThis as any).cfg = cfg
export default cfg
