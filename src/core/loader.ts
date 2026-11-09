/**
 * 插件加载 + 消息分发
 * 相对 TRSS 的差异：事件按 post_type 分桶索引、accept 与 rule 复用同一插件实例、消息计数内存聚合后批量写回。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import schedule from 'node-schedule'
import chokidar from 'chokidar'
import moment from 'moment'
import cfg from './config/index.js'
import plugin from './plugin.js'
import Runtime from './runtime.js'
import Handler from './handler.js'
import util from './util.js'
import { logger } from './log.js'
import metrics from './metrics.js'
import { runAsLoading } from './loading.js'
import { beginReload, bumpModuleGeneration, enableModuleReload, endReload, failReload, consumeReloadFailure, noteCrash } from './reload-hooks.js'
import type { JiuLiEvent, PluginEntry } from './types.js'

/** 兼容旧插件直接使用全局 plugin */
;(globalThis as any).plugin = plugin

/** stdin 适配器打的内部事件标记，Symbol 不参与 JSON 序列化，网络侧伪造不出来 */
const STDIN_EVENT = Symbol.for('jiuli.internal.stdin')

/** 已告警过的「上下文名没有对应方法」，同一条上下文每轮都会命中，只提醒一次 */
const ctxWarned = new Set<string>()

/** 简易 truncate，避免核心依赖 lodash */
function truncate(str: string, length: number) {
  if (!str) return ''
  return str.length > length ? `${str.slice(0, length)}...` : str
}

/**
 * 插件加载前预载 miao 的组件模块（`#miao`）
 *
 * genshin 的 model/db/BaseModel.js 顶层就 `Data.createDir(...)`，`Data` 来自 `#miao`；
 * Node 在「模块含顶层 await + 多插件并发 import」时可能让依赖未初始化就被求值（TDZ：
 * `Cannot access 'Data' before initialization`，重则 V8 Fatal）。
 * 见 load() 里的调用处注释 —— 这里只负责「尽量提前求值」，失败一律忽略。
 */
async function preloadMiao() {
  /** 用变量说明符：`#miao` 是 miao-plugin 的 imports 映射，TS 解析不到它的类型声明 */
  const spec: string = '#miao'
  try {
    await import(spec)
  } catch (err: any) {
    util.makeLog('debug', ['预加载 #miao 失败（忽略，按原样继续）', err], 'Plugin')
  }
}

/**
 * priority 缺失时的兜底值，与 plugin 基类的默认值保持一致。
 * 插件漏传 priority（或占位/降级类没设这个字段）时用它，避免排序比较函数算出 NaN。
 */
const DEFAULT_PRIORITY = 5000

/**
 * 把插件的 priority 规整成可参与比较的数字。
 *
 * 只兜「会算出 NaN」的输入：`undefined`（漏传 / 占位类没设）、`NaN`、以及非 number。
 * `-Infinity` / `Infinity` 是云崽生态的正常写法（系统插件大量用 `-Infinity`），原样保留 ——
 * 所以这里不能用 `Number.isFinite` 判断。
 *
 * 导出给测试复用，保证「测试断言的排序口径」与「框架实际排序口径」是同一套。
 */
export function priorityRank(n: unknown): number {
  return typeof n === 'number' && !Number.isNaN(n) ? n : DEFAULT_PRIORITY
}

/** 各适配器返回格式不一：{ error: [] } 空数组表示成功，也可能返回 Error 实例或字符串 */
function hasSendError(res: any): boolean {
  if (!res || typeof res !== 'object') return false
  const err = res.error ?? res.err
  if (err === undefined || err === null) return false
  if (Array.isArray(err)) return err.length > 0
  if (err instanceof Error) return true
  return Boolean(err)
}

function describeSendError(res: any): string {
  const err = res?.error ?? res?.err
  const first = Array.isArray(err) ? err[0] : err
  if (!first) return String(err ?? '未知错误')
  if (typeof first === 'string') return first
  if (first instanceof Error) return first.message
  return String(first.message ?? first.code ?? first.msg ?? util.String(first))
}

function isEmptyObject(obj: any) {
  if (!obj) return true
  for (const _ in obj) return false
  return true
}

/** 与 start.ts 的 RESTART_CODE 一致：这里不静态引 start.js，避免把 log/config 链拉进 loader */
const RELOAD_RESTART_CODE = 255

class PluginsLoader {
  /** 赋值时重建事件索引，兼容插件直接替换 priority 的用法 */
  private _priority: PluginEntry[] = []
  get priority(): PluginEntry[] {
    return this._priority
  }
  set priority(list: PluginEntry[]) {
    this._priority = list
    this.buildEventIndex()
  }

  handler: Record<string, any> = {}
  task: any[] = []
  /** JIULI_PLUGINS_DIR 可指定，用于测试/多实例隔离 */
  dir = process.env.JIULI_PLUGINS_DIR || 'plugins'

  /** 事件索引：post_type → 插件条目 */
  eventIndex = new Map<string, PluginEntry[]>()
  /** 无插件类的文件（适配器/胶水），#重载 时跳过以免重复副作用 */
  inertFiles = new Set<string>()
  /** 加载阶段是否已结束（用于判断插件是否"迟到就绪"） */
  loaded = false
  /** 插件 init 实例，卸载时用于回调 onUnload */
  private initInstances = new Map<string, any>()
  groupCD: Record<string, boolean> = {}
  singleCD: Record<string, boolean> = {}
  /** 消息去重（1s） */
  msgThrottle: Record<string, boolean> = {}
  /** 禁言窗口：`self_id:group_id` → 截止时间戳（发送失败反推出来的） */
  private muted = new Map<string, number>()

  watcher: Record<string, any> = {}
  /**
   * 重载风暴熔断：只统计**机器自激**的重载时刻表（人工改文件不计，见 noteReload）。
   * 开发时一分钟里存十几次代码是常态，不该被当成风暴；插件自己边加载边改写文件才是。
   */
  private reloadMarks = new Map<string, number[]>()
  /** 被熔断的插件（暂停其重载监听，`#重载 <插件名>` 恢复） */
  private pausedReload = new Set<string>()
  /** 所有重载（含人工）的时间戳，只用于"这频率不像人在改文件"的告警 */
  private globalReloadMarks: number[] = []
  private lastGlobalRateWarn = 0
  /** 各插件最近一次「模块求值窗口」：文件 mtime 落在这里 = 那次加载自己写出来的 */
  private loadWindows = new Map<string, { start: number; end: number }>()
  /** 已就"自激改写"告警过的文件（首次 error，之后 debug，别刷屏） */
  private selfWriteWarned = new Set<string>()
  taskMap = new Map<string, Set<any>>()
  pluginCountMap = new Map<string, number>()
  pluginCount = 0
  /** 因插件超时而未导入的文件：收尾汇总列出，并允许补拉一次 */
  private abandoned: Array<{ name: string; path: string }> = []
  private retriedAbandoned = false
  /** 批量补拉中：逐个 import 不各自重建索引，结束时统一重建一次 */
  private bulkRetry = false
  load_time: Record<string, number> = {}
  /**
   * 插件首次加载的顺序号，重载时保持不变。
   * priority 相同的插件靠它决定谁先匹配（见 sortPriority），不这么做的话重载会把插件
   * 挤到同优先级队伍的最后，抢指令的结果就变了。
   */
  private pluginOrder = new Map<string, number>()
  private orderSeq = 0
  eventCache = new WeakMap<object, { source: string; event: string[] }>()
  eventMap: Record<string, string[]> = {
    message: ['post_type', 'message_type', 'sub_type'],
    notice: ['post_type', 'notice_type', 'sub_type'],
    request: ['post_type', 'request_type', 'sub_type'],
  }

  /** 星铁命令前缀 */
  srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
  /** 绝区零前缀 */
  zzzReg = /^#?(%|％|绝区零|绝区)+/

  /** 计数缓冲：内存聚合 + 定时写回 */
  private countBuffer = new Map<string, number>()
  private countTimer?: NodeJS.Timeout

  /** 只做兼容别名、不作为插件源的目录（云崽的 plugins/other/ 转发到 system/） */
  aliasDirs = new Set(['other'])

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [] as any[])
    const ret: Array<{ name: string; path: string }> = []
    for (const val of files) {
      if (!val.isDirectory() || this.aliasDirs.has(val.name)) continue
      const tmp = { name: val.name, path: `../../${this.dir}/${val.name}` }

      if (await util.fsStat(`${this.dir}/${val.name}/index.js`)) {
        tmp.path = `${tmp.path}/index.js`
        ret.push(tmp)
        continue
      }

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile() || !app.name.endsWith('.js')) continue
        ret.push({ name: `${tmp.name}/${app.name}`, path: `${tmp.path}/${app.name}` })
      }
    }
    return ret
  }

  /** isRefresh 时先卸载再加载 */
  async load(isRefresh = false) {
    if (isRefresh) {
      const keys = new Set([...this.priority.map(i => i.key), ...this.taskMap.keys(), ...this.pluginCountMap.keys()])
      for (const key of keys) await this.unloadPlugin(key)
      /** 整目录刷新：代数 +1，所有插件的模块图都换新 */
      bumpModuleGeneration()
      /** 手动 #重载 同时解除重载风暴熔断 */
      this.resumeReload()
      this.reloadMarks.clear()
    }
    if (this.priority.length) return

    /**
     * 先装模块解析钩子，再导入任何插件：插件目录下的模块会被打上代数戳，
     * 重载时代数 +1 即可让整张模块图（含 apps/ lib/ 里的嵌套模块）重新求值。
     * Node 偏老没有这个钩子时只提示一次，别让用户以为改了代码就一定生效。
     */
    const moduleReload = enableModuleReload(this.dir)
    if (!moduleReload)
      util.makeLog(
        'warn',
        `当前 Node（${process.version}）不支持模块图热重载：改插件代码后只有入口文件会重新求值，` +
          `目录型插件（index.js + apps/ + lib/）需要 #重启。升级到 Node 22.15+ 可修复`,
        'Plugin',
      )

    util.makeLog('info', '扫描插件目录 plugins/ …', 'Plugin')

    /**
     * 预加载 miao 的组件模块（`#miao`）
     *
     * genshin 的 model/db/BaseModel.js 顶层就 `Data.createDir(...)`，而 `Data` 来自 `#miao`。
     * Node 在「模块里有顶层 await + 多个插件并发 import」时会出现依赖还没初始化就被求值：
     * `Cannot access 'Data' before initialization`（TDZ），重则 V8 Fatal。
     * 典型触发者（实测）：ZZZ-Plugin 的 index.js 里 `Promise.allSettled([import(...), ...])`
     * 并发导入自己的 app 模块，其中一个链到 genshin 数据层，正好撞上别的插件在求值 `#miao`。
     *
     * 这里在**任何插件之前**把 `#miao` 求值完：它自身不依赖 genshin（安全方向），
     * 之后插件 import 它全是缓存命中，那个 TDZ 不可能再发生。没装 miao / 它自己坏了都只记 debug。
     */
    await preloadMiao()

    const files = await this.getPlugins()
    this.pluginCount = 0
    this.load_time = {}
    const packageErr: any[] = []
    const loadStart = Date.now()

    /** 还没就绪的插件：等待期间每 5 秒报一次进度，避免「卡住了一样没输出」 */
    const pending = new Set(files.map(f => f.name))
    /** 正在导入的文件：pending 还含排队未开始的，进度里点名它们会误导 */
    const inflight = new Set<string>()
    const report = setInterval(() => {
      if (!inflight.size) return
      const list = [...inflight]
      util.makeLog(
        'warn',
        `等待 ${logger.yellow(String(list.length))} 个插件就绪（已等 ${Math.round((Date.now() - loadStart) / 1000)} 秒）：` +
          `${list.slice(0, 6).join(' · ')}${list.length > 6 ? ' …' : ''}\n` +
          `        仍在加载的插件顶层可能在做重活（读资源 / 连服务 / 等网络）；超过 plugin_load_timeout 会跳过`,
        'Plugin',
      )
    }, 5000)
    report.unref?.()

    /**
     * 并发导入插件。
     *
     * 不能一次全放出去：Node 的 ESM 加载器在「多个模块同时求值、其中又有顶层 await」时
     * 会出现锁竞争，实测在 96 个插件的机器上会整体卡死（每个都开始导入、一个都不完成，
     * 事件循环却空闲、没有任何句柄 —— 承诺型死锁）；串行导入同样的插件只要 10 秒。
     * 并发数可用 config/jiuli.yaml → perf.load_concurrency 调整（1 即完全串行）。
     */
    const concurrency = Math.max(1, Math.min(Number(cfg.getPerf().load_concurrency) || 4, files.length))
    const queue = [...files]
    /** 一旦有插件超时，说明加载器被它卡住了：继续导入只会一个个耗完超时，直接收工 */
    let stalled = false
    let stalledBy = ''
    const worker = async () => {
      while (queue.length && !stalled) {
        const file = queue.shift()!
        /** 下限 1 秒：配置成 0 / 负数 / 非数字时会让每个插件都被判超时，等于全部不加载 */
        const timeout = Math.max(1000, Number(cfg.bot.plugin_load_timeout) * 1000 || 0)
        const started = Date.now()
        inflight.add(file.name)
        try {
          if ((await util.sleep(timeout, this.importPlugin(file, packageErr))) === util.sleepTimeout) {
            stalled = true
            stalledBy = file.name
            /** 队列里还没轮到导入的文件 + 其他 worker 在飞的文件：并发下两个 worker 都可能进来，只记一次 */
            if (!this.abandoned.length) {
              const others = files.filter(f => f.name !== file.name && inflight.has(f.name))
              this.abandoned = [...queue, ...others]
            }
            queue.length = 0
            util.makeLog(
              'error',
              `插件加载超时（${timeout / 1000} 秒）${logger.red(file.name)}\n` +
                `        该插件顶层可能在做重活或卡住了，并且会阻塞后续插件的导入\n` +
                `        本轮已加载 ${this.pluginCount} 个插件；没加载的会在收尾汇总里列出并再补拉一次\n` +
                `        排查：把该文件改名（如加 .disabled 后缀）或移走；根因修好后发 #重载 或重启`,
              'Plugin',
            )
          } else if (Date.now() - started > 5000)
            util.makeLog(
              'warn',
              `插件就绪较慢 ${logger.yellow(file.name)} · ${util.getTimeDiff(started)}（不影响启动，仅供参考）`,
              'Plugin',
            )
        } catch (e: any) {
          /**
           * importPlugin 内部已收集插件类的构造/init 失败，这里只兜「它自己在收尾阶段抛异常」：
           * worker 一旦 reject 就退出，队列里剩下的文件再也不会被 shift —— 插件静默缺失，
           * 而 allSettled 把 rejection 吞掉，除了收尾的「本轮未加载」没有任何线索。
           */
          util.makeLog('error', `插件加载异常 ${logger.red(file.name)}：${e?.message || e}`, 'Plugin')
          util.makeLog('debug', [`${file.name} 加载异常详情`, e], 'Plugin')
        } finally {
          inflight.delete(file.name)
          pending.delete(file.name)
        }
      }
    }
    await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker()),
    )
    clearInterval(report)

    this.packageTips(packageErr)
    this.createTask()
    this.buildEventIndex()

    const rules = this.priority.reduce((n, i) => n + (i.plugin.rule?.length || 0), 0)
    const listeners = this.priority.filter(i => i.plugin.accept || i.plugin.event !== 'message').length
    util.makeLog(
      'info',
      `插件 ${logger.green(String(this.pluginCount))} 个 · 规则 ${rules} 条 · 事件监听 ${listeners} 个 · 定时任务 ${this.task.length} 个 · 用时 ${util.getTimeDiff(loadStart)}`,
      'Plugin',
    )
    /**
     * 被动中止加载时补齐「少了谁」：插件数少于磁盘文件数不会有别的地方体现，
     * 过去只剩一行插件总数，看不出有插件没进来。
     *
     * 判定必须**推迟**：worker 把文件 shift 出来后要等 import 完成才写 load_time，
     * 主循环结束时最后几个文件可能正处在这个窗口里 —— 当场判就会把它们误报成
     * 「本轮未加载」（线上表现是两次启动插件数一样、文件名每次换一个）。
     */
    this.reportNeverImported(files, stalledBy)
    /** 并行导入下记录的是"开始加载 → 该插件就绪"（含公共依赖解析开销），不代表插件自身有问题 */
    const sorted = Object.entries(this.load_time).sort((a, b) => b[1] - a[1])
    const slow = sorted.filter(([, t]) => t > 200).slice(0, 8)
    if (slow.length)
      util.makeLog('debug', `就绪最慢：${slow.map(([f, t]) => `${f} ${t}ms`).join(' · ')}`, 'Plugin')
    const key = sorted.slice(0, 3).filter(([, t]) => t > 1000)
    if (key.length)
      util.makeLog(
        'mark',
        `启动关键路径：${key.map(([f, t]) => `${f} ${logger.yellow(`${t}ms`)}`).join(' · ')} · 并行导入，耗时含公共依赖解析`,
        'Plugin',
      )

    /** 优先级排序 */
    this.sortPriority()

    /** 加载阶段结束：此后才就绪的插件（超时后才 import 完）会被自动补进分发 */
    this.loaded = true
    /** 一个插件超时不该拖走同批队列里的其他插件：补拉一次，不阻塞启动 */
    if (this.abandoned.length && !this.retriedAbandoned) {
      this.retriedAbandoned = true
      const files = this.abandoned
      this.abandoned = []
      const timeout = Math.max(1000, Number(cfg.bot.plugin_load_timeout) * 1000 || 0)
      util.makeLog('warn', `补拉 ${files.length} 个被超时牵连的插件…`, 'Plugin')
      this.retryAbandoned(files, timeout).catch(() => {})
    }
    this.watchPlugins()
  }

  /**
   * 补拉被超时牵连、本轮完全没导入的文件；逐个补，避免再出现同批卡住。
   * 每个文件仍有自己的超时，整体在后台跑，不阻塞启动收尾。
   * 期间挂起逐条重建，结束后统一建一次索引 / 排序 / 定时任务。
   */
  private async retryAbandoned(files: Array<{ name: string; path: string }>, timeout: number) {
    const before = new Set(this.pluginCountMap.keys())
    this.bulkRetry = true
    let done = 0
    let pending: string[] = []
    try {
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx]
        /** 超时那个文件仍在 ESM 里求值（可能「迟到就绪」），别对同一个 URL 重复等 */
        if (this.pluginCountMap.has(file.name) || this.isLoaded(file.name) || this.inertFiles.has(file.name))
          continue
        if ((await util.sleep(timeout, this.importPlugin(file))) === util.sleepTimeout) {
          pending = files.slice(idx + 1).map(f => f.name)
          util.makeLog('error', `补拉仍超时（${timeout / 1000} 秒）${logger.red(file.name)}，停止本次补拉`, 'Plugin')
          break
        }
        if (++done % 20 === 0)
          util.makeLog('info', `补拉进行中 ${done}/${files.length} · 最近 ${file.name}`, 'Plugin')
      }
    } finally {
      this.bulkRetry = false
      this.buildEventIndex()
      this.sortPriority()
      this.createTask()
      /** 适配器插件是被 import 才算注册的：补拉回来的还要跑一次 load() 才会真正上线 */
      await import('./events.js')
        .then(({ listenerLoader }: any) => listenerLoader.loadAdapters())
        .catch(() => {})
      const attached = [...this.pluginCountMap.keys()].filter(k => !before.has(k) && this.pluginCountMap.get(k))
      if (attached.length) util.makeLog('mark', `补拉完成 ${attached.length} 个 · ${logger.green(attached.join(' · '))}`, 'Plugin')
      if (pending.length)
        util.makeLog(
          'error',
          `还有 ${pending.length} 个文件未补拉：${pending.slice(0, 8).join(' · ')}${pending.length > 8 ? ' …' : ''}\n` +
            '        根因修好后发 #重载 或重启',
          'Plugin',
        )
    }
  }

  /**
   * 报告本轮没导入的文件（被超时牵连 / 从没轮到）。
   *
   * 推迟几秒再判：worker 把文件 shift 出来后要等 import 完成才写 load_time，
   * 当场判定会把「正在求值」的文件误报成未加载。没导入的文件 load_time 永远不会出现，
   * 所以推迟不会漏报，只会去掉误报。
   */
  private reportNeverImported(files: Array<{ name: string; path: string }>, stalledBy: string) {
    setTimeout(() => {
      /**
       * 必须判「键是否存在」而不是取值真假：导入耗时可能正好是 0ms（命中模块缓存、同一毫秒内完成），
       * 此时 `!0` 为真，会把已注册的插件误报成未加载（线上表现是插件数不变、文件名每次换几个）。
       */
      const neverImported = files.filter(f => !Object.hasOwn(this.load_time, f.name)).map(f => f.name)
      if (!neverImported.length) return
      const list = neverImported.slice(0, 8).join(' · ') + (neverImported.length > 8 ? ' …' : '')
      /** 文案按「实际能补拉的数量」选，避免承诺了不补的文件 */
      const retryable = this.abandoned.filter(f => neverImported.includes(f.name)).length
      const hint = retryable
        ? `其中 ${retryable} 个正在后台补拉（结束会打「补拉完成」），其余要发 #重载 或重启`
        : '修好后发 #重载 或重启（#重载 不会重跑适配器，适配器缺失只能重启）'
      util.makeLog(
        'error',
        `本轮未加载 ${logger.red(String(neverImported.length))} 个文件（磁盘 ${files.length} 个，已注册插件 ${this.pluginCount} 个）\n` +
          `        ${list}\n` +
          (stalledBy ? `        起因：${logger.red(stalledBy)} 导入超时，中止了本轮加载\n` : '') +
          `        ${hint}`,
        'Plugin',
      )
    }, 5000).unref?.()
  }

  /** 迟到的插件（超过 plugin_load_timeout 才就绪）：补进索引与定时任务，避免"下次重载才生效" */
  private lateAttach(file: { name: string }) {
    if (!this.loaded || !this.pluginCountMap.get(file.name)) return
    const mine = this.priority.filter(i => i.key === file.name)
    if (!mine.length) return
    /** 批量补拉期间不逐条重建：buildEventIndex/createTask 都是全量操作，n 条就是 n 次全量重建 */
    if (this.bulkRetry) return
    this.buildEventIndex()
    this.sortPriority()
    this.createTask()
    util.makeLog(
      'mark',
      `${logger.green(mine.map(i => i.name).join(' · '))} ${logger.gray(file.name)} 迟到就绪，已加入分发`,
      'Plugin',
    )
  }

  buildEventIndex() {
    /**
     * 桶内顺序必须与优先级顺序一致：candidates() 直接返回桶里的顺序，
     * 若在这里先按加载顺序建桶、事后再 sortPriority()，priority 就形同虚设
     * （探针/插件只要 import 得快就排在 -Infinity 的系统插件前面，谁抢到指令随加载顺序漂移）。
     */
    this.sortPriority()
    this.eventIndex = new Map()
    for (const entry of this.priority) {
      const event = entry.plugin?.event || 'message'
      const bucket = Array.isArray(event) ? '*' : String(event).split('.')[0] || '*'
      const list = this.eventIndex.get(bucket) || []
      list.push(entry)
      this.eventIndex.set(bucket, list)
    }
  }

  /**
   * 排序插件：优先级升序（小的先匹配），**并用「首次加载顺序」兜底**。
   *
   * 原来只有 `a.priority - b.priority`，priority 相同时靠 Array.sort 的稳定性维持
   * 「扫描顺序即匹配顺序」。而重载是把该插件的条目删掉、重新 push 到数组末尾 ——
   * 于是重载过的插件在同优先级里掉到最末，谁抢到指令就变了。生态插件的 priority 大量
   * 写 `-Infinity`（还互相重叠，比如 miao 的 `#更新面板` 与 system/update.js 的
   * `^#更新`），实测重载 miao-plugin 之后 `#更新面板` 被系统更新插件顶掉，重启才恢复。
   *
   * 注意 `-Infinity - -Infinity = NaN`，而 NaN 是假值，`||` 会兜到顺序号比较 ——
   * 正好是想要的「同优先级按加载顺序」。
   *
   * ⚠️ 但 `undefined - 数字` 也是 NaN，而它和「同为 -Infinity」不是一回事：
   * 一旦有条目的 priority 是 undefined（插件漏传、或占位/降级类没设这个字段），
   * 该条目与任何人比较都会退化成按 order 比 —— 比较函数**不再满足传递性**
   * （实测 `卸载枫叶(-1e42) < placeholder(undefined) < atme更新(-Infinity)`，
   * 但 `cmp(卸载枫叶, atme更新) = Infinity`）。V8 的 sort 在比较函数不一致时
   * 结果不可预测，会把**整张表的顺序打乱**，表现为「某条指令被别的插件抢走」，
   * 而且没有任何报错。实测一个 undefined 条目能让 317 条里的 304 条错位。
   *
   * 所以这里先把 priority 规整成数字：只兜「会算出 NaN」的输入（undefined / NaN /
   * 非 number），统一按基类默认值 5000 处理，再排序。
   * ⚠️ 不能用 `Number.isFinite` —— 那会把生态惯例的 `-Infinity` 一起兜掉，
   * 而 `-Infinity` 是正常用法（系统插件大量使用），必须原样保留。
   */
  private sortPriority() {
    this.priority.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.order ?? 0) - (b.order ?? 0),
    )
  }

  /** 候选插件：事件索引命中桶 + 通配桶 */
  private candidates(e: JiuLiEvent) {
    if (cfg.getPerf().event_index === false) return this.priority
    const index = this.eventIndex
    const list = index.get(e.post_type)
    const wild = index.get('*')
    if (!list) return wild ? [...wild] : []
    if (!wild) return list
    return [...list, ...wild]
  }

  /**
   * 把插件加载错误翻译成「看得懂 + 有下一步」的一行提示；完整堆栈留给 debug 级别
   * @returns text 提示文本；pkg 是否属于「缺依赖」（汇总后统一提示安装）
   */
  describeLoadError(error: any, file: { name: string }): { text: string; pkg: boolean } {
    const msg = String(error?.message || error)
    const head = `插件加载错误 ${logger.red(file.name)} · `
    /** 展示路径去掉模块 URL 上的查询串（热重载给插件模块加的 ?jiuli_reload=N / 入口的时间戳），只留文件名 */
    const rel = (p: string) =>
      String(p)
        .replace(/\?[^\s')]*$/, '')
        .replace(/\\/g, '/')
        .replace(`${process.cwd().replace(/\\/g, '/')}/`, '')

    /** 路径型模块找不到：插件少放文件 / 相对路径写错（Windows 下 imported from 后不带引号） */
    const missing = msg.match(/Cannot find module '([^']+)'(?:\s+imported from\s+'?([^'\s]+)'?)?/)
    if (missing) {
      const target = missing[1]
      if (target.startsWith('.') || target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) {
        return {
          text:
            head +
            `找不到文件 ${logger.yellow(rel(target))}\n` +
            `        ${missing[2] ? `由 ${logger.gray(rel(missing[2]))} 引入 —— ` : ''}该文件不存在：插件没放全，或相对路径写错`,
          pkg: false,
        }
      }
    }

    /** 裸包名：缺依赖 */
    const pkgMatch = msg.match(/Cannot find package '([^']+)'(?:\s+imported from\s+'?([^'\s]+)'?)?/)
    if (pkgMatch) {
      const [, name] = pkgMatch
      const dir = rel(pkgMatch[2] || '').split('/').slice(0, 2).join('/')
      return {
        text:
          head +
          `缺少依赖包 ${logger.red(name)}${pkgMatch[2] ? `（${logger.gray(rel(pkgMatch[2]))} 引入）` : ''}\n` +
          `        安装：${dir ? `cd ${dir} && ` : ''}pnpm add ${name}　或　项目根目录 pnpm i` +
          `　或一键装齐插件依赖：node jiuli deps`,
        pkg: true,
      }
    }

    /** 语法错误：给出位置，便于直接定位 */
    if (error?.name === 'SyntaxError' || /Unexpected|Invalid or unexpected token/.test(msg)) {
      return {
        text:
          head +
          `语法错误 ${logger.yellow(msg)}\n` +
          `        检查该文件是否写完整（括号 / 引号是否闭合），可执行 node --check 自查`,
        pkg: false,
      }
    }

    /** 其它错误：给出原因，能定位到插件内某一行就带上 */
    const frame = util.errorFrame(error)
    return {
      text: head + logger.yellow(msg) + (frame ? `\n        ${logger.gray(frame)}` : ''),
      pkg: false,
    }
  }

  async importPlugin(file: { name: string; path: string }, packageErr?: any[]) {
    const start_time = Date.now()
    let success = true
    /** 求值失败的原因：热重载要据此判断是否属于「求值顺序变了」的失败 */
    let failReason: any
    this.pluginCountMap.set(file.name, 0)
    /**
     * 在「正在加载 file.name」的上下文里导入，Bot 据此登记该插件注册的 express 路由与
     * WS 路径。必须走 runAsLoading（AsyncLocalStorage）而不是只设全局变量：插件是并行
     * 导入的，全局量会被别的插件改掉，路由就会记到别人名下（见 lib/core/loading.ts）。
     */
    try {
      await runAsLoading(file.name, async () => {
        const module: any = await import(file.path)
        const app = module.apps ? { ...module.apps } : module
        /**
         * 同一个类可能既作 default 又作具名导出（如 system/restart.js 的 Restart），
         * 逐个实例化会让它的 init() 跑多次 —— 重复注册事件监听与定时任务。
         */
        const seen = new Set<any>()
        const pluginArray: any[] = []
        for (const key in app) {
          const item = app[key]
          if (seen.has(item)) continue
          seen.add(item)
          pluginArray.push(this.loadPlugin(file, item))
        }
        for (const i of await Promise.allSettled(pluginArray))
          if (i?.status && i.status !== 'fulfilled') {
            success = false
            failReason ||= i.reason
            const info = this.describeLoadError(i.reason, file)
            util.makeLog('error', info.text, 'Plugin')
            util.makeLog('debug', [`${file.name} 加载失败详情`, i.reason], 'Plugin')
            if (packageErr && info.pkg) packageErr.push({ error: i.reason, file })
          }
      })
      /**
       * genshin 导入成功 → 允许框架去 import 它的模型（用户 / ck），此时都是缓存命中。
       * 导入失败时**不要**标记：它的模块图可能停在 errored / 半求值状态，
       * 框架再去 import 会复用坏模块（TDZ，甚至 V8 Fatal 把进程杀掉）。
       */
      if (success && String(file.name).split('/')[0].toLowerCase() === 'genshin')
        Runtime.markEcosystemReady()
    } catch (error: any) {
      success = false
      failReason = error
      const info = this.describeLoadError(error, file)
      util.makeLog('error', info.text, 'Plugin')
      /** 堆栈只在 debug 级别出现，避免刷屏把后面的启动日志顶掉 */
      util.makeLog('debug', [`${file.name} 加载失败详情`, error], 'Plugin')
      if (packageErr && info.pkg) packageErr.push({ error, file })
      /** 插件目录自带 package.json 会断掉对 'jiuli' 的解析，给出修法 */
      if (String(error?.message).includes("Cannot find package 'jiuli'"))
        util.makeLog(
          'error',
          `        提示：${file.name} 所在目录有自己的 package.json，需在其中加 "jiuli": "link:../.."，再执行 pnpm install`,
          'Plugin',
        )
    } finally {
      /**
       * 加载成功但没有任何插件类（适配器 / 纯胶水文件）：#重载 时不必再导入。
       * 加载失败的**不能**记为惰性，否则修好后 #重载 会一直跳过它。
       */
      if (success && !this.pluginCountMap.get(file.name)) this.inertFiles.add(file.name)
      else if (!success) this.inertFiles.delete(file.name)
    }
    this.load_time[file.name] = Date.now() - start_time
    /**
     * 记下这次模块求值的起止时间：插件若在自己的顶层改写文件，那个文件的 mtime
     * 必然落在这个窗口里 —— 是 machineWriteOwner() 区分"机器自激"与"人工编辑"的依据。
     */
    this.loadWindows.set(file.name, { start: start_time, end: Date.now() })
    /** 加载阶段结束后才就绪的插件（超时补拉）：补进分发，省得用户手动重载 */
    if (success && this.loaded) this.lateAttach(file)
    /** 重载时求值失败：交给恢复逻辑判断是不是「求值顺序变了」这类失败 */
    if (!success && failReason) failReload(failReason)
    return success
  }

  async loadPlugin(file: { name: string; path: string }, p: any) {
    if (!p?.prototype) return
    this.pluginCount++
    this.pluginCountMap.set(file.name, (this.pluginCountMap.get(file.name) ?? 0) + 1)

    const init = new p()
    /** 插件目录名，渲染/数据目录定位用 */
    init.__key = String(file.name).split('/')[0]
    this.initInstances.set(file.name, init)
    util.makeLog('debug', `加载插件 [${file.name}][${init.name}]`, 'Plugin')
    /** init() 返回 "return" 表示跳过加载 */
    if (init.init && (await init.init()) === 'return') return
    this.collectTask(init.task, init.name, file.name)
    const instance = init
    if (instance.rule)
      for (const i of instance.rule) {
        if (!(i.reg instanceof RegExp)) i.reg = new RegExp(i.reg)
        /** 预编译事件分段 */
        if (i.event) this.filtEvent(null, i)
      }

    const namespace = instance.namespace || file.name
    /** 首次加载时分配顺序号；重载复用同一个号，保证同优先级下的先后顺序不变 */
    let order = this.pluginOrder.get(file.name)
    if (order === undefined) {
      order = this.orderSeq++
      this.pluginOrder.set(file.name, order)
    }
    this.priority.push({
      plugin: instance,
      class: p,
      key: file.name,
      /** 旧插件可能没写 name，退化为类名 / 文件名，避免日志出现空名字 */
      name: instance.name || p.name || file.name,
      priority: instance.priority,
      namespace,
      order,
    })
    this.registerHandlers(instance, namespace)
  }

  registerHandlers(pluginInstance: any, namespace = pluginInstance.namespace) {
    if (!pluginInstance.handler) return
    const handlers = Array.isArray(pluginInstance.handler) ? pluginInstance.handler : [pluginInstance.handler]
    for (const { fn, key, priority } of handlers) {
      Handler.add({
        ns: namespace,
        key,
        self: pluginInstance,
        priority: priority ?? pluginInstance.priority,
        fn: pluginInstance[fn] ?? fn,
      })
    }
  }

  /** 缺依赖的汇总提示（单个插件的报错已在 importPlugin 里逐条给出） */
  packageTips(packageErr: any[]) {
    if (!packageErr.length) return
    const map = new Map<string, string[]>()
    for (const i of packageErr) {
      const name = String(i.error?.message).match(/Cannot find package '([^']+)'/)?.[1]
      if (!name) continue
      map.set(name, [...(map.get(name) || []), String(i.file.name)])
    }
    if (!map.size) return
    util.makeLog('error', `--------- 有 ${map.size} 个依赖没装 ---------`, 'Plugin')
    for (const [name, files] of map)
      util.makeLog('error', `${logger.red(name)} ← ${files.join(' · ')}`, 'Plugin')
    util.makeLog(
      'error',
      `安装：项目根目录 ${logger.red('pnpm i')}；或进入插件目录 ${logger.red('pnpm add <包名>')}，装完 ${logger.red('#重启')}`,
      'Plugin',
    )
    util.makeLog('error', '------------------------------------------', 'Plugin')
  }

  /* ==================== 分发 ==================== */

  /** 最近的消息记录（供 #诊断 排查"为什么没回复"） */
  recent = {
    receive: [] as Array<{ time: number; scene: string; content: string; matched: string }>,
    send: [] as Array<{ time: number; scene: string; content: string; plugin: string }>,
  }
  private pushRecent(list: any[], item: any) {
    list.push(item)
    if (list.length > 5) list.shift()
  }

  async deal(e: JiuLiEvent) {
    this.pushCount(e, 'receive', e.message)
    if (!this.checkBlack(e)) return
    const groupCfg = cfg.getGroup(e.self_id, e.group_id)
    if (!this.checkLimit(e, groupCfg)) return
    this.dealEvent(e, groupCfg)
    /** 被「只响应主人」静默跳过：不包 reply、不挂 runtime、不打收发日志 */
    if (e.__skipDeal) return
    if (e.only_reply_at) this.setLimit(e, groupCfg)
    this.reply(e)
    /**
     * 注册运行时（e.runtime）。
     *
     * JiuLi 默认不做云崽那种「分发前 await Runtime.init(e)」：那是每条消息一次用户信息初始化，
     * 而且会让框架主动 import genshin 生态模块（与 miao 互相纠缠、带顶层 await 的模块图，
     * 插件加载异常时框架再 import 会 TDZ / V8 Fatal）。插件需要用户信息时自己调 e.runtime 的接口。
     */
    if (cfg.getCompat().runtime !== false) Runtime.attach(e)

    /** 日志关闭或等级不足时不做任何字符串拼接 */
    const scene = util.describeScene(e)
    const msgLength = Number(cfg.bot.log_msg_length ?? 60)
    /**
     * command 等级只记录真正命中指令的消息，普通聊天不落日志（等其他等级保持原行为）。
     * 命中前先不打印，等规则匹配到再补这一行，避免每条聊天都先写一次。
     */
    const commandOnly = logger.getLevel() === 'command'
    const logMsg =
      cfg.bot.log_msg !== false &&
      e.msg !== undefined &&
      (commandOnly ? util.isLogLevelEnabled('command') : util.isLogLevelEnabled('info'))
    const msgText = e.msg ? util.truncate(e.msg, msgLength) : util.describeMsg(e.message)
    let receiveLogged = false
    const logReceive = () => {
      if (!logMsg || receiveLogged) return
      receiveLogged = true
      util.makeLog(commandOnly ? 'command' : 'info', `收 ◀ ${util.describeScene(e, true)} · ${logger.yellow(msgText)}`, 'Msg')
    }
    if (!commandOnly) logReceive()
    const recentItem = {
      time: Date.now(),
      scene,
      content: msgText,
      matched: '',
    }
    this.pushRecent(this.recent.receive, recentItem)

    const priority: PluginEntry[] = []
    for (const i of this.candidates(e)) {
      if (this.checkDisable({ plugin: i.plugin, e }, groupCfg) && this.filtEvent(e, i.plugin)) priority.push(i)
    }

    /** 单实例分发时的实例缓存 */
    const onceInstance = cfg.getPerf().once_instance !== false
    const instanceCache = new Map<PluginEntry, any>()
    const createInstance = (entry: PluginEntry) =>
      Object.assign(new entry.class(e), { e, __key: String(entry.key).split('/')[0] })
    const getInstance = (entry: PluginEntry) => {
      if (!onceInstance) return createInstance(entry)
      let instance = instanceCache.get(entry)
      if (!instance) {
        instance = createInstance(entry)
        instanceCache.set(entry, instance)
      }
      return instance
    }

    for (const i of priority) {
      if (!i.plugin.getContext) continue
      /** 探针对象，仅为取 conKey（插件名 + 事件），避免为每个插件实例化 */
      const probe = Object.create(i.class.prototype)
      probe.name = i.plugin.name
      probe.e = e
      let context: Record<string, any>
      try {
        context = {
          ...probe.getContext(),
          ...probe.getContext(false, true),
        }
      } catch (err) {
        /** 探针上取上下文本身也可能抛（插件重载后旧上下文指向不存在的字段） */
        util.makeLog('debug', ['读取上下文失败', i.key, err], 'Plugin')
        continue
      }
      if (isEmptyObject(context)) continue

      let ret
      let handled = 0
      const instance = getInstance(i)
      for (const fnc in context) {
        const handler = instance[fnc]
        /**
         * 上下文名对应的方法不存在（插件删了/改名了，旧上下文还在 stateArr 里）。
         * 直接调用会抛 TypeError 打断整条消息，连后面插件的上下文都轮不到。
         */
        if (typeof handler !== 'function') {
          const warnKey = `${i.key}·${fnc}`
          if (!ctxWarned.has(warnKey)) {
            ctxWarned.add(warnKey)
            util.makeLog('warn', `插件 ${i.key} 的上下文「${fnc}」没有对应方法，已忽略`, 'Plugin')
          }
          continue
        }
        handled++
        util.makeLog('debug', `上下文命中 ${i.name} <${i.key}> · ${fnc}`, 'Plugin')
        ret ||= await handler.call(instance, context[fnc])
      }
      /** 一条上下文都没跑起来 = 这份上下文是残留，不占这条消息，交给后面的插件 */
      if (!handled) continue
      if (ret === 'continue') continue
      return
    }

    if (!e.only_reply_at) return

    Object.defineProperty(e, 'isSr', {
      get: () => e.game === 'sr',
      set: (v: boolean) => (e.game = v ? 'sr' : 'gs'),
      configurable: true,
    })
    Object.defineProperty(e, 'isGs', {
      get: () => e.game === 'gs',
      set: (v: boolean) => (e.game = v ? 'gs' : 'sr'),
      configurable: true,
    })
    if (this.srReg.test(String(e.msg))) {
      e.game = 'sr'
      e.msg = String(e.msg).replace(this.srReg, '#星铁')
    } else if (this.zzzReg.test(String(e.msg))) {
      e.game = 'zzz'
      e.msg = String(e.msg).replace(this.zzzReg, '#绝区零')
    }

    /** 原生插件钩子：分发前，任一 beforeMessage 返回 false 即拦截本次分发 */
    if (!(await this.runHooks(e, priority, 'beforeMessage'))) return
    try {
      for (const i of priority)
        if (i.plugin.accept) {
          const res = await getInstance(i).accept(e)
          if (res === 'return') {
            util.makeLog('info', `${i.name} <${i.key}> · accept 终止分发`, 'Plugin')
            return
          }
          /**
           * 命中后继续跑后面的 accept：云崽插件的 accept 常带副作用（例如小飞点歌按序号选歌），
           * 提前 break 会让这些插件在「有插件 accept 恒返回 true」时永远不执行。
           * 规则分发本来就不看 accept 的返回值，这里保持一致。
           */
          if (res) util.makeLog('info', `${i.name} <${i.key}> · accept 命中`, 'Plugin')
        }

      /** 记录"命中指令规则但无插件响应"的情况，用于最后给出提示 */
      const commandMatched: string[] = []
      for (const i of priority) {
        if (!i.plugin.rule) continue
        for (const v of i.plugin.rule) {
          if (v.event && !this.filtEvent(e, v)) continue

          /**
           * 规则源码可能极长（meme 类插件把几百条词条塞进一个正则，几十 KB），
           * 原样打进日志会把整行刷屏，也会让日志文件暴涨 —— 这里只留开头。
           */
          /**
           * 规则源码可能极长（meme 类插件把几百条词条塞进一个正则，几十 KB），
           * 原样打进日志会刷屏、并让日志文件暴涨 —— 上限见 bot.yaml 的 log_rule_length（0 = 不截断）。
           */
          const regMax = Number(cfg.bot.log_rule_length ?? 80)
          const regStr = regMax > 0 ? util.truncate(String(v.reg), regMax) : String(v.reg)
          if (!(v.reg as RegExp).test(String(e.msg))) continue

          const instance = getInstance(i)
          const fncName = typeof v.fnc === 'string' ? v.fnc : v.fnc.name || 'fnc'
          e.logFnc = `${logger.blue(`[${i.name}(${fncName})]`)}`
          util.markPlugin(e, i.name, i.key)
          recentItem.matched = `${i.name} <${i.key}> → ${fncName}`
          /** 指令型规则（不匹配空串）才算"用户想执行指令" */
          if (!(v.reg as RegExp).test('')) commandMatched.push(`${i.name}`)

          /** command 等级下只有命中规则的这条消息才补「收 ◀」，普通聊天不会走到这里 */
          if (commandOnly && v.log !== false) logReceive()

          util.makeLog(
            v.log === false ? 'debug' : commandOnly ? 'command' : 'info',
            `中 ▶ ${logger.greenBright.bold(i.name)} ${logger.cyan(`<${i.key}>`)} · 规则 ${logger.yellow(regStr)} · 方法 ${logger.cyan(
              fncName,
            )} · 优先级 ${i.priority}`,
            'Plugin',
          )

          if (!this.filtPermission(e, v))
            util.makeLog('info', `${i.name} · 权限不足（需要 ${v.permission}）`, 'Plugin')
          else
            try {
              const startTime = Date.now()
              /** 绑定到插件实例，保持与云崽一致的 this 语义 */
              const fn =
                typeof v.fnc === 'function' ? v.fnc.bind(instance) : instance[v.fnc]?.bind(instance)
              /**
               * 云崽只传 e，故第二个参数只在插件方法自己声明了参数时才给（正则捕获结果）。
               * 无条件传会把 `fnc(e, isYesterday = false)` 这类插件的布尔开关顶成真值。
               */
              const args: any[] = fn?.length >= 2 ? [e, (v.reg as RegExp).exec(String(e.msg)) || undefined] : [e]
              const res = fn && (await fn(...args))
              const cost = Date.now() - startTime
              metrics.record(i, cost, util.describeScene(e))

              if (res === false) {
                util.makeLog(
                  v.log === false ? 'debug' : 'mark',
                  `${logger.greenBright.bold(i.name)} · 返回 false，继续匹配后续规则 · ${util.colorCost(cost)}`,
                  'Plugin',
                )
                continue
              }
              util.makeLog(
                v.log === false ? 'debug' : 'mark',
                `完成 ${logger.green.bold(i.name)} · ${util.colorCost(cost)} · ${util.describeScene(e)}`,
                'Plugin',
              )
            } catch (err) {
              util.makeLog(
                'error',
                util.describeError(
                  err,
                  `执行出错 ${logger.green.bold(i.name)} <${i.key}> · ${util.describeScene(e)}`,
                  '插件自身的问题：本次指令未完成，其他插件与启动都不受影响（完整堆栈：log_level: debug）',
                ),
                'Plugin',
              )
              util.makeLog('debug', [`${i.name} 出错堆栈`, err], 'Plugin')
            }
          return
        }
      }

      if (util.isLogLevelEnabled('debug'))
        util.makeLog('debug', `未命中插件 · ${scene} · ${util.truncate(e.msg || util.describeMsg(e.message))}`, 'Msg')

      /**
       * 命中指令型规则却无插件响应时提示一次，避免静默无响应被误认为框架故障。
       *
       * **只对指令前缀开头的消息提示**（默认 `#`，见 bot.yaml → no_handler_tip_prefix）：
       * 普通聊天经常被插件的宽泛规则（`^.+$` 之类）匹配到，插件本来就不该回话，
       * 提示它只会变成"聊一句机器人就回一句没响应"，比不提示更烦人。
       */
      if (
        commandMatched.length &&
        !e.__replied &&
        cfg.bot.no_handler_tip !== false &&
        this.looksLikeCommand(e.msg) &&
        e.message &&
        e.msg
      ) {
        const key = `${e.self_id}.${e.user_id}`
        const now = Date.now()
        if (!this.hintThrottle[key] || now - this.hintThrottle[key] > 10000) {
          this.hintThrottle[key] = now
          /**
           * 插件可以留一句更具体的提示（如 update 的"没有这个插件 / 匹配到多个插件"）：
           * 它不能自己抢先回复（会截胡下面插件的同名指令），由框架在确实没人接手时才补发。
           */
          const tip =
            e.__pluginHint ||
            (e.isMaster
              ? `这条指令没有被执行（参数或触发条件不符）· 可发 #插件列表 查看可用指令`
              : `这条指令没有响应 · 如果它是主人专属指令，请先发 #设置主人 绑定主人账号；也可能是参数不符`)
          delete e.__pluginHint
          util.makeLog('info', `提示无响应 · ${util.truncate(e.msg, 20)} · 命中 ${commandMatched.join('/')}`, 'Msg')
          /** 提示由框架发出，避免日志错误归属到最后一个匹配到的插件 */
          e.logPlugin = 'JiuLi'
          await e.reply?.(tip)
        }
      }
  
    } finally {
      /** 原生插件钩子：分发后，无论是否命中都会执行 */
      await this.runHooks(e, priority, 'afterMessage')
    }
  }

  /** 同一用户 10 秒内只提示一次"无响应" */
  private hintThrottle: Record<string, number> = {}

  /**
   * 执行原生插件钩子（beforeMessage / afterMessage）
   * 类形态定义同名方法即可；DSL 形态的 beforeMessage(fn) / afterMessage(fn) 会绑定为同名方法
   */
  private async runHooks(e: JiuLiEvent, entries: PluginEntry[], name: 'beforeMessage' | 'afterMessage') {
    for (const entry of entries) {
      const fn = entry.plugin?.[name]
      if (typeof fn !== 'function') continue
      try {
        const ret = await fn.call(Object.assign(Object.create(entry.class.prototype), entry.plugin), e)
        if (name === 'beforeMessage' && ret === false) {
          util.makeLog('debug', `${entry.name} <${entry.key}> · beforeMessage 拦截`, 'Plugin')
          return false
        }
      } catch (err) {
        util.makeLog(
          'error',
          util.describeError(
            err,
            `${name} 出错 ${logger.green.bold(entry.name)} <${entry.key}>`,
            '插件自身的问题：本次事件的分发已跳过该插件，其他插件不受影响',
          ),
          'Plugin',
        )
        util.makeLog('debug', [`${entry.name} 出错堆栈`, err], 'Plugin')
      }
    }
    return true
  }

  /**
   * 这条消息看起来像"用户在敲指令"吗（默认要求 `#` 前缀）。
   *
   * `no_handler_tip` 只在这种消息上提示：普通聊天会被插件的宽泛规则匹配到，
   * 插件本来就不回话，再补一句"没有响应"反而像机器人坏了。前缀可在
   * `bot.yaml → no_handler_tip_prefix` 里改（逗号分隔多个，写 `*` 表示不限制前缀）。
   */
  private looksLikeCommand(msg: unknown): boolean {
    const raw = String(msg ?? '')
    const conf = (cfg.bot as any).no_handler_tip_prefix
    const prefix = conf === undefined || conf === null || conf === '' ? '#' : String(conf)
    if (prefix === '*' || prefix === 'any' || prefix === 'all') return true
    return prefix
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .some(p => raw.startsWith(p))
  }

  /** 事件表达式与实际事件逐段比对，支持 * 通配 */
  filtEvent(e: JiuLiEvent | null, v: any) {
    if (!v.event) return false
    let cache = this.eventCache.get(v)
    if (!cache || cache.source !== v.event) {
      cache = { source: v.event, event: String(v.event).split('.') }
      this.eventCache.set(v, cache)
    }
    /** 预编译阶段（e 为空）只建立缓存 */
    if (!e) return false

    const eventMap = this.eventMap[e.post_type] || []
    const mappedEvent = cache.event.map((value, i) => (value === '*' ? value : e[eventMap[i]]))
    return v.event === mappedEvent.join('.')
  }

  /** 权限检查；master/owner/admin 校验失败时直接回复用户 */
  filtPermission(e: JiuLiEvent, v: any) {
    if (!v.permission || e.isMaster) return true

    if (v.permission === 'master') {
      e.reply?.('没有权限哦，只有主人才可以使用！')
      return false
    }

    if (e.isGroup) {
      if (v.permission === 'owner' && !e.member?.is_owner) {
        e.reply?.('没有权限哦，只有群主才可以使用！')
        return false
      }
      if (v.permission === 'admin' && !e.member?.is_owner && !e.member?.is_admin) {
        e.reply?.('没有权限哦，只有群管理员才可以使用！')
        return false
      }
    }

    return true
  }

  dealText(text = '') {
    if (cfg.bot['/→#']) text = text.replace(/^\s*\/\s*/, '#')
    return text
      .replace(/^\s*[＃井]\s*/, '#')
      .replace(/^\s*[＊※]\s*/, '*')
      .trim()
  }

  /** 解析消息，补齐 e.msg / e.img / e.isGroup / e.isMaster 等派生字段 */
  dealEvent(e: JiuLiEvent, groupCfg?: any) {
    groupCfg ||= cfg.getGroup(e.self_id, e.group_id)
    if (e.message)
      for (const i of e.message) {
        switch (i.type) {
          case 'text':
            e.msg = (e.msg || '') + this.dealText(i.text as string)
            break
          case 'image':
            if (Array.isArray(e.img)) e.img.push(i.url as string)
            else e.img = [i.url as string]
            break
          case 'at':
            if (i.qq == e.self_id) e.atBot = true
            else e.at = i.qq as any
            break
          case 'reply':
            e.reply_id = i.id as any
            if (e.group?.getMsg) e.getReply = () => e.group.getMsg(e.reply_id)
            else if (e.friend?.getMsg) e.getReply = () => e.friend.getMsg(e.reply_id)
            break
          case 'file':
            e.file = i
            break
          case 'xml':
          case 'json':
            e.msg = (e.msg || '') + (typeof i.data === 'string' ? i.data : JSON.stringify(i.data))
            break
        }
      }

    e.logText = ''
    if (e.sender) e.sender.card ||= e.sender.nickname
    if (e.message_type === 'private' || e.notice_type === 'friend') {
      e.isPrivate = true
      e.logText = `[${e.sender?.nickname ? `${e.sender.nickname}(${e.user_id})` : e.user_id}]`

      if (!e.recall && e.message_id && e.friend?.recallMsg) e.recall = e.friend.recallMsg.bind(e.friend, e.message_id)
    } else if (e.message_type === 'group' || e.notice_type === 'group') {
      e.isGroup = true
      e.logText = `[${e.group_name ? `${e.group_name}(${e.group_id})` : e.group_id}, ${
        e.sender?.card ? `${e.sender.card}(${e.user_id})` : e.user_id
      }]`

      if (!e.recall && e.message_id && e.group?.recallMsg) e.recall = e.group.recallMsg.bind(e.group, e.message_id)
    }

    e.logText = `${logger.cyan(e.logText)}${logger.red(`[${truncate(String(e.msg || e.raw_message || util.String(e)), 100)}]`)}`

    /**
     * 主人判定只信「事件自报的身份」，所以 stdin 这个默认主人必须额外验来源：
     * 任何能发 OneBot WS 帧的人都能把 self_id / user_id 写成 stdin，标记只有本地输入适配器能带。
     */
    if (e.user_id && cfg.master[e.self_id]?.includes(String(e.user_id))) {
      if (e.self_id === 'stdin' && (e as any)[STDIN_EVENT] !== true)
        util.makeLog('warn', ['拒绝伪造的 stdin 事件', { user_id: e.user_id }], 'Loader')
      else e.isMaster = true
    }

    /** 群聊未 at 机器人时，剥掉消息开头的 bot 别名并标记 hasAlias */
    if (e.msg && e.isGroup && !e.atBot) {
      groupCfg ||= cfg.getGroup(e.self_id, e.group_id)
      const alias = groupCfg.botAlias
      for (const i of Array.isArray(alias) ? alias : [alias])
        if (i && e.msg.startsWith(i)) {
          e.msg = e.msg.replace(i, '')
          e.hasAlias = true
          break
        }
    }

    e.only_reply_at = this.onlyReplyAt(e, groupCfg)

    /**
     * 云崽插件常以 e.original_msg 判定原始指令（例如 xiaoyao 的 dispatch）。
     * accept 阶段只要有一个插件返回 true 就会中断，后面的插件拿不到 accept 回调，
     * 这里补默认值，避免这些插件把整条消息当成空文本跳过。
     */
    if (e.original_msg === undefined) e.original_msg = e.msg

    /** 派生字段齐了，这里才判「只响应主人」：非主人直接静默结束（连"收 ◀"都不打） */
    if (!this.checkMasterOnly(e, groupCfg)) e.__skipDeal = true
  }

  /**
   * 「只响应主人」：群配置层开关（`onlyReplyMaster: 1`），默认关。
   *
   * 和 `permission: master` 的区别：那个是按**指令**声明、且会回一句"没有权限"；
   * 这个是整层过滤，非主人的消息什么都不回（连提示都没有），适合把机器人当私人助手。
   * 私聊同样受约束 —— 它回答的是"谁能用这个机器人"。
   *
   * 必须在派生字段齐了之后调用（e.isMaster 是 dealEvent 里算的），否则会把主人一起拦掉。
   */
  checkMasterOnly(e: JiuLiEvent, groupCfg?: any) {
    groupCfg ||= cfg.getGroup(e.self_id, e.group_id)
    if (groupCfg.onlyReplyMaster !== 1) return true
    if (e.isMaster) return true
    util.makeLog('debug', `onlyReplyMaster 已开启，忽略非主人消息 · ${util.describeScene(e, true)}`, 'Msg')
    return false
  }

  /** 包装 e.reply：拼装 at/引用、记录发送日志，并在失败时捕获异常 */
  reply(e: JiuLiEvent) {
    if (!e.reply?.bind) return
    const reply = e.reply.bind(e)

    e.reply = async (msg: any = '', quote = false, data: any = {}) => {
      if (!msg) return false

      /** 群被禁言窗口内连试都不试：发出去只会再拿一次 120，还刷一屏 ERROR */
      if (this.isMuted(e)) {
        util.makeLog('debug', `群 ${e.group_id} 禁言中，跳过发送 · ${util.truncate(util.describeMsg(msg), 40)}`, 'Msg')
        return false
      }

      let { recallMsg = 0, at = '' } = data
      const segment = (globalThis as any).segment

      if (at && e.isGroup) {
        if (at === true) at = e.user_id as any
        if (Array.isArray(msg)) msg.unshift(segment.at(at), '\n')
        else msg = [segment.at(at), '\n', msg]
      }

      if (quote && e.message_id) {
        if (Array.isArray(msg)) msg.unshift(segment.reply(e.message_id))
        else msg = [segment.reply(e.message_id), msg]
      }

      let res
      const sendStart = Date.now()
      try {
        res = await reply(msg)
      } catch (err) {
        res = { error: [err] }
      }

      const failed = hasSendError(res)
      /**
       * 被禁言是群状态，不是框架故障（icqq 会先打一条 failed to send，我们再刷一屏堆栈也没用）。
       * 记下窗口后直接跳过该群，下一条消息走 checkLimit 就不会再进来了。
       */
      const muted = failed && this.isMuteError(res)
      if (muted) this.markMuted(e)
      else if (failed) util.makeLog('error', ['发送消息错误', msg, res?.error?.[0] ?? res], e.self_id)

      /** 日志用带色目标，最近消息记录用无色的 targetPlain */
      const targetPlain =
        e.isGroup || e.group_id ? `群 ${e.group_name || ''}(${e.group_id})` : `好友 ${e.user_id}`
      const target = e.isGroup || e.group_id
        ? `群 ${logger.cyan(e.group_name || '')}(${logger.cyan(e.group_id)})`
        : `好友 ${logger.magenta(e.user_id)}`
      const content = util.describeMsg(msg)
      const byPlugin = e.logPlugin ? ` · 由 ${logger.green.bold(e.logPlugin)}` : ''
      const cost = Date.now() - sendStart
      const failReason = failed ? util.truncate(describeSendError(res), 120) : ''
      util.makeLog(
        failed ? (muted ? 'debug' : 'error') : 'info',
        `发 ${failed ? '✖' : '▶'} ${target} · ${logger.yellow(content)}${byPlugin} · ${util.colorCost(cost)}${
          failed ? ` · 发送失败：${failReason}` : ''
        }`,
        'Msg',
      )
      this.pushRecent(this.recent.send, {
        time: Date.now(),
        scene: targetPlain,
        content,
        plugin: e.logPlugin || '',
      })
      /** 标记本事件已有回复，供"无响应"提示判断 */
      e.__replied = true

      if (recallMsg > 0 && res?.message_id) {
        if (e.group?.recallMsg)
          setTimeout(() => {
            e.group.recallMsg(res.message_id)
            if (e.message_id) e.group.recallMsg(e.message_id)
          }, recallMsg * 1000)
        else if (e.friend?.recallMsg)
          setTimeout(() => {
            e.friend.recallMsg(res.message_id)
            if (e.message_id) e.friend.recallMsg(e.message_id)
          }, recallMsg * 1000)
      }

      this.pushCount(e, 'send', msg)
      return res
    }
  }

  /* ==================== 计数（批量写回） ==================== */

  private pushCount(e: JiuLiEvent, type: string, msg?: any) {
    const buf = this.countBuffer
    const add = (key: string, value = 1) => buf.set(key, (buf.get(key) || 0) + value)

    const items: Array<[string, number]> = [[`${type}:msg`, 1]]
    if (cfg.bot.msg_type_count)
      for (const i of Array.isArray(msg) ? msg : [msg]) items.push([`${type}:${i?.type || 'text'}`, 1])

    const now = moment()
    const stamps = [now.format('YYYY:MM:DD'), now.format('YYYY:MM'), now.format('YYYY'), 'total']
    for (const [kind, value] of items)
      for (const stamp of stamps) {
        add(`Yz:count:${kind}:total:${stamp}`, value)
        if (e.self_id) add(`Yz:count:${kind}:bot:${e.self_id}:${stamp}`, value)
        if (e.user_id) add(`Yz:count:${kind}:user:${e.user_id}:${stamp}`, value)
        if (e.group_id) add(`Yz:count:${kind}:group:${e.group_id}:${stamp}`, value)
      }

    const flushMs = Number(cfg.getPerf().count_flush_ms ?? 1000)
    if (!flushMs) return this.flushCount()
    if (!this.countTimer) {
      this.countTimer = setTimeout(() => {
        this.countTimer = undefined
        this.flushCount().catch(() => {})
      }, flushMs)
      this.countTimer.unref?.()
    }
  }

  async flushCount() {
    if (!this.countBuffer.size) return
    const redis = (globalThis as any).redis
    if (!redis) return
    const buffer = this.countBuffer
    this.countBuffer = new Map()
    try {
      const multi = redis.multi()
      for (const [key, value] of buffer) multi.incrBy(key, value)
      await multi.exec()
    } catch (err) {
      util.makeLog('error', ['写入消息计数错误', err], 'Count')
    }
  }

  async saveCount(e: JiuLiEvent, type: string) {
    this.pushCount(e, type)
    return true
  }

  /* ==================== 定时任务 ==================== */

  collectTask(task: any, name: string, key: string) {
    let tasks: Set<any> | undefined
    if (key) {
      tasks = this.taskMap.get(key) ?? new Set()
      this.taskMap.set(key, tasks)
    }
    for (const i of Array.isArray(task) ? task : [task])
      if (i?.cron && i?.fnc) {
        i.name ??= name
        this.task.push(i)
        tasks?.add(i)
      }
  }

  async startTask(name: string, i: any) {
    try {
      const start_time = Date.now()
      util.makeLog(i.log === false ? 'debug' : 'mark', `${name}${logger.yellow('[开始处理]')}`, false)
      const fn = typeof i.fnc === 'function' ? i.fnc.bind(i.self ?? i) : i.self?.[i.fnc] ?? i.fnc
      await fn()
      util.makeLog(i.log === false ? 'debug' : 'mark', `${name}${logger.green(`[完成${util.getTimeDiff(start_time)}]`)}`, false)
    } catch (err) {
      util.makeLog('error', util.describeError(err, `定时任务出错 ${logger.green.bold(name)}`, '该任务的这次执行中断；完整堆栈见 debug 日志'), 'Task')
      util.makeLog('debug', [`${name} 任务堆栈`, err], 'Task')
    }
  }

  createTask() {
    const created = new Set()
    for (const i of this.task) {
      if (i.job?.cancel) i.job.cancel()
      const name = `${logger.blue(`[${i.name}(${i.cron})]`)}`
      if (created.has(name)) {
        util.makeLog('warn', `重复定时任务 ${name} 已跳过`, 'Task')
        continue
      }
      created.add(name)
      util.makeLog('debug', `加载定时任务 ${name}`, 'Task')
      i.job = schedule.scheduleJob(String(i.cron).split(/\s+/).slice(0, 6).join(' '), this.startTask.bind(this, name, i))
    }
  }

  /* ==================== 过滤/冷却 ==================== */

  /**
   * 发送失败是不是"这个群发不出去"（被禁言）
   *
   * 各协议端的形态不一样：icqq 抛 ApiRejection（code 120 / "在该群被禁言"），
   * OneBot 那几个返回 `{ retcode, wording }`，所以错误码和文案一起认。
   */
  private isMuteError(res: any): boolean {
    const err = res?.error ?? res?.err
    const first = Array.isArray(err) ? err[0] : err
    if (!first) return false
    if (Number(first.code ?? first.retcode ?? first.err_code) === 120) return true
    const text = `${first.message ?? first.msg ?? first.wording ?? first}`
    return /禁言|muted|shut ?up/i.test(text)
  }

  /**
   * 记下"这个群暂时发不出去"，窗口内不再尝试
   *
   * 状态只存在内存里，且只能靠实际发送失败反推：
   * - 禁言 / 解禁都是 notice，重启、停机、崩溃期间发生的那一段根本收不到，靠通知维护状态必然漏；
   * - 协议端的群资料同样有缓存（icqq 是 900 秒），禁言刚开始时读到的 mute_left 仍是 0。
   * 所以重启后缓存清空、首条消息照常试一次，失败再重新记窗口。
   *
   * 窗口取 60 秒是为了给恢复延迟一个上界：解禁通知可能也错过了，
   * 到期自动放行，最坏情况就是解禁后多安静一分钟。
   */
  private markMuted(e: JiuLiEvent, seconds = 60) {
    if (!e.group_id) return
    const key = `${e.self_id}:${e.group_id}`
    const first = !this.isMuted(e)
    this.muted.set(key, Date.now() + seconds * 1000)
    if (first)
      util.makeLog(
        'warn',
        `群 ${e.group_id} 发不出消息（被禁言），${seconds} 秒内跳过该群的消息（不缓存、不补发）；` +
          '之后按新进来的消息重新尝试',
        'Msg',
      )
  }

  /**
   * 该群是否还在禁言窗口内（过期即清掉）
   *
   * 只认时间、不认"解禁通知"：那类 notice 在进程不在时会丢，收到了也不代表没漏过。
   */
  private isMuted(e: JiuLiEvent): boolean {
    if (!e.group_id) return false
    const key = `${e.self_id}:${e.group_id}`
    const until = this.muted.get(key)
    if (!until) return false
    if (until > Date.now()) return true
    this.muted.delete(key)
    return false
  }

  checkLimit(e: JiuLiEvent, config?: any) {
    if (e.group && (e.group.mute_left > 0 || (e.group.all_muted && !e.group.is_admin && !e.group.is_owner)))
      return false
    /**
     * 上面那条依赖协议端给的群资料（mute_left / all_muted），资料没加载时读出来是 NaN/0，
     * 判断会静默放行 —— 用发送失败反推出来的禁言窗口兜底。
     */
    if (this.isMuted(e)) {
      util.makeLog('debug', `群 ${e.group_id} 在禁言窗口内，跳过本次分发 · ${e.user_id}`, 'Msg')
      return false
    }
    if (!e.message || e.isPrivate) return true

    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD && this.groupCD[e.group_id as any]) return false
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) return false

    /** 同一用户同一消息 1s 内只处理一次 */
    const msgId = `${e.self_id}:${e.user_id}:${e.raw_message}`
    if (this.msgThrottle[msgId]) return false

    this.msgThrottle[msgId] = true
    setTimeout(() => delete this.msgThrottle[msgId], 1000).unref?.()

    return true
  }

  setLimit(e: JiuLiEvent, config?: any) {
    if (e.isPrivate) return
    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD) {
      this.groupCD[e.group_id as any] = true
      setTimeout(() => delete this.groupCD[e.group_id as any], config.groupCD).unref?.()
    }
    if (config.singleCD) {
      const key = `${e.group_id}.${e.user_id}`
      this.singleCD[key] = true
      setTimeout(() => delete this.singleCD[key], config.singleCD).unref?.()
    }
  }

  onlyReplyAt(e: JiuLiEvent, groupCfg?: any) {
    if (!e.message || e.isPrivate) return true

    groupCfg ||= cfg.getGroup(e.self_id, e.group_id)

    /** 模式0，未开启前缀 */
    if (groupCfg.onlyReplyAt === 0 || !groupCfg.botAlias) return true
    /** 模式2，非主人开启 */
    if (groupCfg.onlyReplyAt === 2 && e.isMaster) return true
    /** at机器人 */
    if (e.atBot) return true
    /** 消息带前缀 */
    if (e.hasAlias) return true

    return false
  }

  /** 命中 other 中的黑名单即拦截；白名单存在时未命中即拦截 */
  checkBlack(e: JiuLiEvent) {
    const other = cfg.getOther()

    if (other.blackUser?.length && other.blackUser.includes(Number(e.user_id) || String(e.user_id))) return false
    if (other.whiteUser?.length && !other.whiteUser.includes(Number(e.user_id) || String(e.user_id))) return false

    if (e.group_id) {
      if (other.blackGroup?.length && other.blackGroup.includes(Number(e.group_id) || String(e.group_id))) return false
      if (other.whiteGroup?.length && !other.whiteGroup.includes(Number(e.group_id) || String(e.group_id))) return false
    }

    return true
  }

  /** groupCfg 的 disable 列表命中即禁用；enable 列表存在时不在其中即禁用 */
  checkDisable(p: { plugin: any; e: JiuLiEvent }, groupCfg?: any) {
    groupCfg ||= cfg.getGroup(p.e.self_id, p.e.group_id)
    if (groupCfg.disable?.length && groupCfg.disable.includes(p.plugin.name)) return false
    if (groupCfg.enable?.length && !groupCfg.enable.includes(p.plugin.name)) return false
    return true
  }

  /* ==================== 卸载/热重载 ==================== */

  async unloadPlugin(key: string, closeWatcher = false) {
    /** 插件的清理回调（定时器、连接等） */
    const initInstance = this.initInstances.get(key)
    if (typeof initInstance?.onUnload === 'function')
      try {
        await initInstance.onUnload()
      } catch (err) {
        util.makeLog('error', util.describeError(err, `onUnload 出错 ${logger.green.bold(key)}`, '清理资源的代码有问题；热重载仍会继续'), 'Plugin')
        util.makeLog('debug', [`${key} onUnload 堆栈`, err], 'Plugin')
      }
    this.initInstances.delete(key)

    /** 清理插件注册的 express 路由与 WS 路径（热重载不重复注册） */
    ;(globalThis as any).Bot?.cleanupPluginResources?.(key)

    const entries = this.priority.filter(i => i.key === key)
    const namespaces = new Set(entries.map(i => i.namespace || i.plugin.namespace || key))
    for (const ns of namespaces) Handler.del(ns)

    const tasks = this.taskMap.get(key)
    if (tasks) {
      for (const i of tasks) i.job?.cancel?.()
      this.task = this.task.filter(i => !tasks.has(i))
      this.taskMap.delete(key)
    }

    this.priority = this.priority.filter(i => i.key !== key)
    const pluginCount = this.pluginCountMap.get(key) ?? entries.length
    if (typeof this.pluginCount === 'number') this.pluginCount = Math.max(0, this.pluginCount - pluginCount)
    this.pluginCountMap.delete(key)
    delete this.load_time[key]
    this.buildEventIndex()
    metrics.remove(key)

    if (closeWatcher) {
      const watcherKey = key.replace('/', '.')
      const watcher = this.watcher[watcherKey]
      if (watcher) {
        ;(watcher as any).changeHandler?.cancel?.()
        ;(watcher as any).unlinkHandler?.cancel?.()
        await Promise.resolve(watcher.close?.()).catch(() => {})
        delete this.watcher[watcherKey]
      }
    }
  }

  async changePlugin(key: string) {
    const oldPriority = this.priority.filter(i => i.key === key)
    const oldTasks = this.taskMap.get(key)
    const oldPluginFileCount = this.pluginCountMap.get(key)
    const oldLoadTime = this.load_time[key]
    const oldPluginCount = this.pluginCount
    try {
      await this.unloadPlugin(key)
      /**
       * 代数 +1 再导入：入口里 `import './apps/x.js'` 这类嵌套模块会以新 URL 解析，
       * 整张插件模块图重新求值 —— 不然日志写着「重载」，跑的仍是缓存里的旧代码。
       */
      bumpModuleGeneration()
      /** 目录型插件需指向 index.js，Node 不支持目录 import */
      const target = key.endsWith('.js') ? key : `${key}/index.js`
      beginReload()
      let success: boolean
      try {
        success = await this.importPlugin({
          name: key,
          path: `../../${this.dir}/${target}?${moment().format('x')}`,
        })
      } catch (err) {
        failReload(err)
        throw err
      } finally {
        endReload()
      }
      if (!success) {
        await this.unloadPlugin(key)
        this.priority.push(...oldPriority)
        if (oldTasks) {
          const tasks = [...oldTasks]
          this.task.push(...tasks)
          this.taskMap.set(key, new Set(tasks))
        }
        if (oldLoadTime !== undefined) this.load_time[key] = oldLoadTime
        this.pluginCount = oldPluginCount
        if (oldPluginFileCount !== undefined) this.pluginCountMap.set(key, oldPluginFileCount)
        for (const i of oldPriority) this.registerHandlers(i.plugin, i.namespace || key)
      }
      this.sortPriority()
      this.buildEventIndex()
      this.createTask()
      if (!success) this.recoverReload(key)
      return success
    } catch (err) {
      util.makeLog('error', this.describeLoadError(err, { name: key }).text, 'Plugin')
      util.makeLog('debug', [`${key} 重载失败详情`, err], 'Plugin')
      this.recoverReload(key)
      return false
    }
  }

  /**
   * 热重载求值失败后的恢复。
   *
   * 重载会让整张模块图按新顺序重新求值；插件若把循环 import 和顶层副作用混在一起，
   * 新顺序可能撞上 TDZ（`Cannot access 'Data' before initialization`），而冷启动顺序是好的
   * —— 表现为「重载后该插件指令全没了，重启才恢复」。这种失败可能被插件自己的
   * `Promise.allSettled` 吞掉，框架只看到一堆 ERROR，所以这里只能靠重启恢复。
   *
   * 用两分钟的节流兜底：真坏到起不来时只重启一次，之后明确提示手动处理，不反复重启。
   */
  private recoverReload(key: string) {
    if (cfg.bot.reload_restart_on_error === false) return
    if (!consumeReloadFailure()) return
    if (!noteCrash()) {
      util.makeLog(
        'error',
        `${key} 重载后模块初始化失败，两分钟内已自动重启过一次，本次不再重启。\n` +
          '        多为插件「循环 import + 顶层副作用」写法所致（热重载会改变求值顺序）；' +
          '请在插件里把顶层副作用挪进函数，或改完直接重启（config/config/bot.yaml → reload_restart_on_error 可关掉自动重启）',
        'Plugin',
      )
      return
    }
    util.makeLog(
      'mark',
      `${key} 重载后模块初始化失败（循环依赖 / 顶层副作用在新求值顺序下撞了 TDZ），2 秒后自动重启恢复；本次不重启的话该插件会处于半残状态`,
      'Restart',
    )
    setTimeout(() => {
      const bot = (globalThis as any).Bot
      if (typeof bot?.restart === 'function') {
        /** 走 #重启 同一条路径：先落盘计数与 redis，再由守护进程/pm2 拉起 */
        Promise.resolve(bot.restart()).catch(() => process.exit(RELOAD_RESTART_CODE))
        return
      }
      process.exit(RELOAD_RESTART_CODE)
    }, 2000)
  }

  /* ==================== 热重载 ==================== */

  /** plugins/ 下的相对路径 → 插件 key，命名与 getPlugins 保持一致 */
  private keyOf(rel: string): string | null {
    const parts = rel.split('/')
    if (parts.length < 2) return null
    if (parts.length === 2) return parts[1] === 'index.js' ? parts[0] : rel
    /** apps/ 等更深层的文件归属到其插件目录 */
    return parts[0]
  }

  /** 适配器 / 胶水文件（无插件类） */
  isInert(key: string) {
    return this.inertFiles.has(key)
  }

  /**
   * 找出这个文件真正属于哪个**已加载**的插件（用于热重载分类）。
   *
   * `keyOf` 的规则是「两层算自己、更深归第一层」，对标准布局（`plugins/<插件>/apps/x.js`）没错；
   * 但遇到「扁平目录里再套目录」——`plugins/example/devdrill/index.js`，而 `example/` 本身没有
   * index.js（它是"加载目录下所有 js"的形态）—— 就会算成 `example`，于是改 / 删一个文件会动到
   * 整个 `example` 目录下的所有插件。这里在已加载的 key 里挑最长的祖先 key 兜住这类布局。
   */
  private ownerKeyOf(rel: string, fallback: string): string {
    let best = ''
    const consider = (key: string) => {
      if (key.length > best.length && (rel === key || rel.startsWith(`${key}/`))) best = key
    }
    for (const key of this.pluginCountMap.keys()) consider(key)
    for (const i of this.priority) consider(i.key)
    return best || fallback
  }

  private isLoaded(key: string) {
    /**
     * 注意用**计数 > 0**而不是 `has`：importPlugin 一进来就 `pluginCountMap.set(name, 0)`，
     * 加载失败（例如 key 指向不存在的 index.js）时会留下一个 0 的记录。
     * 用 `has` 判断的话，这种"失败的 key"会被当成已加载，之后删它下面的文件就会去
     * 卸载一个根本不存在的插件（实测把 example 目录下的变更全算到 key `example` 上）。
     */
    return (this.pluginCountMap.get(key) ?? 0) > 0 || this.priority.some(i => i.key === key)
  }

  /** 文件是否存在（删除事件里判断"插件目录还在不在"） */
  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  /** 按 key 加载；已加载则重载 */
  async reloadKey(key: string) {
    if (this.isLoaded(key)) return this.changePlugin(key)
    return this.loadKey(key)
  }

  private async loadKey(key: string) {
    /** 新增/补漏加载也换一代：与磁盘上已改过的文件保持一致 */
    bumpModuleGeneration()
    const target = key.endsWith('.js') ? key : `${key}/index.js`
    /** 同样是「新求值出来的一张图」，求值失败也要能被恢复逻辑认出来 */
    beginReload()
    let success: boolean
    try {
      success = await this.importPlugin({ name: key, path: `../../${this.dir}/${target}?${Date.now()}` })
    } finally {
      endReload()
    }
    this.sortPriority()
    this.buildEventIndex()
    this.createTask()
    if (!success) this.recoverReload(key)
  }

  /**
   * 这个 .js 变化值不值得**重载整个插件**
   *
   * 起因（实测 OOM 事故）：miao 的 `components/Cfg.js` 在模块求值时就 `saveCfg()`，
   * 也就是**每次 miao 被求值都会重写 `plugins/miao-plugin/config/cfg.js`**；
   * 而框架对 `plugins/**` 下任何 `.js` 变化都重载整个插件 → 重载又写一遍 →
   * 2 秒一轮的自激循环，每轮都新求值一整张模块图（ESM 缓存不释放旧图）→ 30 秒打爆 1GB。
   *
   * 规则：
   * - 插件**私有配置 / 数据目录**（`config/`、`data/`、`resources/`、`temp/`）里的 `.js`，
   *   只有"看起来是插件模块"（有插件结构：plugin 类 / rule / apps / task / handler / fnc / reg…）
   *   才重载 —— 纯 `export const xxx = false` 这种配置/数据不重载。
   * - 其它位置（入口、`apps/`、`lib/`、`model/`、自建目录）一律照旧重载，
   *   插件开发者改工具函数、改子应用都能即时生效。
   * - `unlink` 不判定（文件已经没了，读不到内容；删除本来就少见，保守处理）。
   */
  private isPluginModule(content: string): boolean {
    return /extends\s+(plugin|JiuLiPlugin|BasePlugin|JiuLiBase)\b|definePlugin\s*\(|module\.exports|export\s+default\s+class|export\s+(const|let|var)\s+(rule|apps|task|accept|handler|hooks|socket)\b|export\s*\{[^}]*\b(rule|apps|task|accept|handler)\b|\b(fnc|reg|priority|permission)\s*:/.test(
      content,
    )
  }

  /** 见 isPluginModule 注释；这里只负责「读文件 + 决定」 */
  private async shouldReloadJs(rel: string, fullPath: string): Promise<boolean> {
    /** 代码目录：直接放行 */
    if (!/(^|\/)(config|data|resources|temp)\//.test(rel)) return true
    try {
      /** 只读头部：配置文件很小，真有大文件也不至于把内存搭进去 */
      return this.isPluginModule((await fs.readFile(fullPath, 'utf8')).slice(0, 200_000))
    } catch {
      /** 读不到（权限 / 刚被删）就当配置处理，不重载 */
      return false
    }
  }

  /**
   * 记录一次重载；**机器自激**的重载短时间内反复出现就熔断（暂停它的重载监听）
   *
   * 只统计"文件是插件自己在加载时写出来的"那种重载：
   * - 人工在编辑器里改文件（mtime 落在所有求值窗口之外）**不计入** ——
   *   开发者一分钟里存十几次代码是常态，被当成风暴暂停掉就没法调插件了；
   * - 插件边加载边改写文件（miao 的 config/cfg.js 就是）才算，因为这才是会 OOM 的自激循环：
   *   每轮重载都会永久占用一张模块图（ESM 缓存不释放），顶着循环跑几十秒就能打爆内存。
   *
   * 另外还有一条"全局频率"兜底：任何来源的重载一分钟超过 reload_global_limit 次，
   * 说明这频率不像人在改文件，打一条 ERROR 提醒（不暂停，避免误伤批量格式化之类）。
   */
  private noteReload(key: string, machineOwner?: string | null) {
    // 阈值走配置，方便按机器/插件调松紧；配 0 表示关掉熔断（只留结构判定）
    const perf: any = cfg.getPerf()
    const windowSec = Math.max(1, Number(perf.reload_window ?? 60) || 60)
    const limit = Math.max(0, Number(perf.reload_limit ?? 5) || 0)
    const windowMs = windowSec * 1000
    const now = Date.now()

    this.globalReloadMarks = this.globalReloadMarks.filter(t => now - t < windowMs)
    this.globalReloadMarks.push(now)

    if (machineOwner && limit) {
      const marks = (this.reloadMarks.get(key) || []).filter(t => now - t < windowMs)
      marks.push(now)
      this.reloadMarks.set(key, marks)
      if (marks.length >= limit) {
        this.pausedReload.add(key)
        this.reloadMarks.delete(key)
        util.makeLog(
          'error',
          `插件 ${logger.cyan(key)} 在 ${windowSec} 秒内自激重载了 ${marks.length} 次（文件是它自己在加载时改写的），已**暂停它的重载监听**\n` +
            '  常见原因：插件在模块顶层把配置 / 数据写回自己目录下的 .js（例如 miao 的 config/cfg.js），形成"改文件 → 重载 → 又改文件"的循环；\n' +
            '  每轮重载都会永久占用一张模块图（ESM 缓存不释放），顶着循环跑几十秒就能把内存打爆。\n' +
            '  处理：修好根因后发 #重载 <插件名> 强制刷新（会自动恢复监听）；内存已经涨上去的话直接 #重启。\n' +
            '  阈值可调：config/config/jiuli.yaml → perf.reload_limit / perf.reload_window（0 关闭熔断）。',
          'Plugin',
        )
        return
      }
    }

    /** 全局兜底：只告警不暂停（人工改文件不该被拦，批量格式化也可能一次改很多插件） */
    const globalLimit = Math.max(0, Number(perf.reload_global_limit ?? 12) || 0)
    if (globalLimit && this.globalReloadMarks.length >= globalLimit && now - this.lastGlobalRateWarn > 60_000) {
      this.lastGlobalRateWarn = now
      const busiest = [...this.reloadMarks.entries()]
        .map(([k, v]) => [k, v.filter(t => now - t < windowMs).length] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .filter(([, n]) => n > 1)
        .map(([k, n]) => `${k}(${n} 次)`)
      util.makeLog(
        'error',
        `一分钟内热重载 ${this.globalReloadMarks.length} 次，远超人工改文件的频率${busiest.length ? ` · 反复重载：${busiest.join(' · ')}` : ''}\n` +
          '  如果内存持续上涨、或某个插件的内容被反复改写：查它是不是在加载时写自己的文件（改好即自愈）；\n' +
          '  也可以临时 config/config/bot.yaml → file_watch: false 关掉热重载，或调小 perf.reload_limit。',
        'Plugin',
      )
    }
  }

  /**
   * 这个文件的修改时间是"机器写的"吗：落在最近某次插件模块求值的窗口内。
   *
   * 插件在模块顶层改写文件时，写入必然发生在求值期间 → mtime 落在窗口里；
   * 人在编辑器里保存，mtime 落在窗口里（毫秒级）的概率极低 —— 这就是区分
   * "开发者连续改代码" 与 "插件自激重载风暴" 的依据。
   *
   * @returns 窗口属于哪个插件（key）；null = 没落在任何窗口里（视为人工改动）
   */
  private async machineWriteOwner(fullPath: string): Promise<string | null> {
    if (!this.loadWindows.size) return null
    const cutoff = Date.now() - 10_000
    for (const [k, w] of this.loadWindows) if (w.end < cutoff) this.loadWindows.delete(k)
    if (!this.loadWindows.size) return null
    let mtime: number
    try {
      mtime = (await fs.stat(fullPath)).mtimeMs
    } catch {
      return null
    }
    for (const [owner, w] of this.loadWindows)
      if (mtime >= w.start - 50 && mtime <= w.end + 50) return owner
    return null
  }


  /** 当前因重载风暴被暂停监听的插件 key（#重载 提示用） */
  get pausedReloadList(): string[] {
    return [...this.pausedReload]
  }

  /**
   * 解除重载熔断：手动 `#重载 <插件名>` 是明确的用户动作，理应重新监听。
   *
   * 为什么不放在 changePlugin 里自动清：watcher 触发的重载也走 changePlugin，
   * 一进一出就把计数清了，熔断永远不会触发。所以只由指令层显式调用。
   */
  resumeReload(key?: string) {
    const targets = key ? (this.pausedReload.has(key) ? [key] : []) : [...this.pausedReload]
    if (!targets.length) return false
    for (const k of targets) {
      this.pausedReload.delete(k)
      this.reloadMarks.delete(k)
    }
    /** 让"自激改写"的 error 提示重新出现一次，方便确认根因还没修 */
    this.selfWriteWarned.clear()
    util.makeLog('mark', `已恢复重载监听：${targets.map(k => logger.cyan(k)).join(' · ')}`, 'Plugin')
    return true
  }

  /**
   * 监听整个 plugins/ 目录：新增 js 自动加载、修改自动重载、删除自动卸载
   * 非 js 资源变化不触发重载（渲染层自带缓存失效）
   */
  watchPlugins() {
    if (this.watcher['#root']) return
    const root = `./${this.dir}`
    /**
     * 忽略 node_modules/.git：clone 第三方插件时避免扫描上万文件导致重载风暴。
     *
     * 还要**在扫描阶段就把非 .js 文件挡掉**：chokidar 4 会给树里每个文件都建一个
     * inotify watch（实测 4 目录 / 60 文件的树 = 64 个 watch），而下面的处理函数
     * 只认 .js（见 processEvent），图片 / 资源被 watch 了也永远不会触发重载。
     * 代价却是实打实的：本机 plugins/ 下 depth≤4 有 4000+ 个非 .js 文件
     * （png / jpg / sample / yaml…），对应上百 MB 常驻内存；而
     * `GloryOfKings-Plugin/data/imgCache` 这类缓存目录还会**随使用增长**
     * （每缓存一张远程图就多一个 watch，实测已 200MB+），等于跑得越久内存越高。
     *
     * 用 ignored 函数而不是往数组里加 `*.png` 之类的模式：扩展名是开放的，
     * 只放行 `.js` 才不会漏。stats 只对**文件**给出（chokidar 的 filterPath /
     * filterDir 两条路），目录是 undefined —— 目录必须放过，否则扫不进去。
     * 与 chokidar README 的示例写法一致：
     * `ignored: (f, stats) => stats?.isFile() && !f.endsWith('.js')`
     */
    const ignoredPatterns = [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, /[\\/]\.git$/, /[\\/]temp[\\/]/]
    const watcher = chokidar.watch(root, {
      depth: 4,
      ignoreInitial: true,
      ignored: (p: string, stats?: any) =>
        ignoredPatterns.some(re => re.test(p)) || (stats?.isFile?.() === true && !p.endsWith('.js')),
    })
    const Bot = (globalThis as any).Bot

    const relOf = (file: string) => path.relative(path.resolve(root), path.resolve(file)).replace(/\\/g, '/')

    /**
     * 事件合并：2 秒窗口内的事件先收进待处理表，窗口结束时**逐个**处理。
     *
     * 原来每种事件各自走 `util.debounce`，而 debounce 在窗口内只保留最后一次调用 ——
     * 快速连改多个文件（IDE 的「全部保存」、脚本批量改、一次新建整个插件目录）只有最后一个
     * 会触发重载，其余静默丢掉，这也是「改了文件却没生效」的一个来源。
     * 现在按文件记下最后一个动作，到点后整批处理；同一个插件的多个文件只处理一次。
     */
    const pendingEvents = new Map<string, 'add' | 'change' | 'unlink'>()
    let flushTimer: NodeJS.Timeout | undefined

    const processEvent = async (file: string, action: 'add' | 'change' | 'unlink') => {
      const rel = relOf(file)
      if (!rel || rel.startsWith('..')) return
      if (!rel.endsWith('.js')) {
        if (action === 'change') util.makeLog('debug', `资源变化（无需重载）· ${rel}`, 'Plugin')
        return
      }
      const key = this.keyOf(rel)
      if (!key) return
      /** 真正归属的插件（keyOf 对「扁平目录里再套目录」会给成父目录，这里兜一下） */
      const owner = this.ownerKeyOf(rel, key)

      if (action === 'unlink') {
        /**
         * 删的是**嵌套文件**（apps/x.js、lib/y.js）时不能当成"整个插件被删"：
         * 插件目录还在，卸载整个插件会让用户的插件直接失联报错。
         * 只有当入口（目录插件的 index.js / 文件型插件自己的 .js）没了才算删除。
         */
        const entry = owner.endsWith('.js') ? owner : `${owner}/index.js`
        const entryExists = await this.fileExists(`./${this.dir}/${entry}`)
        /** 既不是入口、又对不上任何插件入口：这种少见布局（扁平目录里再套目录）不下手，别误删别人的插件 */
        if (rel !== entry && !entryExists) {
          util.makeLog('debug', `插件文件已删除（找不到对应插件入口，忽略）· ${rel}`, 'Plugin')
          return
        }
        if (!this.isLoaded(owner)) return
        if (rel !== entry) {
          util.makeLog('mark', `插件文件已删除 → 重载 · ${logger.cyan(rel)}（插件目录仍在，不卸载整个插件）`, 'Plugin')
          await this.changePlugin(owner)
          this.noteReload(owner, null)
          return
        }
        util.makeLog('mark', `插件已删除 → 卸载 · ${logger.cyan(rel)}`, 'Plugin')
        await this.unloadPlugin(owner)
        return
      }

      /** 配置/数据目录里的纯数据 .js 不重载（见 isPluginModule：miao 的 cfg.js 自激循环就出在这） */
      if (!(await this.shouldReloadJs(rel, file))) {
        util.makeLog('debug', `配置/数据变化（非插件模块，不重载）· ${rel}`, 'Plugin')
        return
      }

      /**
       * 归属到的 key 还没加载、而且它的入口文件也不在磁盘上（少见布局：扁平插件目录里再套目录）：
       * 这个文件不属于任何插件，硬按 key 去 import 只会刷一条加载失败，直接放着不动。
       */
      if (owner !== rel && !this.isLoaded(owner)) {
        const ownerEntry = owner.endsWith('.js') ? owner : `${owner}/index.js`
        if (!(await this.fileExists(`./${this.dir}/${ownerEntry}`))) {
          util.makeLog('debug', `插件文件变化（归属不到已存在的插件，忽略）· ${rel}`, 'Plugin')
          return
        }
      }

      /**
       * 插件自己在加载时改写的文件：**不重载**。
       *
       * 这是自激循环的通用兜底（结构判定只覆盖 config/data 目录，代码文件得靠这条）：
       * 插件加载 → 顶层改文件 → watcher 事件 → 重载 → 又改文件 ……
       * 每轮永久泄漏一张模块图，几十秒 OOM。跳过这一次，插件不会再加载，循环自然断掉。
       */
      const writer = await this.machineWriteOwner(file)
      if (writer && writer === owner) {
        const first = !this.selfWriteWarned.has(rel)
        this.selfWriteWarned.add(rel)
        util.makeLog(
          first ? 'error' : 'debug',
          `插件 ${logger.cyan(owner)} 在加载时改写了 ${logger.cyan(rel)} → 跳过本次重载（防自激循环）\n` +
            '  插件不该在自己的模块顶层写回代码 / 配置文件：这一写会触发重载、重载又写一遍。\n' +
            '  处理：把写文件挪到运行期（指令或定时任务里），或存成 config/data 下的纯数据文件（如 .json / .yaml）。',
          'Plugin',
        )
        return
      }

      /** 熔断中的插件不再重载（等 #重载 <插件名> 恢复） */
      if (this.pausedReload.has(owner)) {
        util.makeLog('debug', `插件 ${owner} 的重载监听已暂停（重载风暴熔断中），发 #重载 <插件名> 可恢复`, 'Plugin')
        return
      }

      const loaded = this.isLoaded(owner)
      util.makeLog(
        'mark',
        `插件${action === 'add' ? '新增' : '修改'} → ${loaded ? '重载' : '加载'} · ${logger.cyan(rel)}${
          writer ? `（文件由插件 ${writer} 在加载时改写）` : ''
        }`,
        'Plugin',
      )
      if (loaded) {
        await this.changePlugin(owner)
        this.noteReload(owner, writer)
      } else await this.loadKey(owner)
    }

    const flushEvents = async () => {
      flushTimer = undefined
      const batch = [...pendingEvents.entries()]
      pendingEvents.clear()
      /** 同一插件的多个文件（新建整个目录、批量保存）只处理一次 */
      const handled = new Set<string>()
      for (const [file, action] of batch) {
        const key = this.keyOf(relOf(file))
        if (key && handled.has(key)) continue
        if (key) handled.add(key)
        try {
          await processEvent(file, action)
        } catch (err) {
          util.makeLog('error', `热重载处理失败 ${logger.cyan(relOf(file))}：${String((err as any)?.message || err)}`, 'Plugin')
          util.makeLog('debug', [`${relOf(file)} 热重载失败详情`, err], 'Plugin')
        }
      }
    }

    const handle = (action: 'add' | 'change' | 'unlink') => (file: string) => {
      pendingEvents.set(file, action)
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => void flushEvents(), 2000)
      /** 不拖住退出 */
      flushTimer.unref?.()
    }

    /** chokidar 初次扫描是否完成（边扫描边铺监听，扫描期间的深层事件会丢） */
    let scanReady = false
    watcher.once('ready', () => {
      scanReady = true
    })

    Bot.once('online', () => {
      watcher.on('add', handle('add'))
      watcher.on('change', handle('change'))
      watcher.on('unlink', handle('unlink'))
      watcher.on(
        'addDir',
        util.debounce(async (dir: string) => {
          const rel = relOf(dir)
          if (!rel || rel.startsWith('..') || rel.includes('/')) return
          util.makeLog('debug', `检测到新插件目录 · ${rel}（放入 .js 文件后自动加载）`, 'Plugin')
        }, 2000) as any,
      )
      /**
       * 「热重载已开启」这句要在**初次扫描完成之后**才打：chokidar 是边扫描边铺监听的，
       * 真实 plugins/ 目录上千个文件、Windows 上要十几秒，扫描期间改深层文件（如插件的
       * apps/x.js）事件根本不会产生。原来在线时就报「已开启」，用户照着改文件却毫无反应，
       * 只能怀疑框架坏了。现在等 chokidar 的 ready。
       */
      const announce = () =>
        util.makeLog('info', '热重载已开启（plugins/ 下新增 / 修改 / 删除 js 即时生效）', 'Plugin')
      if (scanReady) announce()
      else watcher.once('ready', announce)
    })
    this.watcher['#root'] = watcher
  }

  /** 兼容旧调用 */
  watch() {
    this.watchPlugins()
  }

  /** closeWatchers：file_watch=false 时改由 config 用 NullWatcher 接管 */
  closeWatchers() {
    for (const i in this.watcher) {
      this.watcher[i]?.close?.()
      delete this.watcher[i]
    }
  }
}

export default new PluginsLoader()
export { PluginsLoader }
