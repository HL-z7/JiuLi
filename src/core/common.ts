/** common 工具（兼容云崽 lib/common/common.js） */
import fs from 'node:fs'

/** 发送私聊消息 */
export function relpyPrivate(user_id: any, msg: any, bot_id?: any) {
  return (globalThis as any).Bot.sendFriendMsg(bot_id, user_id, msg)
}

export function sleep(...args: any[]) {
  return (globalThis as any).Bot.sleep(...args)
}

/** 下载失败时记录日志并返回 false */
export async function downFile(url: string, file: string, opts?: any) {
  try {
    return await (globalThis as any).Bot.download(url, file, opts)
  } catch (err) {
    ;(globalThis as any).logger?.error?.('下载文件错误', err)
    return false
  }
}

export function mkdirs(dirname: string) {
  if (fs.existsSync(dirname)) return true
  fs.mkdirSync(dirname, { recursive: true })
  return true
}

/** 优先使用群/好友会话自带的转发实现 */
export function makeForwardMsg(e: any, msg: any = [], dec?: string) {
  const forwardMsg = []
  if (dec) forwardMsg.push({ message: dec })
  for (const message of Array.isArray(msg) ? msg : [msg]) forwardMsg.push({ message })

  if (e?.group?.makeForwardMsg) return e.group.makeForwardMsg(forwardMsg)
  if (e?.friend?.makeForwardMsg) return e.friend.makeForwardMsg(forwardMsg)
  return (globalThis as any).Bot.makeForwardMsg(forwardMsg)
}

export default { relpyPrivate, sleep, downFile, mkdirs, makeForwardMsg }
