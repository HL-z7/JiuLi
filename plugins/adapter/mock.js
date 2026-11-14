/**
 * JiuLi 调试适配器（Mock）
 *
 * 用途：没有真实协议端时本地开发调试。
 * 启动后注册一个假 Bot（self_id = 'mock'），支持两种注入方式：
 *
 * 1. stdin（推荐）：设置环境变量 JIULI_MOCK_STDIN=1，每行一个 JSON 事件：
 *    {"type":"message","group_id":"123456","user_id":"10001","msg":"#玖璃帮助"}
 *    {"type":"notice","notice_type":"group","sub_type":"increase","group_id":"123456","user_id":"10001"}
 *
 * 2. 代码注入：globalThis.__jiuli_mock_emit(event)
 *
 * globalThis.__jiuli_mock_sent 仅保留最近的调试记录（限量、限体积并定期过期）。
 */

import fs from 'node:fs'

/** 已发送消息记录 */
const SENT = []
globalThis.__jiuli_mock_sent = SENT
/** 撤回记录 */
const RECALL = []
globalThis.__jiuli_mock_recall = RECALL

const RECORD_LIMIT = 100
const RECORD_BYTES = 8 * 1024 * 1024
const RECORD_TTL = 60_000
const recordSizes = new WeakMap()
let recordTimer
let messageSequence = 0

function recordSize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (!value || typeof value !== 'object') return 8
  if (seen.has(value)) return 0
  seen.add(value)
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  let size = 64
  for (const key of Object.keys(value)) {
    size += Buffer.byteLength(key) + recordSize(value[key], seen)
    if (size > RECORD_BYTES) break
  }
  return size
}

function retainRecord(list, record) {
  const bytes = recordSize(record)
  // 调试记录不保留超大媒体，但发送结果仍原样返回。
  if (bytes > RECORD_BYTES) return
  recordSizes.set(record, bytes)
  list.push(record)
  let total = list.reduce((sum, item) => sum + (recordSizes.get(item) || 0), 0)
  while (list.length > RECORD_LIMIT || total > RECORD_BYTES) {
    total -= recordSizes.get(list.shift()) || 0
  }
  if (!recordTimer) {
    recordTimer = setInterval(() => {
      const cutoff = Date.now() - RECORD_TTL
      for (const records of [SENT, RECALL]) {
        while (records.length && records[0].at <= cutoff) records.shift()
      }
      if (!SENT.length && !RECALL.length) {
        clearInterval(recordTimer)
        recordTimer = undefined
      }
    }, RECORD_TTL)
    recordTimer.unref()
  }
}

const UIN = 'mock'

/** 框架版本：状态图等插件读 bot.version，mock 没有协议端版本，直接显示 JiuLi 的 */
const FRAMEWORK_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/**
 * 机器人头像：用随仓库分发的 plugins/adapter/mock-avatar.jpg，转成 data URI。
 * 走 data URI 是为了离线也能渲染（插件常把 bot.avatar 直接塞进 HTML 截图）。
 */
const AVATAR = (() => {
  try {
    const file = 'plugins/adapter/mock-avatar.jpg'
    if (!fs.existsSync(file)) return ''
    return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return ''
  }
})()

/** 成员/好友头像：假账号没有真实头像，统一给机器人这张，避免渲染出裂图 */
function avatarOf() {
  return AVATAR
}

function makeContact(type, id) {
  const contact = {
    sendMsg(msg, ...args) {
      const record = { type, id, msg, at: Date.now() }
      retainRecord(SENT, record)
      /** 内容由内核的「发 ▶」日志统一输出，这里仅在 debug 下补充原始结构 */
      Bot.makeLog('debug', `${type}:${id} · ${Bot.describeMsg ? Bot.describeMsg(msg) : typeof msg}`, 'Mock')
      /** 与云崽生态适配器一致：成功时 error 为空数组（内核不应据此判定失败） */
      return { message_id: `mock-${Date.now()}-${++messageSequence}`, error: [], ...record }
    },
    recallMsg(message_id) {
      retainRecord(RECALL, { type, id, message_id, at: Date.now() })
      Bot.makeLog('mark', `撤回 [${type}:${id}] ${message_id}`, 'Mock')
      return true
    },
    getMsg() {
      return Promise.resolve(false)
    },
    getChatHistory() {
      return Promise.resolve([])
    },
    makeForwardMsg(msg) {
      return { type: 'node', data: msg }
    },
    sendFile(file, name) {
      return this.sendMsg(segment.file(file, name))
    },
    getInfo() {
      return this
    },
  }
  /** 头像：插件渲染时常用 e.sender.avatar / getAvatarUrl() */
  if (AVATAR) {
    Object.assign(contact, {
      avatar: avatarOf(),
      getAvatarUrl: () => avatarOf(),
    })
  }
  if (type === 'group') {
    Object.assign(contact, {
      group_id: id,
      name: `测试群${id}`,
      group_name: `测试群${id}`,
      is_owner: false,
      is_admin: false,
      mute_left: 0,
      all_muted: false,
      pickMember(user_id) {
        return makeContact('member', user_id)
      },
      getMemberMap() {
        return new Map()
      },
      pokeMember() {
        return Promise.resolve(true)
      },
      quit() {
        return Promise.resolve(true)
      },
    })
  } else {
    Object.assign(contact, {
      user_id: id,
      nickname: `测试用户${id}`,
      name: `测试用户${id}`,
      poke() {
        return Promise.resolve(true)
      },
    })
  }
  return contact
}

const adapter = {
  id: 'QQ',
  name: 'Mock',
  path: 'Mock',

  load() {
    const fl = new Map()
    const gl = new Map()
    const gml = new Map()

    const bot = {
      adapter,
      uin: UIN,
      nickname: 'JiuLi-Mock',
      version: {
        id: 'Mock',
        name: 'JiuLi',
        version: `v${FRAMEWORK_VERSION}`,
      },
      avatar: AVATAR,
      getAvatarUrl: () => AVATAR,
      fl,
      gl,
      gml,
      stat: { start_time: Date.now() / 1000 },
      pickFriend(user_id) {
        return makeContact('friend', user_id)
      },
      pickGroup(group_id) {
        return makeContact('group', group_id)
      },
      pickMember(group_id, user_id) {
        return makeContact('member', user_id)
      },
      sendApi() {
        return Promise.resolve({})
      },
      login() {
        return Promise.resolve(true)
      },
      logout() {
        return Promise.resolve(true)
      },
    }

    Bot[UIN] = bot
    if (!Bot.uin.includes(UIN)) Bot.uin.push(UIN)
    Bot.makeLog('mark', `Mock 适配器已就绪，账号 ${UIN}`, 'Adapter')
    Bot.em(`connect.${UIN}`, { self_id: UIN, bot })

    /** 事件注入 */
    const emit = (ev) => {
      const self_id = ev.self_id || UIN
      if (!Bot.bots[self_id]) return false

      if (ev.type === 'notice' || ev.post_type === 'notice') {
        const notice_type = ev.notice_type || 'group'
        const sub_type = ev.sub_type || 'increase'
        Bot.em(`notice.${notice_type}.${sub_type}`, {
          post_type: 'notice',
          notice_type,
          sub_type,
          self_id,
          user_id: ev.user_id ? String(ev.user_id) : undefined,
          group_id: ev.group_id ? String(ev.group_id) : undefined,
          operator_id: ev.operator_id ? String(ev.operator_id) : undefined,
          target_id: ev.target_id ? String(ev.target_id) : undefined,
          time: Math.floor(Date.now() / 1000),
        })
        return true
      }

      if (ev.type === 'request' || ev.post_type === 'request') {
        Bot.em(`request.${ev.request_type || 'friend'}`, {
          post_type: 'request',
          request_type: ev.request_type || 'friend',
          sub_type: ev.sub_type || 'add',
          self_id,
          user_id: ev.user_id ? String(ev.user_id) : undefined,
          group_id: ev.group_id ? String(ev.group_id) : undefined,
          comment: ev.comment || '',
          flag: ev.flag || 'mock-flag',
          time: Math.floor(Date.now() / 1000),
        })
        return true
      }

      /** 默认：消息事件 */
      const group_id = ev.group_id ? String(ev.group_id) : undefined
      const message_type = group_id ? 'group' : 'private'
      const sub_type = ev.sub_type || (group_id ? 'normal' : 'friend')
      const user_id = String(ev.user_id || '10001')

      let message = ev.message
      if (!message) {
        message = [{ type: 'text', text: String(ev.msg ?? '') }]
        if (ev.atBot && group_id) message.unshift({ type: 'at', qq: self_id })
        if (ev.at && group_id) message.unshift({ type: 'at', qq: String(ev.at) })
        if (ev.image) message.push({ type: 'image', url: ev.image })
        if (ev.reply_id) message.unshift({ type: 'reply', id: String(ev.reply_id) })
      }

      Bot.em(`message.${message_type}.${sub_type}`, {
        post_type: 'message',
        message_type,
        sub_type,
        self_id,
        user_id,
        group_id,
        message_id: `mock-msg-${Date.now()}`,
        raw_message: String(ev.raw_message ?? ev.msg ?? ''),
        message,
        sender: {
          user_id,
          nickname: `测试用户${user_id}`,
          card: `测试群名片${user_id}`,
          role: ev.role || 'member',
          avatar: AVATAR,
          getAvatarUrl: () => AVATAR,
        },
        time: Math.floor(Date.now() / 1000),
      })
      return true
    }
    globalThis.__jiuli_mock_emit = emit

    /** stdin 注入 */
    if (process.env.JIULI_MOCK_STDIN) {
      import('node:readline').then(({ createInterface }) => {
        const rl = createInterface({ input: process.stdin })
        rl.on('line', line => {
          line = line.trim()
          if (!line) return
          try {
            emit(JSON.parse(line))
          } catch (err) {
            Bot.makeLog('error', ['事件解析失败', err], 'Mock')
          }
        })
        Bot.makeLog('mark', 'stdin 注入已开启，每行一个 JSON 事件', 'Mock')
      })
    }
  },
}

Bot.adapter.push(adapter)

/** 作为插件导出，便于被内核识别（非插件类，会被忽略） */
export { adapter, SENT, RECALL }
export default adapter
