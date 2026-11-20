import { JiuLiPlugin, cfg } from 'jiuli'

/**
 * 主人账号：masterQQ 与 master 映射两种写法都要认
 *
 * 默认配置里 masterQQ 是 ["stdin"]，只按它判断的话，真实主人一个都匹配不上，
 * 结果是主人亲自拉群也会被当成陌生人拉走。
 */
function masterIds() {
  const ids = new Set()
  for (const qq of cfg.masterQQ || []) {
    const value = String(qq).split(':')[0]
    if (/^\d+$/.test(value)) ids.add(value)
  }
  for (const list of Object.values(cfg.master || {}))
    for (const qq of list) if (/^\d+$/.test(String(qq))) ids.add(String(qq))
  return ids
}

/**
 * 被拉进群时自动退出
 *
 * 只处理「被好友拉进群」：群里没有任何好友、也没有主人时，说明是机器人自己申请/加入的，不退。
 * 这个区分只能靠成员表推：icqq 的群成员增加通知里没有邀请人字段（TRSS 同样拿不到）。
 */
export default class AutoQuit extends JiuLiPlugin {
  constructor() {
    super({
      name: 'notice',
      dsc: '自动退群',
      event: 'notice.group.increase',
    })
  }

  async accept() {
    if (this.e.user_id != this.e.self_id || !this.e.group?.quit || !this.e.group.getMemberMap) return false

    const other = cfg.other
    if (!other.autoQuit) return false

    /** 强制刷新：刚进群时缓存里的成员表可能还没有自己，主人也在里面会被漏判 */
    let gml
    try {
      gml = await this.e.group.getMemberMap(true)
    } catch {
      return false
    }
    if (!(gml instanceof Map)) return false

    for (const qq of gml.keys())
      if (masterIds().has(String(qq))) {
        Bot.makeLog('mark', `[主人拉群] ${this.e.group_id}`, 'Quit')
        return false
      }

    if (gml.size > Number(other.autoQuit) || this.e.group.is_owner) return false
    if ((other.whiteGroup || []).map(String).includes(String(this.e.group_id))) return false

    /** 群里有好友才可能是「被好友拉进群」，一个都没有就是自己加的；拿不到好友列表时按旧行为处理 */
    const list = Bot.getFriendList?.()
    const friends = Array.isArray(list) ? new Set(list.map(String)) : null
    if (friends && ![...gml.keys()].some(qq => friends.has(String(qq)))) {
      Bot.makeLog('mark', `[主动加群] ${this.e.group_id} 保留`, 'Quit')
      return false
    }

    await this.reply('禁止拉群，已自动退出')
    Bot.makeLog('mark', `[自动退群] ${this.e.group_id}`, 'Quit')
    this.e.group.quit()
  }
}
