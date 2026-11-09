import { JiuLiPlugin } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

/**
 * #重载 / #重载 <关键词>
 *
 * 设计：改动文件由内核热重载自动生效（plugins/ 下新增/修改/删除 js 都在监听范围内），
 * 本指令只用于两种情况：
 *   #重载           补漏：把"磁盘上有、但还没加载"的插件加载进来（如刚 clone 完/刚补装依赖）
 *   #重载 状态      强制刷新：重载名字匹配的插件（含已加载的，用于 file_watch 关闭或状态异常时）
 *
 * 强制刷新同时会**解除该插件的重载风暴熔断**（插件自激重载被暂停监听时，用它恢复）。
 */
export default class Reload extends JiuLiPlugin {
  constructor() {
    super({
      name: '重载插件',
      dsc: '#重载',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#重载(插件)?\\s*(.*)$', fnc: 'reload', permission: 'master' }],
    })
  }

  async reload() {
    const keyword = String(this.e.msg).replace(/^#重载(插件)?/, '').trim()
    const e = this.e

    /** 磁盘上的插件文件（跳过适配器/胶水文件：它们没有插件类，重复导入只会产生副作用） */
    const onDisk = await PluginsLoader.getPlugins()
    const loadedKeys = new Set(PluginsLoader.priority.map(i => i.key))
    const missing = onDisk
      .map(f => f.name)
      .filter(name => !loadedKeys.has(name) && !PluginsLoader.isInert(name))
    const loaded = [...loadedKeys]

    /** 无参数：只补漏；带关键词：强制刷新匹配项（含已加载） */
    const toLoad = keyword ? missing.filter(k => k.includes(keyword)) : missing
    const toReload = keyword ? loaded.filter(k => k.includes(keyword)) : []

    if (!toLoad.length && !toReload.length) {
      /** 有插件因重载风暴被暂停监听时，顺手报出来，避免用户以为它能自动重载 */
      const paused = PluginsLoader.pausedReloadList || []
      const pausedTip = paused.length
        ? `\n注意：${paused.join('、')} 因短时间内重载过多次被暂停了重载监听（防重载风暴），改完根因后用 #重载 <插件名> 恢复`
        : ''
      return this.reply(
        keyword
          ? `没有匹配「${keyword}」的插件${pausedTip}`
          : `插件均已加载（共 ${loaded.length} 个）· 修改文件由热重载自动生效；需要强制刷新请用 #重载 <插件名>${pausedTip}`,
        true,
      )
    }

    const parts = []
    if (toLoad.length) parts.push(`新加载 ${toLoad.length} 个（${toLoad.slice(0, 3).join(', ')}${toLoad.length > 3 ? ' …' : ''}）`)
    if (toReload.length) parts.push(`重载 ${toReload.length} 个`)
    await this.reply(`开始${keyword ? `处理「${keyword}」：` : '：'}${parts.join(' · ')}…`, true)

    /** 等回复发出去再动手，避免卸载掉正在处理这条消息的插件 */
    setTimeout(async () => {
      const start = Date.now()
      let ok = 0
      const failed = []

      for (const key of toLoad) {
        PluginsLoader.resumeReload(key)
        if (await PluginsLoader.reloadKey(key)) ok++
        else failed.push(key)
      }
      for (const key of toReload) {
        /** 强制刷新 = 明确的用户动作，顺手解除该插件的重载熔断 */
        PluginsLoader.resumeReload(key)
        if (await PluginsLoader.changePlugin(key)) ok++
        else failed.push(key)
      }

      const msg = `处理完成 · 成功 ${ok} 个${failed.length ? ` · 失败 ${failed.length} 个（${failed.join(', ')}）` : ''} · 用时 ${Date.now() - start}ms`
      Bot.makeLog('mark', msg, 'Reload')
      if (e.group_id) await Bot.sendGroupMsg(e.self_id, e.group_id, msg)
      else await Bot.sendFriendMsg(e.self_id, e.user_id, msg)
    }, 1500)
  }
}
