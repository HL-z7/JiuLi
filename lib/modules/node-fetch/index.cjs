/**
 * CJS 入口：`require('node-fetch')` 必须直接拿到可调用的 fetch。
 * 只给 exports 的 import 条件时，require(ESM) 会返回命名空间对象，调用即 TypeError。
 */
module.exports = globalThis.fetch
for (const name of ['Blob', 'File', 'FormData', 'Headers', 'Request', 'Response'])
  if (globalThis[name]) module.exports[name] = globalThis[name]
