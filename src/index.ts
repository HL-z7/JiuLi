/**
 * JiuLi 原生插件 API（`import { ... } from 'jiuli'`）
 * 三种形态并存：旧插件 extends plugin、原生类 extends JiuLiPlugin、原生 DSL definePlugin。
 */
import fs from 'node:fs'
import BasePlugin from './core/plugin.js'
import type { JiuLiEvent, Rule, Task, HandlerConfig, PluginOptions, RenderOptions } from './core/types.js'
import { logger, chalk } from './core/log.js'
import cfg from './core/config/index.js'

export type {
  JiuLiEvent,
  Rule,
  Task,
  HandlerConfig,
  PluginOptions,
  RenderOptions,
  Adapter,
  Segment,
  Sender,
  ReplyData,
  PluginMetric,
} from './core/types.js'

export { logger, chalk }
export { default as cfg } from './core/config/index.js'
export { default as util } from './core/util.js'
export { default as segment, getSegment } from './core/segment.js'
export { default as metrics } from './core/metrics.js'
export { default as Runtime } from './core/runtime.js'
export { default as Handler } from './core/handler.js'
export { default as renderService } from './core/render/index.js'
export { default as common } from './core/common.js'
export { default as makeConfig, watcher as configWatcher } from './core/plugin-config.js'

/** 当前 Bot 实例 */
export function getBot(): any {
  return (globalThis as any).Bot
}

/** JiuLi 原生插件基类 */
export class JiuLiPlugin extends BasePlugin {
  /** 插件目录名，由 loader 注入，用于定位渲染与数据目录 */
  declare __key: string
  declare e: JiuLiEvent

  /** 插件私有数据目录 data/plugins/<插件名>，首次访问自动创建 */
  get dataDir(): string {
    const dir = `data/plugins/${this.__key || this.name}`
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 插件 resources/ 路径前缀，渲染模板中以 pluResPath 引用 */
  get resDir(): string {
    return `plugins/${this.__key || this.name}/resources/`
  }

  /**
   * 渲染模板为图片，返回可直接 e.reply() 的内容，失败返回 false
   * @param tpl 相对插件 resources 目录的模板路径，如 'help/index'
   */
  async render(tpl: string, data: any = {}, opts: RenderOptions = {}) {
    const plugin = this.__key || this.name
    if (this.e?.runtime?.render) return this.e.runtime.render(plugin, tpl, data, { retType: 'base64', ...opts })

    /** 未经分发（如定时任务）时的兜底渲染 */
    const { default: renderService } = await import('./core/render/index.js')
    const paths = String(tpl).replace(/\.html$/, '').split('/').filter(Boolean)
    const up = '../'.repeat(paths.length)
    const tplData = {
      sys: { scale: 1 },
      ...data,
      _plugin: plugin,
      _htmlPath: paths.join('/'),
      pluResPath: `../../../${up}plugins/${plugin}/resources/`,
      _res_path: `../../../${up}plugins/${plugin}/resources/`,
      tplFile: `./plugins/${plugin}/resources/${paths.join('/')}.html`,
      saveId: data.saveId || paths[paths.length - 1],
    }
    const img = await renderService.render(`${plugin}/${paths.join('/')}`, tplData)
    if (!img) return false
    const { default: segment } = await import('./core/segment.js')
    return segment.image(img)
  }

  /** 渲染模板并返回 base64:// 字符串，失败返回 false */
  async renderBase64(tpl: string, data: any = {}, opts: RenderOptions = {}) {
    const ret: any = await this.render(tpl, data, opts)
    if (!ret) return false
    const file = ret?.file ?? ret?.data?.file ?? ret
    if (Buffer.isBuffer(file)) return `base64://${file.toString('base64')}`
    if (typeof file === 'string') return file.startsWith('base64://') ? file : `base64://${file}`
    return false
  }
}

/* ==================== 函数 DSL ==================== */

export interface CommandOptions {
  event?: string
  permission?: 'master' | 'owner' | 'admin' | 'all' | string
  log?: boolean
  priority?: number
  name?: string
}

export interface AppDescriptor {
  __type: 'command' | 'task' | 'accept' | 'handler' | 'hook'
  [key: string]: any
}

/** 分发前钩子：候选插件按优先级依次执行，返回 false 拦截本次分发（JiuLi 原生扩展） */
export function beforeMessage(fnc: (e: JiuLiEvent) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'hook', stage: 'beforeMessage', fnc, ...options }
}

/** 分发后钩子：无论是否命中插件都会执行 */
export function afterMessage(fnc: (e: JiuLiEvent) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'hook', stage: 'afterMessage', fnc, ...options }
}

/** 命令：正则 → 处理函数；fnc 返回 false 时继续匹配后续规则 */
export function command(
  reg: RegExp | string,
  fnc: (e: JiuLiEvent, match?: RegExpMatchArray) => any,
  options: CommandOptions = {},
): AppDescriptor {
  return { __type: 'command', reg, fnc, ...options }
}

/** 定时任务；options.log=false 不显示日志，options.skip 为上次未完成时跳过 */
export function task(
  cron: string,
  fnc: (...args: any[]) => any,
  options: { name?: string; log?: boolean; skip?: boolean } = {},
): AppDescriptor {
  return { __type: 'task', cron, fnc, ...options }
}

/** 事件监听（通知/请求等），等价于插件级 accept；event 如 notice.group.poke */
export function accept(event: string, fnc: (e: JiuLiEvent) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'accept', event, fnc, ...options }
}

/** 注册跨插件 handler，其他插件以 e.runtime.handler.call(key, e, args) 调用 */
export function handler(key: string, fnc: (...args: any[]) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'handler', key, fnc, ...options }
}

export interface DefinePluginOptions {
  name: string
  dsc?: string
  priority?: number
  /** 插件级事件，默认取第一个 accept / command 的 event，否则 message */
  event?: string
  apps?: AppDescriptor[]
}

/** 定义插件，返回可被内核加载的类；apps 中的描述符会被转成插件规则 */
export function definePlugin(options: DefinePluginOptions) {
  const { name = 'jiuli-plugin', dsc = '无', priority = 5000, apps = [] } = options
  const commands = apps.filter(a => a.__type === 'command')
  const tasks = apps.filter(a => a.__type === 'task')
  const accepts = apps.filter(a => a.__type === 'accept')
  const handlers = apps.filter(a => a.__type === 'handler')
  const hooks = apps.filter(a => a.__type === 'hook')
  const pluginEvent =
    options.event ??
    accepts[0]?.event ??
    commands.find(c => c.event)?.event ??
    tasks.find(t => t.event)?.event ??
    'message'

  const named = (fn: any, fnName: string) => {
    try {
      Object.defineProperty(fn, 'name', { value: fnName, configurable: true })
    } catch {}
    return fn
  }

  return class extends JiuLiPlugin {
    constructor(e?: any) {
      super({ name, dsc, priority, event: pluginEvent } as PluginOptions)
      void e

      this.rule = commands.map(c => ({
        reg: c.reg,
        event: c.event,
        permission: c.permission,
        log: c.log,
        priority: c.priority,
        fnc: named((ev: JiuLiEvent, match?: RegExpMatchArray) => c.fnc.call(this, ev, match), c.name || 'command'),
      })) as Rule[]

      this.task = tasks.map(t => ({
        name: t.name ?? name,
        cron: t.cron,
        log: t.log,
        fnc: named((...args: any[]) => t.fnc.call(this, ...args), t.name || 'task'),
      })) as Task[]

      if (accepts.length) {
        this.accept = named((ev: JiuLiEvent) => accepts[0].fnc.call(this, ev), `${name}:accept`)
      }

      /** 钩子绑定为同名方法，内核分发前后自动调用 */
      for (const h of hooks) (this as any)[h.stage] = h.fnc.bind(this)

      if (handlers.length) {
        this.handler = handlers.map(h => ({
          key: h.key,
          priority: h.priority,
          fnc: named((...args: any[]) => h.fnc.call(this, ...args), `${name}:${h.key}`),
        })) as HandlerConfig[]
        this.namespace ||= name
      }
    }

    /** DSL 形态下插件级 accept（动态注入） */
    declare accept?: (e: JiuLiEvent) => any
  }
}

/** 默认导出：常用 API 集合，方便 `import jiuli from 'jiuli'` */
export default {
  JiuLiPlugin,
  definePlugin,
  command,
  task,
  accept,
  handler,
  beforeMessage,
  afterMessage,
  getBot,
  cfg,
  logger,
}
