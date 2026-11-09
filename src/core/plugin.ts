/** 插件基类：兼容云崽 `extends plugin`，也是 JiuLi 原生类形态插件的基类 */
import type { JiuLiEvent, PluginOptions, Rule, Task, HandlerConfig } from './types.js'

const stateArr: Record<string, Record<string, any>> = {}
const SymbolTimeout = Symbol('Timeout')
const SymbolResolve = Symbol('Resolve')

export default class plugin {
  name: string
  dsc: string
  event: string
  /** 数字越小优先级越高 */
  priority: number
  task: Task | Task[]
  rule: Rule[]
  handler?: HandlerConfig | HandlerConfig[]
  namespace?: string

  /** 当前事件，由 loader 注入 */
  e!: JiuLiEvent
  /** 旧插件常以 this.group_id / this.user_id 等简写访问上下文，由 loader 挂载 */
  [key: string]: any

  constructor({
    name = 'your-plugin',
    dsc = '无',
    handler,
    namespace,
    event = 'message',
    priority = 5000,
    task = { name: '', fnc: '', cron: '' },
    rule = [],
  }: PluginOptions = {}) {
    this.name = name
    this.dsc = dsc
    this.event = event
    this.priority = priority
    this.task = task
    this.rule = rule

    if (handler) {
      this.handler = handler
      this.namespace = namespace || ''
    }
  }

  /** 插件加载时调用，返回 "return" 可跳过加载；原生插件覆盖 onLoad()，由本方法转发 */
  async init(): Promise<any> {
    if (typeof (this as any).onLoad === 'function') return (this as any).onLoad()
    return undefined
  }

  /** 首次调用以 defaults 生成 config/<插件名>.yaml，之后复用同一 Promise */
  async useConfig(defaults: Record<string, any> = {}, opts: any = {}) {
    const name = opts.name || (this as any).__key || this.name
    if (!this._configPromise) {
      const { default: makeConfig } = await import('./plugin-config.js')
      this._configPromise = makeConfig(name, defaults, opts.keep || {}, { watch: true, ...opts })
    }
    return this._configPromise
  }
  _configPromise?: Promise<any>

  /**
   * 回复消息
   * @param msg 发送的消息
   * @param quote 是否引用回复
   * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
   * @param data.at 是否at用户
   */
  reply(msg: any = '', quote = false, data: any = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  conKey(isGroup = false) {
    return `${this.name}.${this.self_id || this.e.self_id}.${
      isGroup ? this.group_id || this.e.group_id : this.user_id || this.e.user_id
    }`
  }

  /**
   * 设置上下文
   * @param type 执行方法
   * @param isGroup 是否群聊
   * @param time 操作时间（秒）
   * @param timeout 操作超时回复
   */
  setContext(type: string, isGroup?: boolean, time = 120, timeout = '操作超时已取消') {
    const key = this.conKey(isGroup)
    stateArr[key] ??= {}
    const oldContext = stateArr[key][type]
    if (oldContext) {
      clearTimeout(oldContext[SymbolTimeout])
      oldContext[SymbolResolve]?.(false)
    }

    const context = this.e as any
    stateArr[key][type] = context
    if (time)
      context[SymbolTimeout] = setTimeout(() => {
        if (stateArr[key]?.[type] !== context) return
        const resolve = context[SymbolResolve]
        delete stateArr[key][type]
        if (!Object.keys(stateArr[key]).length) delete stateArr[key]
        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    return context
  }

  getContext(type?: string, isGroup?: boolean) {
    if (type) return stateArr[this.conKey(isGroup)]?.[type]
    return stateArr[this.conKey(isGroup)]
  }

  finish(type: string, isGroup?: boolean) {
    const key = this.conKey(isGroup)
    const context = stateArr[key]?.[type]
    if (context) {
      clearTimeout(context[SymbolTimeout])
      delete stateArr[key][type]
      if (!Object.keys(stateArr[key]).length) delete stateArr[key]
    }
  }

  awaitContext(...args: any[]) {
    return new Promise(resolve => ((this.setContext('resolveContext', ...args) as any)[SymbolResolve] = resolve))
  }

  resolveContext(context: any) {
    /** 按上下文对象身份收尾：原先只收用户级，群级等待结束后会继续拦消息直到超时 */
    for (const isGroup of [false, true])
      if (this.getContext('resolveContext', isGroup) === context) this.finish('resolveContext', isGroup)
    context?.[SymbolResolve]?.(this.e)
  }

  /** 渲染并发送图片；优先 miao-plugin 的 Common.render，不可用时走内核渲染 */
  async renderImg(pluginName: string, tpl: string, data: any = {}, cfg: any = {}) {
    const spec = '#miao'
    try {
      const miao: any = await import(spec)
      return miao.Common.render(pluginName, tpl, data, { ...cfg, e: this.e })
    } catch {
      const Runtime = (await import('./runtime.js')).default
      const runtime = this.e?.runtime ?? Runtime.attach(this.e)
      return runtime.render(pluginName, tpl, data, { ...cfg })
    }
  }
}

export { stateArr }
