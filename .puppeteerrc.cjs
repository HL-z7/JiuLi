/**
 * puppeteer 安装配置：优先使用本机已安装的 Chrome/Edge，避免下载 Chromium
 * 与 TRSS-Yunzai 的 .puppeteerrc.cjs 行为一致
 */
const arch = require('os').arch()
const { existsSync } = require('fs')
const { execSync } = require('child_process')

let skipDownload = false
let executablePath

if (['linux', 'android'].includes(process.platform)) {
  for (const item of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const p = execSync(`command -v ${item}`).toString().trim()
      if (p && existsSync(p)) {
        executablePath = p
        break
      }
    } catch { /* ignore */ }
  }
}

if (!executablePath) {
  for (const item of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]) {
    if (existsSync(item)) {
      executablePath = item
      break
    }
  }
}

if (executablePath || arch === 'arm64' || arch === 'aarch64') skipDownload = true

/**
 * 只有真找到系统浏览器时才写 executablePath：写成 undefined 会让 puppeteer 误判为
 * "已配置路径"，服务器（没装浏览器）上安装依赖时就不会下载 Chromium，渲染直接不可用。
 * 找不到时保持不写 → 安装依赖时正常下载；运行时后端还有兜底自动安装。
 */
module.exports = executablePath ? { skipDownload, executablePath } : { skipDownload }
