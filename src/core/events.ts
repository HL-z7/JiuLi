/** 事件监听器基类与加载器（兼容云崽 lib/listener/listener.js） */
import fs from 'node:fs/promises'
import util from './util.js'
import PluginsLoader from './loader.js'

export default class EventListener {
  prefix: string
  event: string | string[]
  once: boolean
  plugins = PluginsLoader

  /**
   * @param data.prefix 事件名称前缀
   * @param data.event 监听的事件
   * @param data.once 是否只监听一次
   */
  constructor(data: { prefix?: string; event: string | string[]; once?: boolean }) {
    this.prefix = data.prefix || ''
    this.event = data.event
    this.once = data.once || false
  }
}

export class ListenerLoader {
  /** 已执行过 load() 的适配器：补拉/重载后新增的才需要再加载，避免重复初始化 */
  private loadedAdapters = new WeakSet<object>()

  async load() {
    util.makeLog('info', '加载事件监听器 lib/events/ …', 'Listener')
    const files = (await fs.readdir('./lib/events').catch(() => [] as string[])).filter(f => f.endsWith('.js'))
    const eventPromise = files.map(file => this.loadEvent(file))
    await Promise.allSettled(eventPromise)
    util.makeLog('info', `事件监听器 ${eventPromise.length} 个`, 'Listener')

    await this.loadAdapters()
  }

  /**
   * 加载还没初始化过的适配器。
   *
   * `Bot.adapter` 由适配器插件在模块顶层 push，超时被牵连、之后补拉回来的适配器文件
   * 只完成了 import；`load()` 只在启动时跑一次，缺了这一步它们就永远不会被初始化。
   * 幂等：已加载过的不重复 `load()`（否则会重复起连接/重复注册路由）。
   */
  async loadAdapters() {
    const Bot = (globalThis as any).Bot
    const adapters = [...(Bot.adapter as any[])].filter(a => !this.loadedAdapters.has(a))
    if (!adapters.length) return
    util.makeLog('info', '加载适配器 …', 'Adapter')
    const adapterPromise = adapters.map(adapter => this.loadAdapter(adapter))
    await Promise.allSettled(adapterPromise)
    const names = adapters.map((a: any) => `${a.name}(${a.id})`).join(' · ')
    util.makeLog('info', `适配器 ${adapters.length} 个${names ? ` · ${names}` : ''}`, 'Adapter')
  }

  async loadEvent(file: string) {
    util.makeLog('debug', [`加载监听事件 ${file}`], 'Listener')
    try {
      let listener: any = await import(`../events/${file}`)
      if (!listener.default) return
      listener = new listener.default()
      const Bot = (globalThis as any).Bot
      const on = listener.once ? 'once' : 'on'

      for (const type of Array.isArray(listener.event) ? listener.event : [listener.event]) {
        const fnc = listener[type] ? type : 'execute'
        Bot[on](listener.prefix + type, listener[fnc].bind(listener))
      }
    } catch (err) {
      util.makeLog('error', [`监听事件加载错误 ${file}`, err], 'Listener')
    }
  }

  async loadAdapter(adapter: any) {
    util.makeLog('debug', [`加载适配器 ${adapter.name}(${adapter.id})`], 'Adapter')
    /** 先登记再 load：load() 抛错也不重试，避免重复起连接 */
    this.loadedAdapters.add(adapter)
    /**
     * 适配器的 load() 经常带登录逻辑（等扫码、等验证码、等 token 刷新），账号掉线时会一直不 resolve。
     * 以前这里直接 await，一个账号登不上整台机器就停在「未就绪」，面板和协议端全部 503。
     * 超时后先放行启动，适配器自己在后台继续初始化。
     */
    const timeout = Math.max(1000, Number((globalThis as any).cfg?.bot?.plugin_load_timeout) * 1000 || 60000)
    let timer: NodeJS.Timeout
    const expired = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeout)
      timer.unref?.()
    })
    const loaded = adapter
      .load()
      .then(() => true)
      .catch((err: any) => {
        util.makeLog('error', [`适配器加载错误 ${adapter.name}(${adapter.id})`, err], 'Adapter')
        return true
      })
    const done = await Promise.race([loaded, expired])
    clearTimeout(timer!)
    if (!done)
      util.makeLog(
        'warn',
        [`适配器 ${adapter.name}(${adapter.id}) 初始化超过 ${Math.round(timeout / 1000)} 秒，先继续启动，它在后台继续完成`],
        'Adapter',
      )
  }
}

export const listenerLoader = new ListenerLoader()

export async function loadEvents() {
  return listenerLoader.load()
}
