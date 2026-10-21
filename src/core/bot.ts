/**
 * Bot 单例
 * Bot 是 Proxy：属性回落链 Bot.x → util.x → bots[x] → Bot[随机uin].x，
 * 并带 uin / adapter 两个云崽约定的特化数组，内置 HTTP / WebSocket 与文件托管。
 */
import express from 'express'
import compression from 'compression'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { ulid } from 'ulid'
import cfg from './config/index.js'
import util from './util.js'
import { logger } from './log.js'
import { currentLoadingKey } from './loading.js'
import type { JiuLiEvent } from './types.js'

export default class JiuLiBot extends EventEmitter {
  stat = { start_time: Date.now() / 1000, online: 0 }
  bot = this
  bots: Record<string, any> = {}

  /** 机器人账号列表（特化数组） */
  uin: any = Object.assign([], {
    toJSON(this: any) {
      if (!this.now) {
        switch (this.length) {
          case 0:
            return ''
          case 1:
          case 2:
            return this[this.length - 1]
        }
        const array = this.slice(1)
        this.now = array[Math.floor(Math.random() * array.length)]
        // 60s 内复用同一个随机账号，避免连续操作跨号
        setTimeout(() => delete this.now, 60000)
      }
      return this.now
    },
    toString(this: any, raw?: boolean, ...args: any[]) {
      return raw === true ? Array.prototype.toString.apply(this, args as any) : String(this.toJSON())
    },
    includes(this: any, value: any) {
      return this.some((i: any) => i == value)
    },
  })

  /** 适配器列表（按 path 去重） */
  adapter: any = Object.defineProperty([], 'push', {
    configurable: true,
    writable: true,
    value(this: any[], ...items: any[]) {
      for (const item of items)
        if (!item?.path || !this.some((adapter: any) => adapter.path === item.path)) Array.prototype.push.call(this, item)
      return this.length
    },
  })

  express: any = Object.assign(express(), { skip_auth: [], quiet: [], public: [] })
    .disable('x-powered-by')
    .use(this.serverSecurity.bind(this))
    .use(this.serverAuth.bind(this))
    .use(compression())
    .use('/status', this.serverStatus.bind(this))
    .use(express.urlencoded({ extended: false }))
    .use(express.json())
    .use(express.raw())
    .use(express.text())
    .use(this.serverHandle.bind(this))
    .use('/exit', this.serverExit.bind(this))
    .use('/File', this.fileSend.bind(this))

  server = http
    .createServer(this.express)
    .on('error', (err: any) => {
      if (typeof (this as any)[`server${err.code}`] === 'function') return (this as any)[`server${err.code}`](err)
      util.makeLog('error', err, 'Server')
    })
    .on('upgrade', this.wsConnect.bind(this))

  httpsServer: any
  url = ''
  wss = new WebSocketServer({ noServer: true })
  wsf: Record<string, any[]> = Object.create(null)
  fs: Record<string, any> = Object.create(null)
  fileTimers = new Map<string, NodeJS.Timeout>()

  constructor() {
    super()
    /** 记录插件注册的 express 路由与 WS 路径，卸载/重载时清理（避免重复注册与端口/处理器冲突） */
    this.wrapExpress()
    /** 同理记录插件在加载期挂的事件监听：每热重载一次多留一份会让消息被处理 N 次 */
    this.wrapEventMethods()
    /** 属性回落解析缓存（函数绑定等） */
    const cache = new Map<string | symbol, any>()
    const resolve = (prop: string | symbol) => {
      const cached = cache.get(prop)
      if (cached !== undefined) return cached

      /**
       * 实例自身属性优先（原样返回，不 bind：express app / server 本身是函数对象，bind 会丢掉 .get/.use 等自有属性）。
       * 插件常用 `Bot.xxx = 自定义` 覆盖框架方法，先查原型的话覆盖会被原型方法挡住、等于没生效。
       */
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const own = (this as any)[prop]
        if (own !== undefined) return own
      }

      const proto = Object.getPrototypeOf(this)
      const desc = Object.getOwnPropertyDescriptor(proto, prop as string)
      if (desc?.get) return (this as any)[prop]
      if (desc?.value) {
        const value = desc.value
        if (typeof value === 'function') {
          const bound = value.bind(this)
          cache.set(prop, bound)
          return bound
        }
        return value
      }

      /** 继承自更上层原型的方法（如 EventEmitter 的 on / once）原样返回，调用时 this 仍是代理 */
      const inherited = (this as any)[prop]
      if (inherited !== undefined) return inherited

      const u = (util as any)[prop]
      if (u !== undefined) {
        if (typeof u === 'function') {
          const bound = u.bind(util)
          cache.set(prop, bound)
          return bound
        }
        return u
      }

      const target = this.bots[prop as string]
      if (target !== undefined) return target

      for (const i of [this.uin.toString(), ...this.uin]) {
        if (this.bots[i]?.[prop as string] !== undefined) {
          util.makeLog('trace', `因不存在 Bot.${String(prop)} 而重定向到 Bot.${i}.${String(prop)}`)
          const value = this.bots[i][prop as string]
          if (typeof value?.bind === 'function') return value.bind(this.bots[i])
          return value
        }
      }

      util.makeLog('trace', `不存在 Bot.${String(prop)}`)
      return undefined
    }

    return new Proxy(this.bots, {
      get: (_target, prop) => resolve(prop),
      set: (_target, prop, value) => {
        cache.delete(prop)
        const proto = Object.getPrototypeOf(this)
        const isInstanceProp =
          Object.prototype.hasOwnProperty.call(this, prop) ||
          Object.getOwnPropertyDescriptor(proto, prop) !== undefined ||
          (util as any)[prop] !== undefined
        if (isInstanceProp) (this as any)[prop] = value
        else (this.bots as any)[prop] = value
        return true
      },
      has: (_target, prop) => prop in this || prop in util || prop in this.bots,
      ownKeys: () => Reflect.ownKeys(this.bots),
      getOwnPropertyDescriptor: (_target, prop) => Reflect.getOwnPropertyDescriptor(this.bots, prop),
    }) as any
  }

  /* ==================== 插件注册资源（热重载清理） ==================== */

  private pluginLayers = new Map<string, Set<any>>()
  private pluginWs = new Map<string, Set<string>>()
  /** 插件在加载期挂的事件监听：key → [{ event, listener }] */
  private pluginListeners = new Map<string, Array<{ event: string | symbol; listener: (...args: any[]) => any }>>()
  /** run() 末尾注册的兜底重定向 / 错误处理层；插件热重载追加路由后要把它们挪回末尾 */
  private fallbackLayers: any[] = []

  /**
   * 当前正在加载的插件 key（由 loader 在 import 前后设置）。
   * 读的是 AsyncLocalStorage 里的上下文，不是全局变量 —— 插件并行导入时全局量会被
   * 别的插件改掉，导致路由被记到别人名下（见 lib/core/loading.ts 的说明）。
   */
  private get loadingKey(): string | undefined {
    return currentLoadingKey()
  }

  /** 包装 express 路由方法，记录每个插件注册的层；重载时先清理旧层，避免路由重复注册 */
  private wrapExpress() {
    const app = this.express
    for (const method of ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use', 'route']) {
      const orig = app[method].bind(app)
      app[method] = (...args: any[]) => {
        const key = this.loadingKey
        const router = app.router || app._router
        const before = router?.stack?.length ?? 0
        const ret = orig(...args)
        const after = router?.stack?.length ?? 0
        if (key && after > before) {
          let set = this.pluginLayers.get(key)
          if (!set) this.pluginLayers.set(key, (set = new Set()))
          /**
           * 兜底层不能记到插件名下：ensureFallbackLast() 会挪动栈，而 app.get 内部还会走一次
           * app.route（同样被包装），嵌套调用会让外层的 before/after 窗口把兜底层算进新增层，
           * 重载时被当成插件路由删掉，之后所有未匹配请求直接 404。
           */
          for (const layer of router.stack.slice(before, after))
            if (!this.fallbackLayers.includes(layer)) set.add(layer)
          /**
           * 热重载会重新 app.use()，新路由是 append 到 stack 末尾的，而兜底重定向 / 错误处理
           * 是启动完成时才注册的。不挪回去的话请求会先命中兜底 → 全部 302 空 Location
           * （表现就是面板打开一片 "Found. Redirecting to"）。
           */
          this.ensureFallbackLast()
        }
        return ret
      }
    }

    /** 代理 wsf（WebSocket 处理器表），记录插件占用过的路径 */
    const wsf = this.wsf
    this.wsf = new Proxy(wsf, {
      set: (target, prop: string, value) => {
        const key = this.loadingKey
        if (key && typeof prop === 'string') {
          let set = this.pluginWs.get(key)
          if (!set) this.pluginWs.set(key, (set = new Set()))
          set.add(prop)
        }
        target[prop] = value
        return true
      },
      deleteProperty: (target: any, prop: string | symbol) => {
        delete target[prop as any]
        return true
      },
      get: (target: any, prop: string | symbol) => target[prop as any],
      ownKeys: target => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target: any, prop: string | symbol) =>
        Reflect.getOwnPropertyDescriptor(target, prop),
    })
  }

  /**
   * 包装事件订阅方法，记录「哪个插件在加载期挂了哪些监听」，卸载 / 重载时移除。
   *
   * express 路由与 WS 路径一直是这么管的，事件监听漏了：插件在**模块顶层** `Bot.on(...)` 是
   * 生态插件很常见的写法（xiaofei 的 `guild.message`、yenai 的 `message.group` 点赞），
   * 而热重载会重新求值整张模块图 —— 旧那份监听留在 EventEmitter 上，每重载一次多一份，
   * 一条消息被处理 N 次（实测重载三次：监听数 2→5，一条消息命中 4 次）。
   *
   * 只记录**加载上下文里**的调用：插件在运行期（指令、定时任务里）动态挂的监听不算「插件资源」，
   * 不参与清理，免得把用户运行时才建的东西删掉。
   */
  private wrapEventMethods() {
    for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const) {
      const orig = (this as any)[method].bind(this)
      ;(this as any)[method] = (event: string | symbol, listener: any) => {
        const key = this.loadingKey
        if (key && typeof listener === 'function') {
          const list = this.pluginListeners.get(key)
          if (list) list.push({ event, listener })
          else this.pluginListeners.set(key, [{ event, listener }])
        }
        return orig(event, listener)
      }
    }
  }

  /**
   * 把兜底重定向 / 错误处理层挪到 express 栈末尾。
   *
   * express 先注册先匹配，兜底必须在最后。启动时它们确实最后注册，但热重载的插件会重新
   * app.use()，新 layer 追加到末尾就把兜底顶到了前面 —— 正常启动后一直好好的，一改插件
   * 文件（不重启）面板就变 302 空白页，根因就在这里。
   */
  private ensureFallbackLast() {
    const n = this.fallbackLayers.length
    if (!n) return
    const router = this.express?.router || this.express?._router
    const stack = router?.stack
    if (!stack) return
    /** 兜底层已经原样排在末尾就不用动 */
    if (this.fallbackLayers.every((layer, i) => stack[stack.length - n + i] === layer)) return
    /** 只剩部分兜底层说明栈被别处动过，贸然重排会把别的层挤掉，交给下次注册再修 */
    if (!this.fallbackLayers.every(layer => stack.includes(layer))) return
    const rest = stack.filter((layer: any) => !this.fallbackLayers.includes(layer))
    stack.length = 0
    stack.push(...rest, ...this.fallbackLayers)
  }

  /** 插件卸载/重载前清理它注册的路由与 WS 路径 */
  cleanupPluginResources(key: string) {
    const router = this.express?.router || this.express?._router
    let routes = 0
    const layers = this.pluginLayers.get(key)
    if (layers) {
      for (const layer of layers) {
        const index = router?.stack?.indexOf(layer) ?? -1
        if (index > -1) {
          router.stack.splice(index, 1)
          routes++
        }
      }
      this.pluginLayers.delete(key)
    }

    let ws = 0
    const paths = this.pluginWs.get(key)
    if (paths) {
      for (const p of paths)
        if (p in this.wsf) {
          delete (this.wsf as any)[p]
          ws++
        }
      this.pluginWs.delete(key)
    }

    /** 加载期挂的事件监听（节点式 `Bot.on(...)` 写法） */
    let listeners = 0
    const records = this.pluginListeners.get(key)
    if (records) {
      for (const { event, listener } of records) {
        try {
          this.off(event as any, listener as any)
          listeners++
        } catch {}
      }
      this.pluginListeners.delete(key)
    }

    if (routes || ws || listeners)
      util.makeLog(
        'debug',
        `已清理插件注册的 express 路由 ${routes} 条 · WS 路径 ${ws} 个 · 事件监听 ${listeners} 个 · ${key}`,
        'Plugin',
      )
    return { routes, ws, listeners }
  }

  /* ==================== HTTP 服务 ==================== */

  /** 鉴权失败计数（仅公网来源），用于阻断暴力尝试 */
  private authFails = new Map<string, { count: number; time: number }>()

  /** 未就绪时挂起的请求上限：超出直接 503，避免启动窗口被刷出无界监听、把 req/socket 全留下来 */
  private static MAX_ONLINE_WAITERS = 64
  private onlineWaiters = 0

  /** 日志里的 URL 上限：请求行最长可达 16KB，原样落盘会让单条日志放大几个数量级 */
  private static MAX_LOG_URL = 200

  /** 入站连接上限：留出 FD 给 QQ 适配器与日志文件，公网刷连接时先把框架核心保住 */
  private static MAX_CONNECTIONS = 512
  private urlForLog(url: any) {
    const str = String(url || '/')
    return str.length > JiuLiBot.MAX_LOG_URL ? `${str.slice(0, JiuLiBot.MAX_LOG_URL)}…(${str.length}B)` : str
  }

  /** 回环地址（含 IPv4 映射形态） */
  isLoopback(addr: any) {
    return /^(::1|::ffff:127\.|127\.)/i.test(String(addr || ''))
  }

  /**
   * 是否本机直连。
   * 反向代理会把公网请求变成 127.0.0.1，所以带转发头的回环请求按外部处理，
   * 否则在 nginx 后面挂一层就等于没鉴权。转发头被伪造只会让自己被拒，不会放行。
   */
  private isLocalRequest(req: any) {
    if (!this.isLoopback(req.socket?.remoteAddress)) return false
    const h = req.headers || {}
    return !h['x-forwarded-for'] && !h['x-real-ip'] && !h['forwarded'] && !h['cf-connecting-ip']
  }

  /**
   * 服务还没就绪（插件尚未加载完）时挂起请求。
   * 以前用 `once('online', ...)` 无上限地存，公网可以在启动窗口刷几万个请求，
   * 每个监听都攥着 req / socket，等于一条无鉴权的内存放大通道。
   */
  private whenOnline(req: any, resume: () => void) {
    if (this.onlineWaiters >= JiuLiBot.MAX_ONLINE_WAITERS) return this.rejectBusy(req)
    this.onlineWaiters++
    let done = false
    let timer: NodeJS.Timeout
    const finish = (ready: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      this.off('online', onOnline)
      this.onlineWaiters--
      if (ready) resume()
      else this.rejectBusy(req)
    }
    const onOnline = () => finish(true)
    timer = setTimeout(() => finish(false), 15000)
    timer.unref?.()
    this.once('online', onOnline)
  }

  /** 未就绪或排队过多：HTTP 回 503，WebSocket 握手写 503 后断开 */
  private rejectBusy(req: any) {
    if (req.res?.sendStatus) {
      try {
        req.res.sendStatus(503)
      } catch {}
      return false
    }
    const socket = req.socket
    if (socket && !socket.destroyed) {
      try {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      } catch {}
      socket.destroy()
    }
    return false
  }

  /** 常数时间比较：先摘要再比较，长度不同也不提前返回 */
  private safeEqual(a: any, b: any) {
    const ha = crypto.createHash('sha256').update(String(a)).digest()
    const hb = crypto.createHash('sha256').update(String(b)).digest()
    return crypto.timingSafeEqual(ha, hb)
  }

  /**
   * 校验 server.auth。携带方式：同名请求头、`Authorization: Bearer <token>`、query 参数，
   * 任一配置项命中即放行（沿用旧语义）。
   */
  private checkAuth(req: any, auth: Record<string, any>) {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''))?.[1]?.trim()
    for (const key in auth) {
      if (!auth[key]) continue
      const want = String(auth[key])
      const name = key.toLowerCase()
      const values: string[] = []
      const header = req.headers?.[name]
      for (const v of Array.isArray(header) ? header : header === undefined ? [] : [header])
        if (typeof v === 'string') values.push(v)
      if (bearer && ['authorization', 'access_token', 'token'].includes(name)) values.push(bearer)
      const q = req.query?.[key]
      for (const v of Array.isArray(q) ? q : q === undefined ? [] : [q]) if (typeof v === 'string') values.push(v)
      if (values.some(v => this.safeEqual(v, want))) return true
    }
    return false
  }

  /**
   * server.public：不需要 token 的路径前缀。
   * 面板自带登录（会话 / JWT），`/File` 是带 ULID 的一次性文件地址（要发给 QQ 客户端取图），
   * 这两类没有 token 也必须能访问。其余路径一律走鉴权。
   */
  private isPublicPath(pathname: string) {
    const list = cfg.server.public
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'string') continue
      const base = item === '/' ? '/' : item.replace(/\/+$/, '')
      if (base === '/' || pathname === base || pathname.startsWith(`${base}/`)) return true
    }
    return false
  }

  /** 公网鉴权失败限流：同一 IP 10 分钟内失败超过 20 次直接 429 */
  private hitAuthFail(ip: string) {
    const now = Date.now()
    const item = this.authFails.get(ip)
    if (!item || now - item.time > 10 * 60 * 1000) {
      if (this.authFails.size > 5000) this.authFails.clear()
      this.authFails.set(ip, { count: 1, time: now })
      return 1
    }
    item.count++
    return item.count
  }

  /** 拒绝请求：express 请求回状态码，WebSocket 握手由 wsConnect 自己写 401 */
  private denyAuth(req: any, reason: string) {
    /** upgrade 请求没走过 serverAuth 的 rid/sid 赋值，这里补齐再写日志 */
    const socket = req.socket || {}
    req.rid ??= `${req.socket?.remoteAddress || ''}:${socket.remotePort}${req.headers?.['sec-websocket-key'] ? `-${req.headers['sec-websocket-key']}` : ''}`
    req.sid ??= `${req.method || 'UPGRADE'} ${this.urlForLog(req.url || req.originalUrl)}`
    const local = this.isLocalRequest(req)
    const fails = local ? 0 : this.hitAuthFail(String(req.socket?.remoteAddress || req.ip || ''))
    if (req.res?.sendStatus) req.res.sendStatus(fails > 20 ? 429 : 401)
    /** 前几次留完整现场，之后降到 debug：公网扫描量大会把日志刷爆 */
    /** 只留排障需要的头：Cookie / Authorization 不该进日志，头的总大小也能到 16KB */
    const headers = {
      host: req.headers?.host,
      ua: String(req.headers?.['user-agent'] || '').slice(0, 120),
      type: req.headers?.['content-type'],
      length: req.headers?.['content-length'],
    }
    util.makeLog(
      fails <= 3 ? 'error' : 'debug',
      ['HTTP', req.method, '请求', this.urlForLog(req.originalUrl), '拒绝', reason, { headers }],
      `${req.sid} <≠ ${req.rid}`,
      true,
    )
    return false
  }

  /** 基础安全响应头：面板都是同源 iframe，SAMEORIGIN 足够 */
  serverSecurity(req: any, res: any, next: any) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    next()
  }

  serverAuth(req: any): any {
    if (this.stat.online !== 2) return this.whenOnline(req, () => this.serverAuth(req))

    req.rid ??= `${req.ip}:${req.socket?.remotePort}`
    req.sid ??= `${req.protocol}://${req.hostname}:${req.socket?.localPort}${this.urlForLog(req.originalUrl)}`
    /** upgrade 请求没有 req.path / originalUrl，只能从 req.url 取 */
    const fullUrl = String(req.originalUrl || req.url || '/')
    const pathname = fullUrl.split('?')[0]
    /** 根路径只是跳转（面板入口 / 配置的 redirect），不放任何数据 */
    if (pathname === '/' || this.isPublicPath(pathname)) return req.next?.()

    for (const i of req.app?.skip_auth || []) if (fullUrl.startsWith(i)) return req.next?.()

    const auth = cfg.server.auth
    if (auth && typeof auth === 'object' && Object.keys(auth).length) {
      if (this.checkAuth(req, auth)) return req.next?.()
      return this.denyAuth(req, '鉴权失败')
    }

    /**
     * 没配 auth 时默认只信本机。以前这里直接 next()：/status 会吐出完整 process.report，
     * /OneBotv11 允许外部伪造任意事件（含主人身份），公网裸奔等于把机器交出去。
     * 确实要公网免鉴权访问全部接口，把 server.yaml 的 allow_remote 置 true。
     */
    if (this.isLocalRequest(req)) return req.next?.()
    if (cfg.server.allow_remote === true) {
      util.makeLog(
        'warn',
        ['HTTP', req.method, '请求', this.urlForLog(req.originalUrl), '在 allow_remote 下免鉴权放行'],
        `${req.sid} <= ${req.rid}`,
        true,
      )
      return req.next?.()
    }
    return this.denyAuth(req, '未配置 server.auth，公网访问已拒绝')
  }

  serverStatus(req: any) {
    const report: any = process.report.getReport()
    /** 环境变量常带 token / 密钥，进程报告本身也不需要交给调用方 */
    delete report.environmentVariables

    req.res.type('json')
    req.res.send(
      JSON.stringify(report).replace(
        /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g,
        '[IPv4]',
      ),
    )
  }

  serverHandle(req: any) {
    let quiet = false
    for (const i of req.app.quiet)
      if (req.originalUrl.startsWith(i)) {
        quiet = true
        break
      }

    /**
     * 只记录「大小 + 键名」，不记录 body / query 原文：
     * 一是登录、Webhook 这类请求体里有密码和令牌，二是恶意请求体可以把日志放大数倍
     * （16KB 的请求体经序列化/着色后能占几十 KB，配合无界日志缓存可直接打爆内存）。
     */
    const url = String(req.originalUrl || req.url || '/')
    const qIndex = url.indexOf('?')
    const msg: any = { path: this.urlForLog(qIndex === -1 ? url : url.slice(0, qIndex)) }
    if (qIndex !== -1) msg.query = `${url.length - qIndex - 1}B`
    if (req.headers?.['content-type']) msg.type = String(req.headers['content-type']).slice(0, 64)
    const body = req.body
    if (body != null && (typeof body !== 'object' || Object.keys(body).length)) {
      let size = Number(req.headers?.['content-length'])
      if (!Number.isFinite(size)) size = -1
      let keys: string[] | undefined
      if (typeof body === 'string') size = body.length
      else if (Buffer.isBuffer(body)) size = body.length
      else keys = Object.keys(body)
      msg.body = keys?.length ? `${size}B ${keys.slice(0, 12).join(',')}${keys.length > 12 ? '…' : ''}` : `${size}B`
    }
    util.makeLog(quiet ? 'debug' : 'mark', ['HTTP', req.method, '请求', msg], `${req.sid} <= ${req.rid}`, true)
    req.next()
  }

  async serverExit(req: any) {
    /**
     * 只接受本机来源。这里刻意不含 `127.0.0.1`：auth 默认是空的，
     * 若前面挂了一层 `proxy_pass http://127.0.0.1:<port>` 的反代，外部请求的 req.ip 就是 127.0.0.1，
     * 加进来等于把「任何人都能远程让机器人退出」打开。要 IPv4 回环发停止请求请先配 server.auth。
     */
    if (!['::1', '::ffff:127.0.0.1'].includes(String(req.ip))) return
    this.exit(1)
  }

  wsConnect(req: any, socket: any, head: any): any {
    if (this.stat.online !== 2) return this.whenOnline(req, () => this.wsConnect(req, socket, head))

    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers['sec-websocket-key']}`
    const host = req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`
    let wsUrl: URL
    try {
      /** base 只用字面量：这里只需要 pathname / query，IPv6 形态的 host 不能直接拼进 base */
      wsUrl = new URL(req.url || '/', 'http://localhost')
    } catch {
      /** upgrade 请求的 URL 解析不了时直接 400，别带着 undefined 往下走 */
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      return socket.destroy()
    }
    req.sid = `ws://${host}${this.urlForLog(req.url)}`
    req.query = Object.fromEntries(wsUrl.searchParams.entries())
    if (this.serverAuth(req) === false) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }

    /** 与 HTTP 访问日志同口径：只留 query 的键和大小，不把值原样落盘 */
    const msg: any = {}
    if (Object.keys(req.query).length) {
      const keys = Object.keys(req.query)
      msg.query = `${wsUrl.search.length}B ${keys.slice(0, 12).join(',')}${keys.length > 12 ? '…' : ''}`
    }

    /** 用 pathname 选处理器：带 query 或多余斜杠时 req.url 切分不可靠 */
    const path = wsUrl.pathname.split('/').filter(Boolean)[0]
    if (!path || !(path in this.wsf)) {
      util.makeLog('error', ['WebSocket 处理器', path, '不存在', msg], `${req.sid} <≠> ${req.rid}`, true)
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      return socket.destroy()
    }

    this.wss.handleUpgrade(req, socket, head, conn => {
      util.makeLog('mark', ['建立连接', msg], `${req.sid} <=> ${req.rid}`, true)
      conn.on('error', (...args: any[]) => util.makeLog('error', args, `${req.sid} <=> ${req.rid}`, true))
      conn.on('close', () => {
        util.makeLog('mark', '断开连接', `${req.sid} <≠> ${req.rid}`, true)
        this.cleanupBotConnection(conn)
      })
      conn.on('message', (m: any) => util.makeLog('debug', ['消息', util.String(m)], `${req.sid} <= ${req.rid}`, true))
      ;(conn as any).sendMsg = (m: any) => {
        if (!Buffer.isBuffer(m)) m = util.String(m)
        util.makeLog('debug', ['消息', m], `${req.sid} => ${req.rid}`, true)
        return conn.send(m)
      }
      for (const i of this.wsf[path]) i(conn, req, socket, head)
    })
  }

  async serverEADDRINUSE(err: any, https?: boolean) {
    const port = https ? cfg.server.https.port : cfg.server.port
    util.makeLog('error', ['监听端口', port, '错误', err], 'Server')
    if (https) return
    util.makeLog(
      'error',
      `端口 ${port} 已被占用。请先停掉占用的实例（同一个目录重复启动最常见），或改 config/config/server.yaml → server.port 后重启；守护进程会自动重试几次，仍起不来就停下`,
      'Server',
    )
    /**
     * 端口冲突只结束自己：过去会给占用方发 /exit，对端在 pm2 模式下会连带 pm2 delete，生产条目被抹掉。
     * 也不能走 this.exit(1)：那在 pm2 模式下执行 `pnpm stop`，会把「端口暂时被占」这种瞬时故障
     * 变成持久化的 `pm2 delete` + `save`，条目跨重启都回不来。
     * 以 RESTART_CODE 退出：内部守护进程会重拉（重启/更新窗口内的瞬时冲突能自愈），
     * 其余守护方式按各自的重启策略处理，且都会在多次失败后停下（见 start.ts 的重拉上限）。
     */
    const { RESTART_CODE } = await import('./start.js')
    /** 同步补齐日志：process.exit 不等异步写，不补就会丢掉刚打的死因 */
    const { flushLog } = await import('./log.js')
    flushLog()
    process.exit(RESTART_CODE)
  }

  serverError(err: any, req: any, res: any, _next?: any) {
    util.makeLog('error', ['HTTP', req.method, '请求错误', err], `${req.sid} <≠ ${req.rid}`, true)
    return res.end()
  }

  async serverLoad(https?: boolean) {
    const server = https ? 'httpsServer' : 'server'
    ;(this as any)[server].maxConnections = JiuLiBot.MAX_CONNECTIONS
    ;(this as any)[server].listen(https ? cfg.server.https.port : cfg.server.port)
    try {
      await util.promiseEvent((this as any)[server], 'listening', https ? 'error' : undefined)
    } catch {
      return
    }
    const { address, port } = (this as any)[server].address()
    util.makeLog('mark', [`启动 HTTP${https ? 'S' : ''} 服务器`, logger.green(`http${https ? 's' : ''}://[${address}]:${port}`)], 'Server')
    this.url = (https && cfg.server.https.url) || cfg.server.url
    for (const name of [404, 'timeout'])
      this.fileToUrl(`resources/http/File/${name}.jpg`, { name, time: false, times: false })
  }

  async httpsLoad() {
    try {
      this.httpsServer = (await import('node:https'))
        .createServer(
          {
            key: await fs.readFile(cfg.server.https.key),
            cert: await fs.readFile(cfg.server.https.cert),
          },
          this.express,
        )
        .on('error', (err: any) => {
          if (typeof (this as any)[`server${err.code}`] === 'function')
            return (this as any)[`server${err.code}`](err, true)
          util.makeLog('error', err, 'Server')
        })
        .on('upgrade', this.wsConnect.bind(this))
      return this.serverLoad(true)
    } catch (err) {
      util.makeLog('error', ['创建 HTTPS 服务器错误', err], 'Server')
    }
  }

  /* ==================== 启动 ==================== */

  async run() {
    if (this.stat.online !== 0) return
    this.stat.online = 1

    const { default: PluginsLoader } = await import('./loader.js')
    const { loadEvents } = await import('./events.js')
    const { initRedisOrFallback, ensureDirs } = await import('./start.js')

    await ensureDirs()
    await initRedisOrFallback()
    await this.serverLoad()
    if (cfg.server.https?.key && cfg.server.https?.cert) await this.httpsLoad()
    /** 加载渲染后端，浏览器仍在首次截图时懒启动 */
    const { default: renderService } = await import('./render/index.js')
    await renderService.load()
    /** 预热框架模块，使"插件加载耗时"只反映插件自身成本 */
    await import('./index.js')
    await import('../index.js')
    await PluginsLoader.load()
    await loadEvents()

    this.stat.online = 2
    const fallbackRouter = this.express.router || this.express._router
    const fallbackBefore = fallbackRouter?.stack?.length ?? 0
    this.express.use((req: any) => req.res.redirect(cfg.server.redirect)).use(this.serverError.bind(this))
    /** 记下这两层，插件热重载后由 ensureFallbackLast 挪回末尾 */
    this.fallbackLayers = fallbackRouter?.stack?.slice(fallbackBefore) ?? []
    util.makeLog(
      'info',
      `连接地址：${logger.blue(`${this.url.replace(/^http/, 'ws')}/`)}${logger.cyan(`[${Object.keys(this.wsf)}]`)}`,
      'WebSocket',
    )
    const adapterNames = this.adapter.map((a: any) => `${a.name}(${a.id})`).join(' · ')
    util.makeLog(
      'mark',
      `JiuLi 就绪 · 用时 ${util.getTimeDiff(this.stat.start_time * 1000)} · 适配器 ${this.adapter.length} 个${
        adapterNames ? `（${adapterNames}）` : ''
      } · 在线账号 ${[...this.uin].length} 个`,
      'Online',
    )
    this.emit('online', this)
  }

  /* ==================== 文件托管 ==================== */

  async fileToUrl(file: any, opts: any = {}) {
    const { name, time = cfg.bot.file_to_url_time * 60000, times = cfg.bot.file_to_url_times } = opts

    file =
      (typeof file === 'object' && !Buffer.isBuffer(file) && { ...file }) ||
      (await util.fileType({ file, name }, { http: true }))
    if (!Buffer.isBuffer(file.buffer)) return file.buffer
    file.name = file.name ? encodeURIComponent(file.name) : ulid()

    if (typeof times === 'number') file.times = times
    /** 只编码一次：URL 与 this.fs 的 key 都存这一份，客户端按 URL 原样请求即命中 */
    this.fs[file.name] = file
    this.setFileTimeout(file.name, file, time)

    const url = new URL(`File/${file.name}`, this.url)
    /**
     * /File 默认在 server.public 里，地址不需要带 token。
     * 只有用户把 /File 从 public 移除时才补参数，避免把 access_token 随图片 URL 发给协议端。
     */
    if (!this.isPublicPath('/File')) for (const i in cfg.server.auth) url.searchParams.set(i, cfg.server.auth[i])
    return url
  }

  setFileTimeout(name: string, file: any, time?: number) {
    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    this.fileTimers.delete(name)
    if (!time) return

    const timer = setTimeout(() => {
      if (this.fileTimers.get(name) !== timer || this.fs[name] !== file) return
      this.fileTimers.delete(name)
      this.expireFile(name, file)
    }, time)
    this.fileTimers.set(name, timer)
  }

  expireFile(name: string, file: any) {
    if (this.fs[name] !== file) return
    this.fs[name] = (this.fs as any).timeout

    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      if (this.fs[name] === (this.fs as any).timeout) delete this.fs[name]
      if (this.fileTimers.get(name) === timer) this.fileTimers.delete(name)
    }, 60000)
    this.fileTimers.set(name, timer)
  }

  cleanupBotConnection(ws: any) {
    for (const [self_id, bot] of Object.entries(this.bots)) {
      if ((bot as any).ws !== ws) continue
      delete this.bots[self_id]
      for (let i = this.uin.length - 1; i >= 0; i--) if (this.uin[i] == self_id) this.uin.splice(i, 1)
      if (this.uin.now == self_id) delete this.uin.now
    }
  }

  fileSend(req: any) {
    const url = req.path.replace(/^\//, '')
    let file = this.fs[url] || this.fs[404]

    if (typeof file?.times === 'number') {
      if (file.times > 0) {
        file.times--
        if (file.times <= 0) this.expireFile(url, file)
      } else {
        this.expireFile(url, file)
        file = (this.fs as any).timeout
      }
    }

    if (file?.type?.mime) req.res.setHeader('Content-Type', file.type.mime)
    util.makeLog(
      'mark',
      `发送文件：${file?.name}(${file?.url} ${(file?.buffer?.length / 1024).toFixed(2)}KB)`,
      `${req.sid} => ${req.rid}`,
      true,
    )
    req.res.send(file?.buffer)
  }

  /* ==================== 事件分发 ==================== */

  prepareEvent(data: JiuLiEvent) {
    if (!this.bots[data.self_id as string]) return
    if (!data.bot)
      Object.defineProperty(data, 'bot', {
        value: this.bots[data.self_id as string],
      })

    if (data.user_id) {
      if (!data.friend)
        Object.defineProperty(data, 'friend', {
          value: data.bot.pickFriend(data.user_id),
        })
      data.sender ||= { user_id: data.user_id }
      data.sender.nickname ||= data.friend?.name || data.friend?.nickname
    }

    if (data.group_id) {
      if (!data.group)
        Object.defineProperty(data, 'group', {
          value: data.bot.pickGroup(data.group_id),
        })
      data.group_name ||= data.group?.name || data.group?.group_name
    }

    if (data.group && data.user_id) {
      if (!data.member)
        Object.defineProperty(data, 'member', {
          value: data.group.pickMember(data.user_id),
        })
      data.sender!.nickname ||= data.member?.name || data.member?.nickname
      data.sender!.card ||= data.member?.card
    }

    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name

    const segment = (globalThis as any).segment
    for (const i of [data.friend, data.group, data.member]) {
      if (typeof i !== 'object' || !i) continue
      i.sendFile ??= (file: any, name?: string) => i.sendMsg(segment.file(file, name))
      i.makeForwardMsg ??= this.makeForwardMsg
      i.sendForwardMsg ??= (msg: any) => this.sendForwardMsg((m: any) => i.sendMsg(m), msg)
      i.getInfo ??= () => i.info || i
    }

    if (!data.reply) {
      if (data.group?.sendMsg) data.reply = data.group.sendMsg.bind(data.group)
      else if (data.friend?.sendMsg) data.reply = data.friend.sendMsg.bind(data.friend)
    }
  }

  /** 逐级 emit：message.group.normal → message.group → message */
  em(name = '', data: JiuLiEvent = {} as JiuLiEvent) {
    this.prepareEvent(data)
    while (true) {
      this.emit(name, data)
      const i = name.lastIndexOf('.')
      if (i === -1) break
      name = name.slice(0, i)
    }
  }

  /* ==================== 账号/好友/群 ==================== */

  getFriendArray() {
    const array: any[] = []
    for (const bot_id of this.uin) for (const [id, i] of (this.bots[bot_id].fl as Map<any, any>) || []) array.push({ ...i, bot_id })
    return array
  }

  getFriendList() {
    const array: any[] = []
    for (const bot_id of this.uin) array.push(...(((this.bots[bot_id].fl as Map<any, any>)?.keys() as any) || []))
    return array
  }

  getFriendMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].fl as Map<any, any>) || []) map.set(id, { ...(i as any), bot_id })
    return map
  }
  get fl() {
    return this.getFriendMap()
  }

  getGroupArray() {
    const array: any[] = []
    for (const bot_id of this.uin) for (const [id, i] of (this.bots[bot_id].gl as Map<any, any>) || []) array.push({ ...(i as any), bot_id })
    return array
  }

  getGroupList() {
    const array: any[] = []
    for (const bot_id of this.uin) array.push(...(((this.bots[bot_id].gl as Map<any, any>)?.keys() as any) || []))
    return array
  }

  getGroupMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].gl as Map<any, any>) || []) map.set(id, { ...(i as any), bot_id })
    return map
  }
  get gl() {
    return this.getGroupMap()
  }
  get gml() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].gml as Map<any, any>) || [])
        map.set(id, Object.assign(new Map(i), { bot_id }))
    return map
  }

  pickFriend(user_id: any, strict?: boolean) {
    user_id = Number(user_id) || user_id
    if (this.bots[this.uin]?.fl.has(user_id)) return this.bots[this.uin].pickFriend(user_id)

    let user: any
    for (const bot_id of this.uin)
      for (const [id, info] of (this.bots[bot_id]?.fl as Map<any, any>) || [])
        if (id === user_id) user = { ...(info as any), bot_id }

    if (!user) {
      const memberMaps = new Map()
      for (const bot_id of this.uin)
        for (const [group_id, members] of (this.bots[bot_id]?.gml as Map<any, any>) || [])
          memberMaps.set(group_id, { bot_id, members })

      for (const { bot_id, members } of memberMaps.values()) {
        user = (members as Map<any, any>).get(user_id)
        if (user) {
          user.bot_id = bot_id
          break
        }
      }
    }

    if (user) return this.bots[user.bot_id].pickFriend(user_id)
    if (strict) return false
    util.makeLog('debug', ['因不存在用户', user_id, '而随机选择Bot', this.uin.toJSON()])
    return this.bots[this.uin].pickFriend(user_id)
  }
  get pickUser() {
    return this.pickFriend
  }

  pickGroup(group_id: any, strict?: boolean) {
    group_id = Number(group_id) || group_id
    if (this.bots[this.uin]?.gl.has(group_id)) return this.bots[this.uin].pickGroup(group_id)

    let group: any
    for (const bot_id of this.uin)
      for (const [id, info] of (this.bots[bot_id]?.gl as Map<any, any>) || [])
        if (id === group_id) group = { ...(info as any), bot_id }

    if (group) return this.bots[group.bot_id].pickGroup(group_id)
    if (strict) return false
    util.makeLog('debug', ['因不存在群', group_id, '而随机选择Bot', this.uin.toJSON()])
    return this.bots[this.uin].pickGroup(group_id)
  }

  pickMember(group_id: any, user_id: any) {
    return this.pickGroup(group_id).pickMember(user_id)
  }

  sendFriendMsg(bot_id: any, user_id: any, ...args: any[]) {
    try {
      if (!bot_id) return this.pickFriend(user_id).sendMsg(...args)
      if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickFriend(user_id).sendMsg(...args)
      if (!args.length && this.pickFriend(bot_id, true)) return this.pickFriend(bot_id).sendMsg(user_id)

      const { promise, resolve, reject } = Promise.withResolvers<any>()
      const listener = (data: any) => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待 Bot 上线超时'), { bot_id, user_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog('error', ['发送好友消息错误', args, err], `${bot_id} => ${user_id}`, true)
    }
  }

  sendGroupMsg(bot_id: any, group_id: any, ...args: any[]) {
    try {
      if (!bot_id) return this.pickGroup(group_id).sendMsg(...args)
      if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickGroup(group_id).sendMsg(...args)
      if (!args.length && this.pickGroup(bot_id, true)) return this.pickGroup(bot_id).sendMsg(group_id)

      const { promise, resolve, reject } = Promise.withResolvers<any>()
      const listener = (data: any) => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待 Bot 上线超时'), { bot_id, group_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog('error', ['发送群消息错误', args, err], `${bot_id} => ${group_id}`, true)
    }
  }

  /** 等待下一条符合条件的文本消息 */
  getTextMsg(fnc: any = () => true) {
    if (typeof fnc !== 'function') {
      const { self_id, user_id } = fnc
      fnc = (data: any) => data.self_id == self_id && data.user_id == user_id
    }

    const { promise, resolve } = Promise.withResolvers<string>()
    const listener = (data: any) => {
      try {
        if (!fnc(data)) return
        let msg = ''
        for (const i of data.message) if (i.type === 'text' && i.text) msg += i.text.trim()
        if (!msg) return
        resolve(msg)
        this.off('message', listener)
      } catch (err) {
        util.makeLog('error', err, data.self_id)
      }
    }
    this.on('message', listener)
    return promise
  }

  /** 等待主人消息 */
  getMasterMsg() {
    return this.getTextMsg((data: any) => cfg.master[data.self_id]?.includes(String(data.user_id)))
  }

  /** 给全部主人发送消息 */
  async sendMasterMsg(msg: any, bot_array?: any, sleep = 5000) {
    const ret: any = {}
    await Promise.allSettled(
      (Array.isArray(bot_array) ? bot_array : bot_array ? [bot_array] : Object.keys(cfg.master)).map(async (bot_id: string) => {
        ret[bot_id] = {}
        for (const user_id of cfg.master[bot_id] || []) {
          ret[bot_id][user_id] = this.sendFriendMsg(bot_id, user_id, msg)
          if (sleep) await util.sleep(sleep, ret[bot_id][user_id])
        }
      }),
    )
    return ret
  }

  makeForwardMsg(msg: any) {
    return { type: 'node', data: msg }
  }

  makeForwardArray(msg: any = [], node: any = {}) {
    const forward = []
    for (const message of Array.isArray(msg) ? msg : [msg]) forward.push({ ...node, message })
    return this.makeForwardMsg(forward)
  }

  async sendForwardMsg(send: any, msg: any) {
    const messages = []
    for (const { message } of Array.isArray(msg) ? msg : [msg]) messages.push(await send(message))
    return messages
  }

  /* ==================== 退出/重启 ==================== */

  async redisExit() {
    const redis = (globalThis as any).redis
    if (!(typeof redis === 'object' && redis.process)) return false
    const p = redis.process
    delete redis.process
    await util.sleep(
      5000,
      redis.save?.().catch(() => {}),
    )
    return p.kill()
  }

  async exit(code = 0) {
    await this.redisExit()
    if ((globalThis as any).start_type === 'pm2') return util.exec('pnpm stop')
    process.exit(code)
  }

  async restart() {
    const { default: loader } = await import('./loader.js')
    const { RESTART_CODE } = await import('./start.js')
    /** 先把计数写回，避免重启丢统计 */
    await loader.flushCount().catch(() => {})
    await this.redisExit()

    util.makeLog('mark', '正在重启…', 'Restart')
    try {
      this.server.close()
    } catch {}
    try {
      this.httpsServer?.close()
    } catch {}
    /**
     * 先关 Chromium 再退出：浏览器是独立进程，父进程一 exit 它就成了孤儿常驻
     * （`--user-data-dir` 落在 temp/puppeteer 下，实测能挂好几天，每次重启攒一个）。
     * 限时 1.5 秒，关闭失败或卡住都不能拖住重启。
     */
    try {
      const { default: renderService } = await import('./render/index.js')
      await Promise.race([renderService.stop().catch(() => {}), util.sleep(1500)])
    } catch {}

    /** pm2 模式交给 pm2；其余模式以 255 退出，由守护进程/外部管理器在同一终端拉起 */
    if ((globalThis as any).start_type === 'pm2') {
      await util.exec('pnpm run restart')
      process.exit()
    }
    process.exit(RESTART_CODE)
  }
}
