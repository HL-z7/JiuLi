/**
 * 一键内存优化的配置读写。
 *
 * 只动两处用户配置，逐行替换以保留原有注释：
 *   config/config/bot.yaml              → max_old_space_size（V8 老生代上限，MB）
 *   renderers/puppeteer/config.yaml     → idleTime / restartNum（浏览器释放）
 *
 * 上限值由 CLI 注入子进程的 NODE_OPTIONS（Node 运行中无法改），见 jiuli.mjs 的 applyNodeOptions。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一键优化的推荐值：上限 512MB、空闲 10 分钟关浏览器、50 张截图重启浏览器 */
export const TUNE_DEFAULTS = { heap: 512, idle: 10, restartNum: 50 }

/** 框架的原始默认值：没有备份可还原时写回这些（与 config_default 一致） */
export const TUNE_ORIGINAL = { heap: 0, idle: 30, restartNum: 100, pm2Memory: '512M' }

const BOT = path.join('config', 'config', 'bot.yaml')
const BOT_DEFAULT = path.join('config', 'default_config', 'bot.yaml')
const RENDER = path.join('renderers', 'puppeteer', 'config.yaml')
const RENDER_DEFAULT = path.join('renderers', 'puppeteer', 'config_default.yaml')
const PM2 = path.join('config', 'pm2.yaml')

/** 读顶层键的数值（容忍引号与行尾注释），读不到返回 undefined */
export function readNumber(text, key) {
  const m = new RegExp(`^${key}\\s*:\\s*([^\\s#]+)`, 'm').exec(text)
  if (!m) return undefined
  const n = Number(String(m[1]).replace(/['"]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** 改值：已有该键就替换（保留行尾注释），没有就追加；返回新文本 */
export function setNumber(text, key, value) {
  const re = new RegExp(`^(${key}\\s*:\\s*)([^\\s#]+)(.*)$`, 'm')
  if (re.test(text)) return text.replace(re, (_, head, _old, tail) => `${head}${value}${tail}`)
  return `${text}${text.endsWith('\n') || !text ? '' : '\n'}${key}: ${value}\n`
}

/** 读当前值；文件不存在时返回 undefined，便于 CLI 显示「未配置」 */
export function readTune(root = process.cwd()) {
  const read = p => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf8')
    } catch {
      return ''
    }
  }
  const bot = read(BOT)
  const render = read(RENDER)
  return {
    heap: readNumber(bot, 'max_old_space_size'),
    idle: readNumber(render, 'idleTime'),
    restartNum: readNumber(render, 'restartNum'),
  }
}

/** 确保用户配置存在：首次启动前也能直接调；缺失时从 default 复制 */
function ensureFile(root, file, def, changes) {
  const full = path.join(root, file)
  if (fs.existsSync(full)) return full
  const defFull = path.join(root, def)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  if (fs.existsSync(defFull)) {
    fs.copyFileSync(defFull, full)
    changes.push(`生成 ${file}（复制自默认配置）`)
  } else {
    fs.writeFileSync(full, '')
    changes.push(`生成空文件 ${file}`)
  }
  return full
}

/** 备份后缀：首次优化时保存原文件，便于 --revert 逐字节还原 */
const BAK = '.tune-bak'

/** 只在首次保存：重复 tune 不会用已被改过的内容覆盖最初的原件 */
function backupOnce(file) {
  const bak = `${file}${BAK}`
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak)
    return true
  }
  return false
}

/**
 * 应用优化值。只写有变化的键，重复执行不会重复改动；首次改动前先备份原文件。
 * @returns {{ changes: string[], values: object }}
 */
export function applyTune(root = process.cwd(), opts = {}) {
  const values = {
    heap: Number(opts.heap ?? TUNE_DEFAULTS.heap),
    idle: Number(opts.idle ?? TUNE_DEFAULTS.idle),
    restartNum: Number(opts.restartNum ?? TUNE_DEFAULTS.restartNum),
  }
  const changes = []
  const backedUp = []

  const botPath = ensureFile(root, BOT, BOT_DEFAULT, changes)
  const botOld = fs.readFileSync(botPath, 'utf8')
  const botNew = setNumber(botOld, 'max_old_space_size', values.heap)
  if (botNew !== botOld) {
    if (backupOnce(botPath)) backedUp.push(BOT)
    fs.writeFileSync(botPath, botNew)
    changes.push(`${BOT}: max_old_space_size → ${values.heap}`)
  }

  const renderPath = ensureFile(root, RENDER, RENDER_DEFAULT, changes)
  let render = fs.readFileSync(renderPath, 'utf8')
  const renderOld = render
  render = setNumber(render, 'idleTime', values.idle)
  render = setNumber(render, 'restartNum', values.restartNum)
  if (render !== renderOld) {
    if (backupOnce(renderPath)) backedUp.push(RENDER)
    fs.writeFileSync(renderPath, render)
    changes.push(`${RENDER}: idleTime → ${values.idle}，restartNum → ${values.restartNum}`)
  }

  /**
   * pm2 模式额外两条：node_args 带上堆上限（pm2 的子进程不继承 CLI 的 NODE_OPTIONS），
   * max_memory_restart 必须高于堆上限，否则 RSS 一过线就反复重启。
   * 只改已存在的用户配置（config/pm2.yaml），不动默认文件。
   */
  const pm2Path = path.join(root, PM2)
  if (fs.existsSync(pm2Path)) {
    const old = fs.readFileSync(pm2Path, 'utf8')
    const limit = values.heap + 512
    let next = old.replace(/^(\s*max_memory_restart\s*:\s*)([^\s#]+)(.*)$/m, (_, head, _v, tail) => `${head}${limit}M${tail}`)
    next = /^\s*node_args\s*:/m.test(next)
      ? next.replace(/^(\s*node_args\s*:\s*)(.*)$/m, (_, head) => `${head}--max-old-space-size=${values.heap}`)
      : next.replace(/^(\s*)script\s*:.*$/m, m => `${m}\n${/^(\s*)/.exec(m)[1]}node_args: --max-old-space-size=${values.heap}`)
    if (next !== old) {
      if (backupOnce(pm2Path)) backedUp.push(PM2)
      fs.writeFileSync(pm2Path, next)
      changes.push(`${PM2}: max_memory_restart → ${limit}M、node_args → --max-old-space-size=${values.heap}`)
    }
  }

  return { changes, values, backedUp }
}

/** 有没有可还原的备份 */
export function hasTuneBackup(root = process.cwd()) {
  return [BOT, RENDER, PM2].some(rel => fs.existsSync(path.join(root, rel) + BAK))
}

/**
 * 还原：优先用备份逐字节恢复（连注释和自定义值一起回到优化前）；
 * 没有备份时退回写默认值（老版本 tun​e 过、或手动改过的情况）。
 * @returns {{ restored: string[], fallback: string[] }}
 */
export function revertTune(root = process.cwd()) {
  const restored = []
  const fallback = []
  for (const rel of [BOT, RENDER, PM2]) {
    const file = path.join(root, rel)
    const bak = `${file}${BAK}`
    if (!fs.existsSync(bak)) continue
    fs.copyFileSync(bak, file)
    fs.rmSync(bak)
    restored.push(rel)
  }

  /** 没有备份可还原：把已知的三项写回默认值 */
  if (!restored.length) {
    const botPath = path.join(root, BOT)
    if (fs.existsSync(botPath)) {
      const old = fs.readFileSync(botPath, 'utf8')
      const next = setNumber(old, 'max_old_space_size', TUNE_ORIGINAL.heap)
      if (next !== old) {
        fs.writeFileSync(botPath, next)
        fallback.push(`${BOT}: max_old_space_size → ${TUNE_ORIGINAL.heap}`)
      }
    }
    const renderPath = path.join(root, RENDER)
    if (fs.existsSync(renderPath)) {
      let text = fs.readFileSync(renderPath, 'utf8')
      const old = text
      text = setNumber(text, 'idleTime', TUNE_ORIGINAL.idle)
      text = setNumber(text, 'restartNum', TUNE_ORIGINAL.restartNum)
      if (text !== old) {
        fs.writeFileSync(renderPath, text)
        fallback.push(`${RENDER}: idleTime → ${TUNE_ORIGINAL.idle}，restartNum → ${TUNE_ORIGINAL.restartNum}`)
      }
    }
    const pm2Path = path.join(root, PM2)
    if (fs.existsSync(pm2Path)) {
      const old = fs.readFileSync(pm2Path, 'utf8')
      let next = old.replace(/^(\s*max_memory_restart\s*:\s*)([^\s#]+)(.*)$/m, (_, head, _v, tail) => `${head}${TUNE_ORIGINAL.pm2Memory}${tail}`)
      /** 顺手去掉 tune 写进去的 node_args，避免残留一个已不需要的上限 */
      next = next.replace(/^\s*node_args\s*:\s*--max-old-space-size=\d+\s*\n/m, '')
      if (next !== old) {
        fs.writeFileSync(pm2Path, next)
        fallback.push(`${PM2}: max_memory_restart → ${TUNE_ORIGINAL.pm2Memory}、去掉 node_args`)
      }
    }
  }

  return { restored, fallback }
}
