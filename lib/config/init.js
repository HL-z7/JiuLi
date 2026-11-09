/** 兼容层：启动初始化；内核 start() 已包含同等流程，此处仅供手工调用 init() 的旧代码 */
import { setLog } from '../core/log.js'
import { ensureDirs, initRedisOrFallback } from '../core/start.js'

export default async function init() {
  setLog()
  await ensureDirs()
  await initRedisOrFallback()
}
