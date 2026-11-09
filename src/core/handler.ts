/** 跨插件 handler 总线（兼容云崽 Handler） */
import { logger } from './log.js'
import util from './util.js'

interface HandlerItem {
  priority: number
  fn: (...args: any[]) => any
  ns: string
  self: any
  key: string
}

const events: Record<string, HandlerItem[]> = {}

const Handler = {
  add(cfg: { ns: string; fn: any; self?: any; priority?: number; key?: string; event?: string }) {
    const { ns, fn, self, priority = 500 } = cfg
    const key = cfg.key || cfg.event
    if (!key || !fn) return
    Handler.del(ns, key)
    util.makeLog('mark', `注册 · ${logger.cyan(key)} · 来自 ${ns} · 优先级 ${priority}`, 'Handler')
    events[key] = events[key] || []
    events[key].push({ priority, fn, ns, self, key })
    events[key].sort((a, b) => a.priority - b.priority)
  },

  del(ns: string, key = '') {
    if (!key) {
      for (const i in events) Handler.del(ns, i)
      return
    }
    if (!events[key]) return
    const before = events[key].length
    events[key] = events[key].filter(handler => handler.ns !== ns)
    if (events[key].length !== before) util.makeLog('debug', `移除 · ${key} · 来自 ${ns}`, 'Handler')
    if (!events[key].length) delete events[key]
  },

  async callAll(key: string, e: any, args?: any) {
    return Handler.call(key, e, args, true)
  },

  async call(key: string, e: any, args?: any, allHandler = false) {
    let ret
    for (const obj of events[key] ?? []) {
      let done = true
      const reject = (msg = '') => {
        if (msg) util.makeLog('mark', `被拒绝 · ${key} · 来自 ${obj.ns} · ${msg}`, 'Handler')
        done = false
      }
      const start = Date.now()
      ret = await obj.fn.call(obj.self, e, args, reject)
      if (done && !allHandler) {
        util.makeLog('mark', `完成 · ${logger.cyan(key)} · 来自 ${obj.ns} · ${Date.now() - start}ms`, 'Handler')
        return ret
      }
    }
    return ret
  },

  has(key: string) {
    return !!events[key]
  },

  list() {
    return events
  },
}

export default Handler
