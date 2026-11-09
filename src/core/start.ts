/**
 * 启动流程
 */
import fs from 'node:fs'
import cfg from './config/index.js'
import { flushLog, logger, setLog, setLogDir } from './log.js'
import { consumeReloadFailure, failReload, noteCrash } from './reload-hooks.js'
import util from './util.js'
import { redisInit } from './redis.js'
import { injectGlobals } from './globals.js'

/** Promise.withResolvers polyfill（Node < 22） */
if (!(Promise as any).withResolvers) {
  const { deprecate } = await import('node:util')
  ;(Promise as any).withResolvers = deprecate(() => {
    const r: any = {}
    r.promise = new Promise((resolve, reject) => {
      r.resolve = resolve
      r.reject = reject
    })
    return r
  }, '请更新 Node.js')
}

export const DIRS = ['temp', 'temp/html', 'data', 'data/db', 'logs', 'resources']

export async function ensureDirs() {
  for (const dir of DIRS)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      util.makeLog('warn', `创建目录 ${dir} 失败：${err}`, 'Start')
    }
}

export async function initRedisOrFallback() {
  return redisInit()
}

export async function start() {
  const g = globalThis as any
  g.start_type ||= 'internal'

  // 默认只保留 10 帧调用栈，定位不到插件报错位置
  Error.stackTraceLimit = 50
  process.env.TZ ??= 'Asia/Shanghai'
  let realVersion = '0.0.0'
  try {
    realVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {}
  const compat = cfg.getCompat()
  const frameworkName = cfg.frameworkName
  process.title = `JiuLi v${realVersion}`
  if (frameworkName && frameworkName !== 'jiuli' && frameworkName !== 'JiuLi')
    process.title += ` (对外标识 ${frameworkName})`

  for (const i of ['SIGHUP', 'SIGTERM'] as const)
    process.on(i, (_signal: string, code: number) => process.exit(code))

  setLogDir('logs')
  await ensureDirs()
  setLog()

  const { default: JiuLiBot } = await import('./bot.js')
  const bot = new JiuLiBot() as any
  await injectGlobals(bot)

  bot.makeLog('mark', '──────── 启动中 ────────', 'JiuLi')
  bot.makeLog(
    'mark',
    `v${realVersion} · 插件可见的框架标识 ${logger.cyan(`${frameworkName} v${cfg.frameworkVersion}`)}（config/config/jiuli.yaml → compat）`,
    'JiuLi',
  )

  // id 用短名，避免被日志对齐截断
  const fatalEvents: Array<[string, string]> = [
    ['uncaughtException', 'Crash'],
    ['unhandledRejection', 'Reject'],
  ]
  for (const [event, id] of fatalEvents)
    process.on(event, (e: any) => {
      try {
        /** 未捕获错误同样只给一行原因；堆栈里有插件代码就指出来，完整堆栈留给 debug */
        const frame = util.errorFrame(e)
        const msg = `${String(e?.message || e)}${frame ? `
        疑似来自 ${frame}` : ''}`
        bot.makeLog('error', msg, id)
        bot.makeLog('debug', [event, e], id)
      } catch (err) {
        console.error(event, e, err)
        process.exit()
      }
      /**
       * 热重载里模块求值失败可能被插件自己吞成「部分 apps 载入失败」，
       * 框架只看到日志、插件却半残。这类失败在这里兜一次自动重启（带节流）。
       * 必须先 failReload 把错误交给判定：浮动 rejection 不会经过 changePlugin，
       * 不给它判一次，consumeReloadFailure 永远是 false，这条分支就形同虚设。
       */
      failReload(e)
      recoverFromReloadError(bot, e)
    })

  let stack: string | undefined
  const exit = process.exit.bind(process)
  process.exit = ((code?: number) => {
    stack = Error().stack
    return exit(code as any)
  }) as any
  process.on('exit', code => {
    try {
      bot.makeLog('mark', logger.magenta(`JiuLi 已停止运行，本次运行时长：${bot.getTimeDiff()} (${code})`), 'exit')
      bot.makeLog('trace', stack || Error().stack, 'exit')
    } catch {}
    /** 放在最后：上面两行也要落盘。process.exit 不等异步写，不补就会丢最后几行 */
    flushLog()
  })

  await bot.run()
  /** 外部命令（ffmpeg 等）自检，缺失时自动补装；不阻塞启动 */
  const { ensureDeps } = await import('./deps.js')
  ensureDeps().catch((err: any) => util.makeLog('error', ['系统命令自检失败', err], 'Deps'))
  return bot
}

/** 子进程请求重启时的退出码（守护进程据此重新拉起） */
export const RESTART_CODE = 255

/**
 * 热重载求值失败后的兜底自动重启。
 *
 * 触发条件：错误发生在「重载新求值出来的模块」里，且是模块初始化类错误（TDZ 等）。
 * 覆盖插件自己把 rejection 吞掉、框架只看到日志的场景；changePlugin 那条路已单独处理，
 * 两边共用 reload-hooks 的状态与节流，所以不会重复重启。
 */
function recoverFromReloadError(bot: any, e: any) {
  if (cfg.bot.reload_restart_on_error === false) return
  if (!consumeReloadFailure()) return
  if (!noteCrash()) {
    logger.error(
      `[Restart] 重载后模块初始化失败，两分钟内已自动重启过一次，本次不再重启。\n` +
        '        多为插件「循环 import + 顶层副作用」写法所致；请在插件里把顶层副作用挪进函数，' +
        '或改完直接重启（config/config/bot.yaml → reload_restart_on_error 可关掉自动重启）',
    )
    return
  }
  logger.mark('[Restart] 重载后模块初始化失败，2 秒后自动重启恢复')
  setTimeout(() => {
    Promise.resolve(bot?.restart?.()).catch(() => process.exit(RESTART_CODE))
  }, 2000)
}

/**
 * 守护进程：在同一终端内拉起/重启主进程
 * 主进程以退出码 255 退出时重新拉起；正常退出或崩溃则结束守护。
 * 255 也用于「端口冲突」等可自愈场景，故设连续失败上限：拉起来就跑不动通常是根因没修
 * （端口被别的实例长期占用等），此时停下并给指引，比无限重拉刷日志更有用。
 */
export const MAX_AUTO_RESTARTS = 5

/** 短于这个时长就退出算「没起来」；跑够这么久说明这次重启是正常的，连续失败计数清零 */
export const FAST_FAIL_MS = 30000

/** 配置里的 V8 老生代上限（MB），0 = 不注入 */
export function heapCap(): number {
  const n = Number(cfg.bot.max_old_space_size ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 拉子进程时要拼在 argv 前的参数；每轮重新读配置，所以改完 max_old_space_size 后 #重启 即生效 */
export function heapCapArgs(): string[] {
  const n = heapCap()
  return n ? [`--max-old-space-size=${n}`] : []
}

export async function supervise() {
  const { spawn } = await import('node:child_process')
  setLogDir('logs')
  setLog()

  const entry = process.argv[1]
  const args = process.argv.slice(2).filter(a => a !== 'daemon')
  let stopping = false
  let child: ReturnType<typeof spawn> | undefined
  /** SIGHUP 也要处理：SSH 断开时终端会发它，否则守护进程退出、子进程变孤儿继续占端口 */
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      stopping = true
      child?.kill('SIGTERM')
    })

  /** 连续「起来就退」的次数：只有快速失败才累加，稳定运行过一轮（含正常 #重启）就清零 */
  let restarts = 0
  while (!stopping) {
    const startedAt = Date.now()
    /**
     * 每轮都按当前配置注入堆上限：守护进程自身改不了（它已经起来了），但子进程可以，
     * 这样 tune 或手改配置之后 `#重启` 就能生效，不必重开 CLI 会话。
     * 配置文件优先于启动时继承下来的 NODE_OPTIONS（后者可能是旧值）。
     */
    child = spawn(process.execPath, [...heapCapArgs(), entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, app_type: 'internal', JIULI_CHILD: '1' },
    })
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve =>
      child!.on('exit', (c, s) => resolve({ code: c, signal: s })),
    )

    if (stopping) {
      logger.mark('[Daemon] 收到退出信号，停止守护进程')
      break
    }
    if (code === RESTART_CODE) {
      if (Date.now() - startedAt > FAST_FAIL_MS) restarts = 0
      restarts++
      if (restarts > MAX_AUTO_RESTARTS) {
        logger.mark(
          `[Daemon] 已连续重拉 ${MAX_AUTO_RESTARTS} 次都没起来，停止守护进程。` +
            '常见原因：端口被别的实例占用（确认是否重复启动）或启动期一直报错，修好后重新执行 node .',
        )
        break
      }
      logger.mark(`[Daemon] 主进程请求重启 · 第 ${restarts} 次重新拉起（同一终端，不开新窗口）`)
      await new Promise(r => setTimeout(r, 800))
      continue
    }
    logger.mark(
      `[Daemon] 主进程已退出（code=${code ?? signal}），不再重启。如需后台常驻请使用 pnpm start`,
    )
    break
  }
  process.exit(0)
}
