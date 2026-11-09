import { JiuLiPlugin, cfg } from 'jiuli'

/**
 * 群邀请处理（config/config/other.yaml → autoGroup: 0 仅主人 / 1 所有人）
 */
export default class Invite extends JiuLiPlugin {
  constructor() {
    super({
      name: 'invite',
      dsc: '邀请自动进群',
      event: 'request.group.invite',
    })
  }

  async accept() {
    if (!this.e.isMaster && cfg.other.autoGroup !== 1) {
      Bot.makeLog('mark', `[邀请加群]：${this.e.group_name}：${this.e.group_id}`, 'Invite')
      return
    }
    Bot.makeLog('mark', `[${this.e.isMaster ? '主人' : '自动同意'}邀请加群]：${this.e.group_name}：${this.e.group_id}`, 'Invite')
    this.e.approve?.(true)
    this.e.bot?.pickFriend(this.e.user_id)?.sendMsg(`已同意加群：${this.e.group_name}`)
  }
}
