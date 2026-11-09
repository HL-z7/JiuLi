/**
 * puppeteer 渲染后端
 * 与本机 Chrome/Edge 配合：优先连接已有实例（redis 缓存 ws 端点），否则本地启动
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import timers from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'
import { ulid } from 'ulid'
import Renderer from '../../../lib/renderer/Renderer.js'
import cfg from '../../../lib/config/config.js'

let mac = ''

/**
 * 是否是 snap 安装的浏览器
 *
 * snap 版 chromium 跑在沙箱里，读不到 `--user-data-dir`（以及页面里的本地资源），
 * 表现就是截图内容缺失 / 白屏，且不报错 —— 所以**自动选择时一律跳过**。
 * 判定：路径里有 /snap/，或软链的真实目标是 snap 启动器（/snap/bin/chromium 就是这种）。
 * 用户显式在 config.yaml / bot.yaml 里写死 chromiumPath 时仍然照用（只给警告）。
 */
export async function isSnapBrowser(p) {
  if (!p) return false
  if (/\/snap\//.test(p)) return true
  try {
    const real = await fs.realpath(p)
    /** /usr/bin/chromium 这类软链最终指向 snap 启动器时，同样算 snap */
    return /\/snap\//.test(real) || path.basename(real) === 'snap'
  } catch {
    return false
  }
}

/** 浏览器可执行文件的常见名字：chromium_path 写成目录 / .app 时按这些名字往里找 */
const BROWSER_BINARIES = [
  'Google Chrome for Testing',
  'Google Chrome',
  'Chromium',
  'Microsoft Edge',
  'chrome',
  'chromium',
  'msedge',
  'chrome-headless-shell',
]

/**
 * 把「目录 / .app 包」补全成可执行文件；已是文件或找不到时返回空串。
 *
 * macOS 上 chromium_path 常被写成 `…/Google Chrome for Testing.app/Contents/MacOS`（目录），
 * 甚至直接写 `.app` 包 —— 这两种都往里找一层。配置只接受文件时，这类写法会被静默忽略、
 * 然后照旧去下载浏览器，用户只会看到「配置没生效」。
 */
export async function resolveBrowserBinary(p) {
  if (!p) return ''
  const isFile = async f => {
    try {
      return (await fs.stat(f)).isFile()
    } catch {
      return false
    }
  }
  /** .app 包和 Contents/MacOS 目录都当作「里面放二进制」的目录 */
  const dirs = [p, path.join(p, 'Contents', 'MacOS')]
  for (const dir of dirs)
    for (const name of BROWSER_BINARIES) {
      const full = path.join(dir, name)
      if (await isFile(full)) return full
    }
  return ''
}

export default class Puppeteer extends Renderer {
  constructor(config) {
    super({
      id: 'puppeteer',
      type: 'image',
      render: 'screenshot',
    })
    this.browser = false
    this.lock = false
    this.browserInitPromise = null
    this.shoting = []
    /** 字体自检只做一次 */
    this.fontChecked = false
    /** 截图数达到时重启浏览器，避免生成速度越来越慢 */
    this.restartNum = config.restartNum || 100
    /** 截图次数 */
    this.renderNum = 0
    /** 空闲自动关闭浏览器时间 ms（0 为不自动关闭） */
    this.idleTime = (config.idleTime ?? 30) * 60000
    this.idleTimer = null
    this.config = {
      headless: 'new',
      args: ['--disable-gpu', '--disable-setuid-sandbox', '--no-sandbox', '--no-zygote'],
      ...config,
    }
    /** puppeteer >= 22：'new' 已等价于 true */
    if (this.config.headless === 'new') this.config.headless = true
    /** chromium 其他路径 */
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
    this.pageGotoParams = config.pageGotoParams || { timeout: 120000, waitUntil: 'networkidle2' }
  }

  /** 初始化 chromium（并发安全） */
  async browserInit() {
    if (this.browserInitPromise) return this.browserInitPromise
    if (this.browser) return this.browser
    this.lock = true
    this.browserInitPromise = this.createBrowser()
    try {
      return await this.browserInitPromise
    } finally {
      this.browserInitPromise = null
      this.lock = false
    }
  }

  /**
   * 找出可用的浏览器；找不到就自动装一个（首次部署的常见缺件）
   *
   * 顺序：配置的 chromiumPath → puppeteer 自带缓存 → 系统已装的浏览器 →
   *       自动安装（Linux 优先 apt/yum/dnf 装 chromium，顺带装中文字体；否则用 puppeteer 下载）
   * **自动选择时会跳过 snap 版浏览器**（/snap/bin/* 及指向 snap 启动器的软链）：
   * snap 沙箱读不到 --user-data-dir，截图会缺内容/白屏而且不报错；
   * 只有用户显式配置 chromiumPath 时才按配置用（并给一条警告）。
   * 失败不抛错，返回 '' 由调用方提示（渲染功能停用，不影响其他功能）
   */
  async resolveExecutable() {
    const { execSync } = await import('node:child_process')
    const isFile = async p => {
      try {
        return (await fs.stat(p)).isFile()
      } catch {
        return false
      }
    }
    const fromPath = name => {
      try {
        const p = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        return p || ''
      } catch {
        return ''
      }
    }

    const configured = this.config.executablePath
    if (configured) {
      /** 配置也可能是目录 / .app（macOS 常见写法）：补全成可执行文件再用 */
      const resolved = (await isFile(configured)) ? configured : await resolveBrowserBinary(configured)
      if (resolved) {
        if (await isSnapBrowser(resolved))
          Bot.makeLog(
            'warn',
            `配置的浏览器是 snap 版（${resolved}）：snap 沙箱常导致截图缺内容/白屏\n` +
              '  建议换成系统版 Chrome/Chromium，或在 config/config/bot.yaml 里把 chromium_path 指到别的浏览器',
            'Render',
          )
        else
          Bot.makeLog(
            'info',
            resolved === configured
              ? `使用配置的浏览器 · ${configured}`
              : `使用配置的浏览器 · ${resolved}（由 ${configured} 补全）`,
            'Render',
          )
        return resolved
      }
      Bot.makeLog(
        'warn',
        `配置的 chromium_path 用不了：${configured}\n` +
          '  这里要指向浏览器可执行文件本身，macOS 上形如\n' +
          '  …/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\n' +
          '  已忽略该配置，继续自动选择；一个都找不到时会自动下载（约 150MB）',
        'Render',
      )
    }

    /** puppeteer 自带缓存（装了才会命中） */
    try {
      const p = await puppeteer.executablePath()
      if (p && (await isFile(p)) && !(await isSnapBrowser(p))) return p
    } catch {}

    /** 系统已装的浏览器（跳过 snap） */
    const candidates =
      process.platform === 'linux'
        ? ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']
        : [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
    const skippedSnap = []
    for (const item of candidates) {
      const p = item.includes('/') ? item : fromPath(item)
      if (!p || !(await isFile(p))) continue
      if (await isSnapBrowser(p)) {
        skippedSnap.push(p)
        continue
      }
      Bot.makeLog('info', `使用系统已安装的浏览器 · ${p}`, 'Render')
      return p
    }
    if (skippedSnap.length)
      Bot.makeLog(
        'warn',
        `已跳过 snap 版浏览器：${[...new Set(skippedSnap)].join(' · ')}\n` +
          '  snap 沙箱会导致截图缺内容/白屏；要指定其它浏览器请在 config/config/bot.yaml 配 chromium_path（升级不会覆盖）',
        'Render',
      )

    /** 自动安装（JIULI_NO_AUTO_INSTALL=1 可关掉，适合不想让框架装东西的场景） */
    if (!process.env.JIULI_NO_AUTO_INSTALL && process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      const has = c => Boolean(fromPath(c))
      const install = has('apt-get')
        ? 'apt-get update -qq && apt-get install -y -qq chromium fonts-noto-cjk fonts-noto-color-emoji'
        : has('dnf')
          ? 'dnf install -y chromium google-noto-sans-cjk-fonts google-noto-color-emoji-fonts'
          : has('yum')
            ? 'yum install -y chromium google-noto-color-emoji-fonts'
            : ''
      if (install) {
        Bot.makeLog(
          'warn',
          `没找到浏览器，正在自动安装：${install}\n  （中文字体与 emoji 字体一并安装，否则截图里的中文/emoji 会变成方块；不想自动装可配置 chromium_path）`,
          'Render',
        )
        try {
          execSync(install, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
        } catch (err) {
          Bot.makeLog('error', `自动安装浏览器失败：${String(err?.message || err).split('\n')[0]}`, 'Render')
        }
        for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
          const p = fromPath(name)
          /** Ubuntu 的 apt chromium 是 snap 中转包，装完还是 /snap/bin/chromium → 照样跳过，走下面的 puppeteer 下载 */
          if (p && (await isFile(p)) && !(await isSnapBrowser(p))) {
            Bot.makeLog('mark', `浏览器已就绪 · ${p}`, 'Render')
            return p
          }
        }
      }
    }

    /** 最后一招：让 puppeteer 自己下载（用户态也能用） */
    if (process.env.JIULI_NO_AUTO_INSTALL) return ''
    Bot.makeLog('warn', '没有可用浏览器，正在用 puppeteer 下载（约 150MB，仅首次）…', 'Render')
    try {
      execSync('npx puppeteer browsers install chrome', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
      const p = await puppeteer.executablePath()
      if (p && (await isFile(p))) {
        Bot.makeLog('mark', `浏览器已就绪 · ${p}`, 'Render')
        return p
      }
    } catch (err) {
      Bot.makeLog('error', `puppeteer 下载浏览器失败：${String(err?.message || err).split('\n')[0]}`, 'Render')
    }

    return ''
  }

  /**
   * 中文字体 / emoji 字体自检
   *
   * 缺字体时截图里只会出现方块，不报任何错（插件的 👑 / 💬 就这样变成过豆腐块），
   * 所以在启动浏览器时提醒一次。
   */
  async checkFonts() {
    if (process.platform !== 'linux' || this.fontChecked) return
    const { execSync } = await import('node:child_process')
    const has = cmd => {
      try {
        return Boolean(execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())
      } catch {
        return false
      }
    }
    if (!has('command -v fc-list')) return
    this.fontChecked = true

    const missing = []
    if (!has('fc-list :lang=zh | head -1')) missing.push(['中文字体', 'fonts-noto-cjk'])
    if (!has('fc-list | grep -i emoji | head -1')) missing.push(['emoji 字体', 'fonts-noto-color-emoji'])
    if (!missing.length) return

    Bot.makeLog(
      'warn',
      `系统缺少${missing.map(i => i[0]).join(' / ')}，截图里会显示成方块（不会报错）\n` +
        `  Debian/Ubuntu：apt-get install -y ${missing.map(i => i[1]).join(' ')}\n` +
        '  CentOS/RHEL：yum install -y google-noto-sans-cjk-fonts google-noto-color-emoji-fonts',
      'Render',
    )
  }

  async createBrowser() {
    await this.checkFonts()
    const headless = this.config.headless === true || this.config.headless === 'new'
    let execPath = await this.resolveExecutable()
    if (execPath) this.config.executablePath = execPath
    const info = [
      `程序 ${execPath || '默认'}`,
      `模式 ${headless ? 'headless' : '有界面'}`,
      this.config.wsEndpoint ? `指定端点 ${this.config.wsEndpoint}` : '',
      `参数 ${(this.config.args || []).join(' ')}`,
      this.config.userDataDir ? `数据目录 ${this.config.userDataDir}` : '',
      `截图 ${this.restartNum} 次后重启 · 空闲 ${this.idleTime / 60000} 分钟关闭`,
    ]
      .filter(Boolean)
      .join('\n  ')
    Bot.makeLog('info', `Chromium 启动中\n  ${info}`, 'Render')

    let connectFlag = false
    try {
      if (!mac) {
        mac = this.getMac()
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
      }
      const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
      if (browserUrl) {
        try {
          const browserWSEndpoint = await puppeteer.connect({ browserWSEndpoint: browserUrl })
          if (browserWSEndpoint) {
            this.browser = browserWSEndpoint
            connectFlag = true
          }
          Bot.makeLog('mark', `复用已运行的 Chromium · ${browserUrl}`, 'Render')
        } catch {
          await redis.del(this.browserMacKey)
        }
      }
    } catch {}

    if (!this.browser || !connectFlag) {
      let config = this.config
      if (!config.userDataDir) {
        await fs.rm('temp/puppeteer', { force: true, recursive: true }).catch(() => {})
        config = { ...config, userDataDir: `temp/puppeteer/${ulid()}` }
      }
      const launchStart = Date.now()
      this.browser = await puppeteer.launch(config).catch(err => {
        const errMsg = err.toString()
        Bot.makeLog('error', `Chromium 启动失败 · ${errMsg}`, 'Render')
        if (errMsg.includes('Could not find Chromium'))
          Bot.makeLog('error', '未找到 Chromium，可在 renderers/puppeteer/config.yaml 指定 chromiumPath，或执行 node node_modules/puppeteer/install.js', 'Render')
        else if (errMsg.includes('cannot open shared object file')) Bot.makeLog('error', '缺少 Chromium 运行库', 'Render')
      })
      if (this.browser) {
        const version = await this.browser.version().catch(() => '未知版本')
        Bot.makeLog(
          'mark',
          `Chromium 已启动 · ${version} · 用时 ${Date.now() - launchStart}ms · 端点 ${this.browser.wsEndpoint()}`,
          'Render',
        )
      }
    }

    if (!this.browser) {
      Bot.makeLog('error', 'Chromium 不可用，图片渲染功能已停用', 'Render')
      return false
    }

    if (!connectFlag && this.browserMacKey)
      await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: 60 * 60 * 24 * 30 }).catch(() => {})

    this.browser.on('disconnected', this.onDisconnected)
    return this.browser
  }

  /** 获取本机 mac 地址（用于多进程共享浏览器实例） */
  getMac() {
    let value = '00:00:00:00:00:00'
    try {
      const network = os.networkInterfaces()
      for (const name in network)
        for (const i of network[name] || [])
          if (i.mac && i.mac !== '00:00:00:00:00:00') {
            value = i.mac
            return value.replace(/:/g, '')
          }
    } catch {}
    return value.replace(/:/g, '')
  }

  /**
   * 截图
   * @param name 保存目录名
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId 生成 html 名称，为空用 name 代替
   * @param data.imgType 图片类型：jpeg/png
   * @param data.quality 图片质量 0-100（jpeg）
   * @param data.omitBackground 背景透明
   * @param data.path 截图保存路径（不传则不落盘）
   * @param data.multiPage 是否分页截图
   * @param data.multiPageHeight 分页高度，默认 4000
   * @param data.pageGotoParams 页面 goto 参数
   * @return Buffer | Buffer[]，不做 segment 包裹
   */
  async screenshot(name, data = {}) {
    return Renderer.withTpl(name, data, () => this.captureScreenshot(name, data))
  }

  /** 执行已取得模板路径锁的截图 */
  async captureScreenshot(name, data = {}) {
    if (!(await this.browserInit())) return false
    const pageHeight = data.multiPageHeight || 4000

    const savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ''
    const start = Date.now()
    const ret = []
    let page
    this.shoting.push(name)

    const puppeteerTimeout = this.puppeteerTimeout
    let overtime
    if (puppeteerTimeout > 0)
      overtime = setTimeout(() => {
        if (this.shoting.length) {
          logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(',')}`)
          this.restart(true)
          this.shoting = []
        }
      }, puppeteerTimeout)

    try {
      page = await this.browser.newPage()
      const pageGotoParams = { ...this.pageGotoParams, ...data.pageGotoParams }
      await page.goto(pathToFileURL(path.resolve(savePath)).href, pageGotoParams)
      const body = (await page.$('#container')) || (await page.$('body'))

      const boundingBox = await body.boundingBox()
      let num = 1

      const randData = {
        type: data.imgType || 'jpeg',
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || '',
      }

      if (data.multiPage) {
        randData.type = 'jpeg'
        num = Math.round(boundingBox.height / pageHeight) || 1
      }
      if (data.imgType === 'png') delete randData.quality

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)
        this.renderNum++
        const kb = `${(buff.length / 1024).toFixed(2)}KB`
        Bot.makeLog(
          'mark',
          `生成图片 · ${name} · ${kb} · ${Date.now() - start}ms · 本次进程累计第 ${this.renderNum} 张`,
          'Render',
        )
        ret.push(buff)
      } else {
        if (num > 1)
          await page.setViewport({
            width: boundingBox.width,
            height: pageHeight + 100,
          })
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num)
            await page.setViewport({
              width: boundingBox.width,
              height: parseInt(String(boundingBox.height), 10) - pageHeight * (num - 1),
            })
          if (i !== 1 && i <= num) await page.evaluate(h => window.scrollBy(0, h), pageHeight)

          if (num === 1) buff = await body.screenshot(randData)
          else buff = await page.screenshot(randData)
          if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)
          if (num > 2) await timers.setTimeout(200)

          this.renderNum++
          Bot.makeLog('debug', `长图分页 ${i}/${num} · ${(buff.length / 1024).toFixed(2)}KB`, 'Render')
          ret.push(buff)
        }
        if (num > 1) {
          const total = (ret.reduce((n, b) => n + b.length, 0) / 1024).toFixed(2)
          Bot.makeLog(
            'mark',
            `生成长图 · ${name} · ${num} 页 · 共 ${total}KB · 页面高 ${Math.round(boundingBox.height)}px · ${Date.now() - start}ms`,
            'Render',
          )
        }
      }
    } catch (err) {
      Bot.makeLog('error', `图片渲染失败 · ${name} · ${err.message || err}`, 'Render')
      /** 关闭浏览器 */
      this.restart(true)
      return false
    } finally {
      if (overtime) clearTimeout(overtime)
      if (page) await page.close().catch(err => logger.error(err))
      const index = this.shoting.indexOf(name)
      if (index !== -1) this.shoting.splice(index, 1)
    }

    if (ret.length === 0 || !ret[0]) {
      Bot.makeLog('error', `图片内容为空 · ${name}`, 'Render')
      return false
    }

    this.restart()
    this.resetIdleTimer()
    return data.multiPage ? ret : ret[0]
  }

  /** 断开连接时重启浏览器 */
  onDisconnected = () => this.restart(true)

  /** 空闲超时自动关闭浏览器，下次截图时自动重启 */
  resetIdleTimer() {
    if (!this.idleTime) return
      if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.shoting.length || this.lock || this.config.wsEndpoint) return
      if (!this.browser?.close) return
      Bot.makeLog('mark', `空闲 ${this.idleTime / 60000} 分钟，关闭 Chromium 释放内存（下次截图自动启动）`, 'Render')
      this.stop(this.browser).then(() => this.browserMacKey && redis.del(this.browserMacKey).catch(() => {}))
    }, this.idleTime)
    this.idleTimer.unref?.()
  }

  /** 重启 */
  restart(force = false) {
    if (!this.browser?.close || this.lock) return
    if (!force) if (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0) return
    Bot.makeLog('mark', `已截图 ${this.renderNum} 张，${force ? '强制' : ''}重启 Chromium`, 'Render')
    const browser = this.browser
    this.browser = false
    return this.stop(browser).then(() => this.browserInit())
  }

  /**
   * 关闭浏览器实例（不传则关当前实例）
   *
   * browser.close() 自己会触发 disconnected，而监听器 onDisconnected 就是 restart(true)：
   * 不先摘掉它，退出/空闲关闭的过程中会再拉起一个新的 Chromium。
   */
  async stop(browser = this.browser) {
    if (this.browser === browser) this.browser = false
    if (!browser?.close) return
    /** Browser 只有 on / off，没有 removeListener（用旧 API 会抛错，导致浏览器永远关不掉） */
    if (typeof browser.off === 'function') browser.off('disconnected', this.onDisconnected)
    try {
      await browser.close()
    } catch (err) {
      Bot.makeLog('error', `Chromium 关闭错误 · ${err.message || err}`, 'Render')
    }
  }
}
