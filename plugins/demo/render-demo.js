import { JiuLiPlugin } from 'jiuli'
import { renderService, metrics } from 'jiuli/core'
import puppeteer from '../../lib/puppeteer/puppeteer.js'

/**
 * 渲染功能测试插件
 *
 * #渲染测试   基础卡片（本项目自己的 render，返回可直接发送的图片段）
 * #渲染列表   表格 / art-template 循环 / 条件样式
 * #渲染图片   本地资源（resources/assets/logo.svg + pluResPath）
 * #渲染长图   超过 4000px 自动分页（走旧式 puppeteer.screenshots 通道）
 * #渲染状态   渲染后端状态与耗时排行
 */
export default class RenderDemo extends JiuLiPlugin {
  constructor() {
    super({
      name: '渲染测试',
      dsc: '#渲染测试',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#渲染测试$', fnc: 'card' },
        { reg: '^#渲染列表$', fnc: 'list' },
        { reg: '^#渲染图片$', fnc: 'image' },
        { reg: '^#渲染长图$', fnc: 'long' },
        { reg: '^#渲染状态$', fnc: 'state' },
      ],
    })
  }

  /** 基础卡片：模板循环 + 中文排版 + 渐变 */
  async card() {
    const e = this.e
    const name = e.sender?.card || e.sender?.nickname || String(e.user_id)
    const img = await this.render('card/index', {
      name,
      firstChar: String(name).slice(0, 1),
      title: e.isGroup ? `群 ${e.group_name || e.group_id}` : '私聊会话',
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      stats: [
        { label: '插件', value: '24' },
        { label: '规则', value: '30+' },
        { label: '渲染', value: 'OK' },
      ],
    })
    if (!img) return this.reply('渲染失败：请查看日志 [Render] 前缀的输出')
    return this.reply(img)
  }

  /** 表格 / 循环 / 条件样式 */
  async list() {
    const names = ['状态统计', '帮助', '设置主人', '词条', '进程管理', '更新', '渲染测试']
    const list = names.map((n, i) => ({
      name: n,
      state: i % 3 === 0 ? '正常' : i % 3 === 1 ? '待测' : '空闲',
      type: i % 3 === 0 ? 'ok' : i % 3 === 1 ? 'warn' : '',
      value: `${12 + i * 7} 次`,
    }))
    const img = await this.render('list/index', {
      title: '插件调用统计（渲染测试数据）',
      columns: ['插件', '状态', '调用'],
      list,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    return this.reply(img || '渲染失败：请查看日志 [Render] 前缀的输出')
  }

  /** 本地图片资源（SVG + pluResPath） */
  async image() {
    const renderer = renderService.getRenderer('puppeteer')
    const img = await this.render('image/index', {
      renderer: renderer?.id || '未知',
      tplPath: `plugins/${this.__key}/resources/image/index.html`,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    return this.reply(img || '渲染失败：请查看日志 [Render] 前缀的输出')
  }

  /** 长图分页：走旧式 puppeteer.screenshots 通道（返回多张图片段） */
  async long() {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      label: `第 ${i + 1} 行 · 数据项 ${Math.random().toString(36).slice(2, 8)}`,
      percent: 5 + Math.floor(Math.random() * 95),
    }))

    await this.reply('正在生成长图（超过 4000px 会自动分页）…', true)
    const imgs = await puppeteer.screenshots(`${this.__key}/long/index`, {
      tplFile: `./plugins/${this.__key}/resources/long/index.html`,
      saveId: 'index',
      pluResPath: `../../../plugins/${this.__key}/resources/`,
      rows,
      pageHeight: 4000,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    if (!imgs) return this.reply('渲染失败：请查看日志 [Render] 前缀的输出')
    for (const img of imgs) await this.reply(img)
    return this.reply(`长图完成，共 ${imgs.length} 张`)
  }

  /** 渲染后端状态 */
  async state() {
    const renderer = renderService.getRenderer('puppeteer')
    const browser = renderer?.browser
    const lines = [
      `渲染后端：${[...renderService.renderers.keys()].join(', ') || '无'}`,
      `puppeteer：${renderer?.id ? '已加载' : '未加载'}${browser ? ' · Chromium 运行中' : ' · Chromium 未启动（首次截图时启动）'}`,
      browser ? `本次进程已生成 ${renderer.renderNum} 张图片` : '',
      '',
      metrics.summary(10),
    ].filter(Boolean)
    return this.reply(lines.join('\n'))
  }
}
