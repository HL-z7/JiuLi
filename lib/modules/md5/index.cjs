/** CJS 入口：`require('md5')` 必须直接拿到可调用的函数 */
const { createHash } = require('node:crypto')

module.exports = function md5(data) {
  return createHash('md5').update(data).digest('hex')
}
