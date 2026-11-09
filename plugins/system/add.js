import fs from 'node:fs/promises'
import path from 'node:path'
import lodash from 'lodash'
import { JiuLiPlugin, cfg } from 'jiuli'

/** 群词条缓存（module 级，供同一插件实例共享） */
export const messageMap = {}

/**
 * 添加消息（词条）
 *
 * #添加 <关键词>      —— 进入添加模式，发送内容后 #结束添加
 * #全局添加 <关键词>  —— 全局词条（仅主人）
 * #删除 <关键词> / #全局删除 <关键词>
 * #消息列表 [页码]    —— 查看词条（#词条列表 / #消息 <关键词> 搜索）
 *
 * 触发：群内直接发送关键词即回复（回复方式受群配置 addReply/addAt/addRecall 控制）
 */
export default class Add extends JiuLiPlugin {
  constructor() {
    super({
      name: '添加消息',
      dsc: '添加消息',
      event: 'message',
      priority: Infinity,
      rule: [
        { reg: '^#(全局)?添加', fnc: 'add' },
        { reg: '^#(全局)?删除', fnc: 'del' },
        { reg: '', fnc: 'getMessage', log: false },
        { reg: '^#(全局)?(消息|词条)', fnc: 'list' },
      ],
    })

    this.path = 'data/messageJson/'
  }

  async init() {
    await Bot.mkdir(this.path)
  }

  /** 群号 key */
  get grpKey() {
    return `Yz:group_id:${this.e.user_id}`
  }

  /** #添加 */
  async add() {
    this.isGlobal = Boolean(this.e.msg.match(/^#全局/))
    await this.getGroupId()

    if (!this.group_id) return this.reply('请先在群内触发消息，确定添加的群')

    await this.initMessageMap()

    if (!this.checkAuth()) return false
    /** 获取关键词 */
    this.getKeyWord()
    if (!this.keyWord) return this.reply('添加错误：没有关键词')

    this.e.keyWord = this.keyWord
    /** 固定目标群：后续消息（含别人在别的群说话）不能改写它 */
    this.e.addGroupId = this.group_id
    this.e.message = []
    this.setContext('addContext')

    return this.reply('请发送添加内容，完成后发送#结束添加', true, { at: true })
  }

  /** 获取群号 */
  async getGroupId() {
    if (this.isGlobal) {
      this.group_id = 'global'
      return this.group_id
    }

    if (this.e.isGroup) {
      this.group_id = this.e.group_id
      redis.setEx(this.grpKey, 2592000, String(this.group_id))
      return this.group_id
    }

    return (this.group_id = await redis.get(this.grpKey))
  }

  checkAuth() {
    if (this.e.isMaster) return true
    if (this.isGlobal) {
      this.reply('暂无权限，只有主人才能操作')
      return false
    }

    const groupCfg = cfg.getGroup(this.e.self_id, this.group_id)
    if (groupCfg.addLimit == 2) {
      this.reply('暂无权限，只有主人才能操作')
      return false
    }
    if (groupCfg.addLimit == 1 && !this.e.member?.is_admin) {
      this.reply('暂无权限，只有管理员才能操作')
      return false
    }
    if (groupCfg.addPrivate != 1 && !this.e.isGroup) {
      this.reply('禁止私聊添加')
      return false
    }

    return true
  }

  /** 获取添加关键词 */
  getKeyWord() {
    this.e.isGlobal = Boolean(this.e.msg.match(/^#全局/))
    this.keyWord = this.trimAlias(String(this.e.raw_message).replace(/#(全局)?(添加|删除)/, '').trim())
  }

  /** 过滤别名 */
  trimAlias(msg) {
    const groupCfg = cfg.getGroup(this.e.self_id, this.group_id)
    let alias = groupCfg.botAlias
    if (!Array.isArray(alias)) alias = [alias]

    for (const name of alias) if (name && msg.startsWith(name)) msg = lodash.trimStart(msg, name).trim()

    return msg
  }

  /** 添加内容（上下文方法） */
  async addContext() {
    const context = this.getContext('addContext')
    this.isGlobal = context.isGlobal
    /** 用发起时固定的目标群，避免中途被别的群（或别人的消息）改写 */
    this.group_id = context.addGroupId
    if (!this.group_id) {
      this.finish('addContext')
      return this.reply('添加已失效，请重新添加')
    }
    if (!this.isGlobal && this.e.isGroup && String(this.e.group_id) !== String(this.group_id)) return 'continue'
    this.keyWord = context.keyWord

    if (!this.e.msg?.includes('#结束添加')) {
      for (const i of this.e.message) {
        if (i.url) {
          i.file = await this.saveFile(i)
          delete i.url
          delete i.fid
        }
        if (i.type == 'at' && i.qq == this.e.self_id) continue
        context.message.push(i)
      }
      return
    }

    this.finish('addContext')
    if (!context.message?.length) return this.reply('添加错误：没有添加内容')

    if (!messageMap[this.group_id]) messageMap[this.group_id] = new Map()

    let message = messageMap[this.group_id].get(this.keyWord)
    if (Array.isArray(message)) message.push(context.message)
    else message = [context.message]
    messageMap[this.group_id].set(this.keyWord, message)
    if (message.length > 1) this.keyWord += `(${message.length})`

    await this.saveJson()
    return this.reply(`添加成功：${this.keyWord}`)
  }

  async saveJson() {
    const obj = {}
    for (const [k, v] of messageMap[this.group_id]) obj[k] = v
    /** 运行期间数据目录被清理时自愈 */
    await Bot.mkdir(this.path)
    await fs.writeFile(`${this.path}${this.group_id}.json`, JSON.stringify(obj, '', '\t'))
  }

  async saveFile(data) {
    const file = await Bot.fileType({ ...data, file: data.url })
    if (Buffer.isBuffer(file.buffer)) {
      file.name = `${this.group_id}/${data.type}/${file.name}`
      file.path = `${this.path}${file.name}`
      await Bot.mkdir(path.dirname(file.path))
      await fs.writeFile(file.path, file.buffer)
      return file.name
    }
    return data.url
  }

  getKeyWordMsg(keyWord) {
    return [...(messageMap[this.group_id].get(keyWord) || []), ...(messageMap.global.get(keyWord) || [])]
  }

  /** 匹配词条并回复（无匹配返回 false 继续后续规则） */
  async getMessage() {
    if (!this.e.raw_message) return false
    this.isGlobal = false

    await this.getGroupId()
    if (!this.group_id) return false

    await this.initMessageMap()
    await this.initGlobalMessageMap()

    this.keyWord = this.trimAlias(this.e.raw_message.trim())

    let msg = this.getKeyWordMsg(this.keyWord)
    if (!msg.length) {
      const index = this.keyWord.match(/\d+$/)?.[0]
      if (index)
        for (let i = 0; i < index.length; i++) {
          const keyWord = this.keyWord.slice(0, this.keyWord.length - index.length + i)
          msg = this.getKeyWordMsg(keyWord)
          if (msg.length) {
            const n = index.slice(-i)
            msg = msg[n - 1]
            if (msg) {
              this.keyWord = `${keyWord}(${n})`
              break
            }
          }
        }
    } else {
      msg = msg[lodash.random(0, msg.length - 1)]
    }
    if (lodash.isEmpty(msg)) return false

    msg = [...msg]
    for (const i in msg)
      if (msg[i].file && (await Bot.fsStat(`${this.path}${msg[i].file}`)))
        msg[i] = { ...msg[i], file: `${this.path}${msg[i].file}` }

    Bot.makeLog('mark', `[发送消息]${this.e.logText}[${this.keyWord}]`, 'Add')
    const groupCfg = cfg.getGroup(this.e.self_id, this.group_id)
    return this.reply(msg, Boolean(groupCfg.addReply), {
      at: Boolean(groupCfg.addAt),
      recallMsg: groupCfg.addRecall,
    })
  }

  /** 初始化已添加内容 */
  async initMessageMap() {
    if (messageMap[this.group_id]) return
    messageMap[this.group_id] = new Map()

    const file = `${this.path}${this.group_id}.json`
    if (!(await Bot.fsStat(file))) return

    try {
      const message = JSON.parse(await fs.readFile(file, 'utf8'))
      for (const i in message) messageMap[this.group_id].set(i, message[i])
    } catch (err) {
      Bot.makeLog('error', `JSON 格式错误：${file} ${err}`, 'Add')
    }
  }

  /** 初始化全局已添加内容 */
  async initGlobalMessageMap() {
    if (messageMap.global) return
    messageMap.global = new Map()

    const globalPath = `${this.path}global.json`
    if (!(await Bot.fsStat(globalPath))) return

    try {
      const message = JSON.parse(await fs.readFile(globalPath, 'utf8'))
      for (const i in message) messageMap.global.set(i, message[i])
    } catch (err) {
      Bot.makeLog('error', `JSON 格式错误：${globalPath} ${err}`, 'Add')
    }
  }

  delFile(msg) {
    return Promise.allSettled(msg.map(i => i.file && fs.rm(`${this.path}${i.file}`)))
  }

  /** #删除 */
  async del() {
    this.isGlobal = this.e.msg.includes('全局')
    await this.getGroupId()
    if (!(this.group_id && this.checkAuth())) return false

    await this.initMessageMap()

    this.getKeyWord()
    if (!this.keyWord) return this.reply('删除错误：没有关键词')

    if (messageMap[this.group_id].has(this.keyWord)) {
      await Promise.allSettled(messageMap[this.group_id].get(this.keyWord).map(this.delFile.bind(this)))
      messageMap[this.group_id].delete(this.keyWord)
      await this.saveJson()
      return this.reply(`删除成功：${this.keyWord}`)
    }

    const index = this.keyWord.match(/\d+$/)?.[0]
    if (index)
      for (let i = 0; i < index.length; i++) {
        const keyWord = this.keyWord.slice(0, this.keyWord.length - index.length + i)
        const msg = messageMap[this.group_id].get(keyWord)
        if (msg) {
          const n = index.slice(-i) - 1
          if (msg[n]) {
            await this.delFile(msg[n])
            msg.splice(n, 1)
            if (!msg.length) messageMap[this.group_id].delete(keyWord)
            await this.saveJson()
            return this.reply(`删除成功：${keyWord}(${n + 1})`)
          }
        }
      }
    return this.reply('删除错误：没有添加此关键词')
  }

  /** #消息列表 / #消息 <关键词> */
  async list() {
    this.isGlobal = Boolean(this.e.msg.match(/^#全局/))

    let page = 1
    const pageSize = 100
    let type = 'list'

    await this.getGroupId()
    if (!this.group_id) return false

    await this.initMessageMap()

    const search = this.e.msg.replace(/^#(全局)?(消息|词条)/, '').trim()
    if (search.match(/^列表/)) page = search.replace(/^列表/, '') || 1
    else type = 'search'

    const list = messageMap[this.group_id]
    if (lodash.isEmpty(list)) return this.reply('暂无消息')

    let arr = []
    if (type == 'list')
      for (const [k, v] of messageMap[this.group_id]) arr.push({ key: k, val: v, num: arr.length + 1 })
    else
      for (const [k, v] of messageMap[this.group_id])
        if (k.includes(search)) arr.push({ key: k, val: v, num: arr.length + 1 })

    const count = arr.length
    arr = arr.reverse()

    if (type == 'list') arr = this.pagination(page, pageSize, arr)
    if (lodash.isEmpty(arr)) return false

    let msg = []
    let num = 0
    for (const i of arr) {
      if (num >= page * pageSize) break
      const keyWord = i.key
      if (!keyWord) continue
      msg.push(`${i.num}. ${keyWord}(${i.val.length})`)
      num++
    }

    let title = `消息列表：第${page}页，共${count}条`
    if (type == 'search') title = `消息${search}：共${count}条`

    msg = [title, msg.join('\n')]
    if (type == 'list' && count > 100) msg.push(`更多内容请翻页查看\n如：#消息列表${Number(page) + 1}`)

    return this.reply(await Bot.makeForwardArray(msg))
  }

  /** 分页 */
  pagination(pageNo, pageSize, array) {
    const offset = (pageNo - 1) * pageSize
    return offset + pageSize >= array.length ? array.slice(offset, array.length) : array.slice(offset, offset + pageSize)
  }
}
