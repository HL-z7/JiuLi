import fs from 'node:fs/promises'
import { ulid } from 'ulid'
import YAML from 'yaml'
import { JiuLiPlugin, cfg } from 'jiuli'

const code = {}
/** 用户配置目录（支持 JIULI_CONFIG_DIR 覆盖） */
const configFile = () => `${cfg.userDir}other.yaml`.replace(/\\/g, '/').replace(/\/+/g, '/')

/**
 * #设置主人 / #新增主人        同一条规则：不带目标时走验证码流程（任何人都能发起）
 *                              带 @用户 或 QQ 号时由主人直接写入配置
 * #删除主人 [@用户|QQ号]       主人直接移除，至少保留一个主人
 */
export default class Master extends JiuLiPlugin {
  constructor() {
    super({
      name: '设置主人',
      dsc: '#设置主人 #新增主人 #删除主人',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#设置主人验证码$', fnc: 'code', permission: 'master' },
        { reg: '^#(设置|新增|添加)主人', fnc: 'master' },
        { reg: '^#(删除|移除)主人', fnc: 'removeMaster', permission: 'master' },
      ],
    })
  }

  code() {
    let msg = ''
    for (const i in code) msg += `[${i}] ${code[i]}\n`
    return this.reply(msg.trim() || '暂无验证码', true)
  }

  /** 写入用户配置；文件/目录被误删时自愈重建；remove 为真时从列表移除 */
  async edit(key, value, remove = false) {
    const yamlFile = configFile()
    await Bot.mkdir(yamlFile.replace(/[/\\][^/\\]+$/, ''))

    let text = ''
    try {
      text = await fs.readFile(yamlFile, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      /** 文件缺失：从默认配置重建一份，保证后续解析有完整结构 */
      try {
        text = await fs.readFile(`config/default_config/${yamlFile.split(/[/\\]/).pop()}`, 'utf8')
        Bot.makeLog('mark', `配置文件 ${yamlFile} 缺失，已从默认配置重建`, 'JiuLi')
      } catch {
        text = ''
      }
    }

    const doc = YAML.parseDocument(text)
    const values = doc.get(key)
    if (remove) {
      if (values) values.items = values.items.filter(i => String(i.value) !== String(value))
    } else if (values) {
      if (values.items.some(i => String(i.value) === String(value))) return
      values.add(value)
    } else doc.set(key, [value])

    await fs.writeFile(yamlFile, doc.toString(), 'utf8')
    /** 让运行中的实例立刻读到新的主人列表 */
    cfg.invalidate('other')
  }

  /** @用户 或消息里直接写 QQ 号 */
  getTargetQQ() {
    if (this.e.at) return String(this.e.at)
    const qq = String(this.e.msg).replace(/^#?(设置|新增|添加|删除|移除)主人/, '').trim()
    return /^\d{5,}$/.test(qq) ? qq : null
  }

  addMaster(qq) {
    return this.edit('masterQQ', qq)
      .then(() => this.edit('master', `${this.e.self_id}:${qq}`))
      .then(() => this.reply(`[${qq}] 已被设置为主人`, true))
      .catch(err => this.reply(`写入配置失败：${err.message || err}`, true))
  }

  async removeMaster() {
    const qq = this.getTargetQQ()
    if (!qq) return this.reply('请 @用户 或带上 QQ 号', true)

    const list = (cfg.getOther()?.master || []).map(String)
    if (!list.includes(`${this.e.self_id}:${qq}`) && !list.includes(String(qq)))
      return this.reply(`[${qq}] 不在主人列表里`, true)

    /** 至少留一个主人，避免把自己锁在门外 */
    const rest = list.filter(i => i !== `${this.e.self_id}:${qq}` && i !== String(qq))
    if (!rest.length) return this.reply('至少要保留一个主人', true)

    try {
      await this.edit('masterQQ', qq, true)
      await this.edit('master', `${this.e.self_id}:${qq}`, true)
    } catch (err) {
      return this.reply(`写入配置失败：${err.message || err}`, true)
    }
    return this.reply(`[${qq}] 已被移除主人`, true)
  }

  /** 不带目标 → 验证码流程；带 @/QQ 号 → 主人直接添加 */
  master() {
    const qq = this.getTargetQQ()
    if (qq) {
      if (!this.e.isMaster) return this.reply('只有主人可以直接添加，请发送 #设置主人 走验证码流程', true)
      return this.addMaster(qq)
    }
    if (this.e.isMaster) return this.reply(`[${this.e.user_id}] 已经为主人`, true)

    code[`${this.e.self_id}:${this.e.user_id}`] = ulid()
    Bot.makeLog(
      'mark',
      `${logger.cyan(`[${this.e.user_id}]`)} 设置主人验证码 ${logger.green(code[`${this.e.self_id}:${this.e.user_id}`])}`,
      'JiuLi',
    )
    this.setContext('verify')
    return this.reply(`[${this.e.user_id}] 请输入验证码`, true)
  }

  async verify() {
    const key = `${this.e.self_id}:${this.e.user_id}`
    const verifyCode = code[key]
    const verified = Boolean(verifyCode) && this.e.msg?.trim().toUpperCase() === verifyCode
    delete code[key]
    this.finish('verify')
    if (verified) {
      try {
        await this.edit('masterQQ', this.e.user_id)
        await this.edit('master', `${this.e.self_id}:${this.e.user_id}`)
      } catch (err) {
        Bot.makeLog('error', ['写入主人配置失败', err], 'Master')
        return this.reply(`写入配置失败：${err.message || err}`, true)
      }
      return this.reply(`[${this.e.user_id}] 设置主人完成`, true)
    }
    return this.reply('验证码错误', true)
  }
}
