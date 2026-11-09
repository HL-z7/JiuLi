import { JiuLiPlugin, cfg } from 'jiuli'

/**
 * 自动同意好友请求（config/config/other.yaml → autoFriend: 1）
 */
export default class AutoFriend extends JiuLiPlugin {
  constructor() {
    super({
      name: 'autoFriend',
      dsc: '自动同意好友',
      event: 'request.friend',
    })
  }

  async accept() {
    if (this.e.sub_type == 'add' || this.e.sub_type == 'single') {
      if (cfg.other.autoFriend == 1) {
        Bot.makeLog('mark', `[自动同意][添加好友] ${this.e.user_id}`, 'Friend')
        await Bot.sleep(3000)
        this.e.approve?.(true)
      }
    }
  }
}
