/**
 * CJS 入口：兼容 `const { segment } = require('oicq')`。
 *
 * segment 本体是 ESM 模块（lib/core/segment.js），且框架启动时会挂到 globalThis。
 * 惰性取值，避免在插件依赖图加载期去 require 整张 core 模块图。
 *
 * Node 22.12+ 可直接 require(ESM)；更老的 Node 上 require(ESM) 不可用，
 * 此时只能取 globalThis.segment（框架启动后一定有），取不到就是 undefined —— 不静默改写源码。
 */
const path = require('node:path')

let loaded = false
let cached
function resolveSegment() {
  if (globalThis.segment) return globalThis.segment
  if (loaded) return cached
  loaded = true
  try {
    const mod = require(path.join(__dirname, '..', '..', 'core', 'segment.js'))
    cached = mod?.default ?? mod
  } catch {
    cached = undefined
  }
  return cached
}

module.exports = {
  get segment() {
    return resolveSegment()
  },
}
module.exports.default = module.exports
