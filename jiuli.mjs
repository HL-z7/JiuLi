#!/usr/bin/env node
/**
 * JiuLi CLI
 *
 * 一条命令完成安装 / 构建 / 启动 / 管理：
 *   pnpm i && pnpm start        安装依赖后一键后台启动（自动构建 + 生成配置）
 *   node jiuli.mjs init         安装依赖 + 构建 + 生成配置
 *   node jiuli.mjs start [--fg] 启动（默认 pm2 后台，--fg 前台）
 *   node jiuli.mjs stop|rs|log  停止 / 重启 / 查看日志
 *   node jiuli.mjs build|status
 */
import { spawnSync, spawn } from 'node:child_process'
import { createRequire, builtinModules } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { applyTune, hasTuneBackup, readNumber, readTune, revertTune, TUNE_DEFAULTS } from './lib/tune.js'

const CWD = process.cwd()
const nodeBuiltins = new Set(builtinModules)
const isWin = process.platform === 'win32'

const color = (code, text) => `\u001b[${code}m${text}\u001b[0m`
const info = t => console.log(`${color(36, '[JiuLi]')} ${t}`)
const ok = t => console.log(`${color(32, '[JiuLi]')} ${t}`)
const warn = t => console.log(`${color(33, '[JiuLi]')} ${t}`)
const fail = t => {
  console.error(`${color(31, '[JiuLi]')} ${t}`)
  process.exit(1)
}

/** 本地 pm2 可执行文件（找不到则回退 npx） */
function pm2Bin() {
  const bin = path.join(CWD, 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2')
  return fs.existsSync(bin) ? bin : null
}

function run(cmd, args, opts = {}) {
  return spawnCmd(cmd, args, { stdio: 'inherit', cwd: CWD, ...opts })
}

/**
 * Windows 下 .cmd 需要 shell；把命令拼成单字符串避免 DEP0190 警告。
 * 含 cmd 特殊字符（^ & | < > 括号、空格、引号，如 pnpm 的 @^1.2.3 版本号）的参数要加引号，
 * 否则 ^ 会被 cmd 当转义符吃掉。
 */
function spawnCmd(bin, args = [], opts = {}) {
  if (isWin) {
    const line = [bin, ...args]
      .map(a => (/[\s"^&|<>()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
      .join(' ')
    return spawnSync(line, { shell: true, ...opts })
  }
  return spawnSync(bin, args, opts)
}

function hasPm2() {
  const bin = pm2Bin()
  const ret = bin
    ? spawnCmd(bin, ['-v'], { stdio: 'ignore', cwd: CWD })
    : spawnSync('npx', ['--no-install', 'pm2', '-v'], { stdio: 'ignore', cwd: CWD })
  return ret.status === 0
}

function pm2(args) {
  const bin = pm2Bin()
  if (!bin) fail('未找到 pm2，请先执行 pnpm install（或 npm i -g pm2）')
  return spawnCmd(bin, args, { stdio: 'inherit', cwd: CWD })
}

/* ==================== 参数解析 ==================== */

/** 编辑距离（相邻字符互换算一次）：用于把 --naem / --dri 这类拼错提示成 --name / --dir */
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1)
    }
  return dp[a.length][b.length]
}

/**
 * 极简参数解析：未知选项、多余的位置参数都直接报错退出（不再默默忽略）
 * flags 为开关，values 为取值选项（支持 --k v 与 --k=v）
 */
function parseArgs(args, { flags = [], values = [], usage = '', rest = 0 } = {}) {
  const out = { flags: new Set(), values: new Map(), rest: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) {
      out.rest.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (flags.includes(key)) {
      out.flags.add(key)
      continue
    }
    if (values.includes(key)) {
      const val = inline ?? args[++i]
      if (val === undefined || val.startsWith('-')) fail(`${usage}\n  ${key} 后面要跟一个值`)
      out.values.set(key, val)
      continue
    }
    /** 拼错时给出最接近的选项（--dri → --dir，而不是先命中的 --dsl） */
    const near = [...flags, ...values]
      .map(k => ({ k, d: distance(k, key) }))
      .filter(i => i.d <= 2)
      .sort((a, b) => a.d - b.d)[0]?.k
    fail(`${usage}\n  未知选项 ${key}${near ? `，是想写 ${near} 吗？` : ''}`)
  }
  if (out.rest.length > rest) fail(usage)
  return out
}

/* ==================== tmux / screen 会话 ==================== */

/** 会话名（可用 JIULI_SESSION 覆盖） */
const SESSION = process.env.JIULI_SESSION || 'jiuli'

function hasCmd(cmd) {
  /** 拼成单字符串：带 shell 时再传 args 会触发 DEP0190 警告 */
  const line = isWin ? `where ${cmd}` : `command -v ${cmd}`
  return spawnSync(line, { stdio: 'ignore', shell: true }).status === 0
}

/** 服务器上没装复用终端工具时的安装提示 */
function installHint() {
  const tip = { darwin: 'brew install tmux', win32: '（Windows 请在 WSL 或用服务器）' }
  return (
    tip[process.platform] ||
    'apt install tmux   # Debian/Ubuntu\n              yum install tmux   # CentOS/RHEL\n              apk add tmux       # Alpine'
  )
}

/** 进入 tmux 会话跑起来：已存在则接管，不存在则新建并启动 */
function cmdSession(args = []) {
  const appArgs = args.filter(a => !a.startsWith('-'))

  /** 与 start 一致的前置：依赖 / 内核编译 / 配置都得先就绪（新克隆的机器上 lib/core 还是空的） */
  ensureDeps()
  ensureBuild()
  ensureConfig()
  applyNodeOptions()

  /** 已经身处 tmux / screen 里就不用再套一层，直接跑（screen 用 STY 标识） */
  if (process.env.TMUX || process.env.STY) {
    const which = process.env.TMUX ? 'tmux' : 'screen'
    info(`已在 ${which} 会话内，直接启动 …`)
    return run(process.execPath, [path.join(CWD, 'app.js'), ...appArgs])
  }

  if (hasCmd('tmux')) {
    /** 用登录 shell 起，nvm / nodenv 装的 node 也能找到；退出后留一个 shell 便于翻日志、就地重启 */
    const shell =
      process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
    const loginFlag = /\/(ba|z)sh$/.test(shell) ? '-lc' : '-c'
    const inner = `${shell} ${loginFlag} '"${process.execPath}" "${path.join(CWD, 'app.js')}" ${appArgs.join(' ')}; exec "${shell}"'`
    info(`进入 tmux 会话 ${SESSION}（不存在则新建）…`)
    const ret = run('tmux', ['new-session', '-A', '-s', SESSION, '-c', CWD, inner])
    if (ret.status === 0) {
      console.log()
      info(`脱离会话：Ctrl+B 然后按 D（进程继续跑）`)
      info(`重新接上：node jiuli attach        （历史输出：Ctrl+B 然后按 [）`)
      info(`会话列表：tmux ls                  结束会话：tmux kill-session -t ${SESSION}`)
    }
    return ret
  }

  if (hasCmd('screen')) {
    info(`进入 screen 会话 ${SESSION}（不存在则新建）…`)
    const ret = run('screen', ['-D', '-R', SESSION, process.execPath, path.join(CWD, 'app.js'), ...appArgs])
    if (ret.status === 0) info(`脱离：Ctrl+A 然后按 D · 重新接上：node jiuli attach`)
    return ret
  }

  warn('没找到 tmux / screen，无法提供「可重连的常驻会话」')
  console.log(`
  三个选择：
    1) 装一个（推荐 tmux）：${installHint()}
    2) 前台直接跑：node .（能看到日志也能敲指令，但 SSH 断开就结束）
    3) 纯后台常驻：node jiuli s，日志用 node jiuli l -f 看（没有终端交互，重启请在 QQ 里发 #重启）
`)
  return { status: 1 }
}

/** 接回已有会话 */
function cmdAttach() {
  if (process.env.TMUX || process.env.STY) {
    return info(`已经在 ${process.env.TMUX ? 'tmux' : 'screen'} 会话里了`)
  }
  if (hasCmd('tmux')) {
    const has = spawnCmd('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' })
    if (has.status !== 0) fail(`没有名为 ${SESSION} 的会话，先执行：node jiuli m`)
    info(`接上会话 ${SESSION} …`)
    return run('tmux', ['attach', '-t', SESSION])
  }
  if (hasCmd('screen')) return run('screen', ['-D', '-R', SESSION])
  fail('没找到 tmux / screen，无法接回会话')
}

/** 依赖检查 */
function ensureDeps({ auto = true } = {}) {
  /** 判运行时依赖：release 分支是预编译产物，package.json 里没有 devDependencies（不含 typescript） */
  if (fs.existsSync(path.join(CWD, 'node_modules', 'ws'))) return true
  if (!auto) return false
  info('未检测到依赖，正在安装（pnpm install）…')
  const ret = run('pnpm', ['install'])
  if (ret.status !== 0) fail('依赖安装失败，请检查网络或包管理器')
  return true
}

/** 构建检查：lib/core 与 lib/index.js 存在且不比 src 旧 */
function srcNewerThanBuild() {
  const marker = path.join(CWD, 'lib', 'index.js')
  if (!fs.existsSync(marker)) return true
  const srcDir = path.join(CWD, 'src')
  if (!fs.existsSync(srcDir)) return false
  const buildTime = fs.statSync(marker).mtimeMs
  const walk = dir => {
    let newest = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      const t = entry.isDirectory() ? walk(p) : fs.statSync(p).mtimeMs
      if (t > newest) newest = t
    }
    return newest
  }
  return walk(srcDir) > buildTime
}

function ensureBuild({ auto = true } = {}) {
  if (fs.existsSync(path.join(CWD, 'lib', 'core')) && !srcNewerThanBuild()) return true
  if (!auto) return false
  info('正在编译内核（tsc）…')
  const ret = run(isWin ? 'npx.cmd' : 'npx', ['tsc'])
  if (ret.status !== 0) fail('编译失败，请检查 src/ 下的 TypeScript 错误')
  ok('内核编译完成')
  return true
}

/** 生成默认配置（由框架本体负责，这里只做提示） */
function ensureConfig() {
  if (fs.existsSync(path.join(CWD, 'config', 'config', 'bot.yaml')))
    return ok('检测到用户配置 config/config/')
  info('首次启动将自动生成 config/config/（默认配置）')
}

/**
 * 把 bot.yaml 的 max_old_space_size 注入接下来启动的 bot 进程。
 * Node 不接受运行中改老生代上限，只能靠 NODE_OPTIONS 传给子进程；
 * pm2 模式走 config/pm2.yaml 的 node_args（由 node jiuli tune 写入）。
 */
function applyNodeOptions() {
  const file = [
    path.join(CWD, 'config', 'config', 'bot.yaml'),
    path.join(CWD, 'config', 'default_config', 'bot.yaml'),
  ].find(f => fs.existsSync(f))
  if (!file) return
  let size = 0
  try {
    size = readNumber(fs.readFileSync(file, 'utf8'), 'max_old_space_size') || 0
  } catch {
    return
  }
  if (!(size > 0)) return
  if (String(process.env.NODE_OPTIONS || '').includes('--max-old-space-size')) return
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${size}`.trim()
  info(`V8 老生代上限 ${size}MB（config/config/bot.yaml → max_old_space_size）`)
}

/** 一键内存优化：写配置 + 提示生效方式；--revert 按优化前的备份还原 */
function cmdTune(args = []) {
  const { flags, values } = parseArgs(args, {
    flags: ['--show', '-s', '--revert', '--restore'],
    values: ['--heap', '--idle', '--restart-num'],
    usage: '用法：node jiuli tune [--heap 512] [--idle 10] [--restart-num 50] | --show | --revert',
  })

  if (flags.has('--revert') || flags.has('--restore')) {
    const { restored, fallback } = revertTune(CWD)
    if (restored.length) {
      ok('已还原到优化前：')
      for (const r of restored) console.log(`  ${r}（从 .tune-bak 恢复）`)
    } else if (fallback.length) {
      warn('没找到优化前的备份，已写回框架默认值：')
      for (const f of fallback) console.log(`  ${f}`)
    } else {
      return ok('没有需要还原的配置')
    }
    info('生效方式：#重启；pm2 模式用 node jiuli stop && node jiuli start')
    return
  }

  const fmt = v => (v === undefined || v === null ? '未配置' : v)
  const cur = readTune(CWD)

  if (flags.has('--show') || flags.has('-s')) {
    info('当前内存相关配置：')
    console.log(`  config/config/bot.yaml → max_old_space_size : ${fmt(cur.heap)}`)
    console.log(`  renderers/puppeteer/config.yaml → idleTime  : ${fmt(cur.idle)}（分钟，0=不自动关）`)
    console.log(`  renderers/puppeteer/config.yaml → restartNum: ${fmt(cur.restartNum)}（张）`)
    console.log(`  优化前备份：${hasTuneBackup(CWD) ? '有（node jiuli tune --revert 可还原）' : '无'}`)
    info(`推荐值：${TUNE_DEFAULTS.heap} / ${TUNE_DEFAULTS.idle} / ${TUNE_DEFAULTS.restartNum}，执行 node jiuli tune 应用`)
    return
  }

  const { changes, values: applied } = applyTune(CWD, {
    heap: values.get('--heap'),
    idle: values.get('--idle'),
    restartNum: values.get('--restart-num'),
  })
  if (!changes.length) return ok('已是最优配置，无需改动')
  ok('已应用内存优化：')
  for (const c of changes) console.log(`  ${c}`)
  info(`生效方式：#重启 即可（守护进程按配置注入 --max-old-space-size=${applied.heap}）`)
  info('pm2 模式请用 node jiuli stop && node jiuli start（pm2 restart 不重读 pm2.yaml）')
  info('想还原：node jiuli tune --revert')
  info('想再压低运行时缓存占用，可配合定时重启：config/config/bot.yaml → restart_cron')
}

/* ---------------- 命令 ---------------- */

function cmdInit() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) fail(`需要 Node.js >= 20，当前 ${process.version}`)
  ensureDeps()
  ensureBuild()
  ensureConfig()
  if (!hasPm2()) warn('未检测到 pm2（依赖内自带，执行 pnpm install 后可用）')
  ok('初始化完成。启动：node jiuli.mjs start（后台）或 node jiuli.mjs start --fg（前台）')
}

function cmdStart(args) {
  const { flags, rest } = parseArgs(args, {
    flags: ['--fg', '-f'],
    usage: '用法：node jiuli s [--fg]',
    rest: 1,
  })
  const fg = flags.has('--fg') || flags.has('-f')
  ensureDeps()
  ensureBuild()
  ensureConfig()
  applyNodeOptions()

  if (fg) {
    info('前台启动（Ctrl+C 退出）…')
    const child = spawn(process.execPath, ['.'], { stdio: 'inherit', cwd: CWD })
    child.on('exit', code => process.exit(code ?? 0))
    return
  }

  if (!hasPm2()) {
    warn('未找到 pm2，改为前台启动（可用 pnpm add -D pm2 后使用后台模式）')
    const child = spawn(process.execPath, ['.'], { stdio: 'inherit', cwd: CWD })
    child.on('exit', code => process.exit(code ?? 0))
    return
  }

  const pm2File = path.join(CWD, 'config', 'pm2.yaml')
  if (!fs.existsSync(pm2File)) fail('缺少 config/pm2.yaml，请先运行一次 node . （会自动生成）')
  info('pm2 后台启动…')
  pm2(['start', 'config/pm2.yaml'])
  pm2(['save'])
  ok('已后台运行。查看日志：node jiuli.mjs log；重启：node jiuli.mjs rs；停止：node jiuli.mjs stop')
}

function cmdStop() {
  pm2(['delete', 'JiuLi'])
  pm2(['save'])
  ok('已停止 JiuLi')
}

function cmdRestart() {
  pm2(['restart', 'JiuLi'])
  ok('已重启 JiuLi')
}

function cmdLog(args) {
  const lines = args.find(a => /^\d+$/.test(a)) || '100'
  /** --follow/-f 时持续输出，默认打印最近若干行后退出 */
  const follow = args.includes('--follow') || args.includes('-f')
  pm2(follow ? ['logs', 'JiuLi', '--lines', String(lines)] : ['logs', 'JiuLi', '--lines', String(lines), '--nostream'])
}

function cmdBuild() {
  ensureDeps()
  const ret = run(isWin ? 'npx.cmd' : 'npx', ['tsc'])
  if (ret.status !== 0) fail('编译失败')
  ok('内核编译完成')
}

function cmdStatus() {
  const pkg = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8'))
  console.log(`JiuLi v${pkg.version}`)
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`)
  console.log(`依赖：${fs.existsSync(path.join(CWD, 'node_modules')) ? '已安装' : '未安装'}`)
  console.log(`构建：${fs.existsSync(path.join(CWD, 'lib', 'index.js')) ? '已构建' : '未构建'}`)
  console.log(`配置：${fs.existsSync(path.join(CWD, 'config', 'config', 'bot.yaml')) ? '已生成' : '未生成'}`)
  console.log(`pm2 ：${hasPm2() ? '可用' : '不可用'}`)
  if (hasPm2()) pm2(['list'])
}

function cmdCreate(args) {
  const USAGE = '用法：node jiuli c <插件名> [--dsl] [--dir]'
  const { flags, rest } = parseArgs(args, { flags: ['--dsl', '--dir'], usage: USAGE, rest: 1 })
  const name = rest[0]
  const dsl = flags.has('--dsl')
  const asDir = flags.has('--dir')
  if (!name) fail(USAGE)
  if (!/^[\p{L}\p{N}._-]+$/u.test(name)) fail('插件名只能包含字母、数字、汉字、点、下划线、连字符')

  const tplDir = path.join(CWD, 'templates', dsl ? 'plugin-dsl' : 'plugin-class')
  if (!fs.existsSync(tplDir)) fail(`缺少模板目录 ${tplDir}`)

  const className = /^[a-zA-Z0-9._-]+$/.test(name)
    ? name
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(s => s[0].toUpperCase() + s.slice(1))
        .join('') || 'MyPlugin'
    : name.replace(/[^\p{L}\p{N}_$]/gu, '') || 'MyPlugin'
  const render = text => text.replaceAll('{{name}}', name).replaceAll('{{ClassName}}', className)

  /** 默认：生成到 plugins/example/<名字>.js（你自己的插件目录，改动即时热重载） */
  if (!asDir) {
    const target = path.join(CWD, 'plugins', 'example', `${name}.js`)
    if (fs.existsSync(target)) fail(`plugins/example/${name}.js 已存在`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, render(fs.readFileSync(path.join(tplDir, 'index.js'), 'utf8')))
    ok(`已创建 plugins/example/${name}.js（${dsl ? 'DSL' : '类'}形态 · 保存后 2 秒内自动生效）`)
    console.log('  文档：docs/plugin-guide.md · docs 里的目录说明：plugins/README.md')
    return
  }

  /** --dir：生成独立插件目录（适合带 apps/、resources/、package.json 的插件） */
  const target = path.join(CWD, 'plugins', name)
  if (fs.existsSync(target)) fail(`plugins/${name} 已存在`)
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name)
      const dest = path.join(to, entry.name)
      if (entry.isDirectory()) copyDir(src, dest)
      else fs.writeFileSync(dest, render(fs.readFileSync(src, 'utf8')))
    }
  }
  copyDir(tplDir, target)
  fs.mkdirSync(path.join(target, 'resources'), { recursive: true })
  /** 带自己的 package.json 的插件需要显式声明框架依赖，否则 import 'jiuli' 解析不到 */
  fs.writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: name,
        version: '0.0.0',
        private: true,
        type: 'module',
        description: '插件依赖清单：需要什么库就加到 dependencies，然后 pnpm install',
        dependencies: { jiuli: 'link:../..' },
      },
      null,
      2,
    )}\n`,
  )

  ok(`已创建 plugins/${name}/index.js（独立目录形态）`)
  console.log(`  编辑：plugins/${name}/index.js · 模板放 plugins/${name}/resources/`)
  console.log(`  依赖：plugins/${name}/package.json（已声明 jiuli，需要别的库加进去后 pnpm install）`)
  console.log('  生效：改动 js 后等 2 秒自动重载（或 #重载）')
  console.log('  文档：docs/plugin-guide.md')
}

/** 安装第三方插件：克隆到 plugins/ 下并安装依赖 */
function cmdAdd(args) {
  const USAGE = '用法：node jiuli a <git地址> [--name 目录名]'
  const { values, rest } = parseArgs(args, { values: ['--name'], usage: USAGE, rest: 1 })
  const url = rest[0]
  if (!url) fail(USAGE)
  const name =
    values.get('--name') ||
    url
      .split('/')
      .pop()
      .replace(/\.git$/, '')

  const target = path.join(CWD, 'plugins', name)
  if (fs.existsSync(target)) fail(`plugins/${name} 已存在，如需更新请进入该目录 git pull`)

  info(`克隆插件 → plugins/${name}`)
  const clone = spawnCmd('git', ['clone', '--depth', '1', url, target], { stdio: 'inherit', cwd: CWD })
  if (clone.status !== 0) fail('克隆失败，请检查仓库地址与网络')

  if (!ensureDeps({ auto: false }) && !fs.existsSync(path.join(CWD, 'node_modules'))) fail('请先执行 pnpm install')
  info('安装依赖（pnpm install）…')
  const inst = run('pnpm', ['install'])
  if (inst.status !== 0) {
    warn('依赖安装失败，请手动在项目根目录执行 pnpm install')
  } else ok('依赖安装完成')

  console.log('  下一步：运行中的实例会在 2 秒内自动加载（或发 #重载 / 重启实例）')
}

function cmdList() {
  const dir = path.join(CWD, 'plugins')
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const files = fs.readdirSync(path.join(dir, entry.name)).filter(f => f.endsWith('.js'))
    const hasIndex = files.includes('index.js')
    console.log(`  ${entry.name.padEnd(28, ' ')} ${hasIndex ? 'index.js' : `${files.length} 个 js`}`)
  }
}

function cmdFlush() {
  pm2(['flush', 'JiuLi'])
  ok('已清空 pm2 日志文件（下次 pnpm log 只显示新日志）')
}

/* ==================== 插件依赖 ==================== */

/** 递归列出插件代码文件（跳过资源 / 前端产物 / 依赖目录，它们里面的 import 不参与解析） */
function walkFiles(dir, out = []) {
  const SKIP_DIR = ['node_modules', '.git', 'temp', 'dist', 'logs', 'data', 'resources', 'web', 'static', 'assets', 'public']
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIR.includes(entry.name) || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.min.js')) out.push(full)
  }
  return out
}

/** 从源码里抓 import / require / import() 的裸包名；返回包名集合（子路径归到包名） */
function scanSpecifiers(code) {
  const found = new Set()
  const re = /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+|\bimport\s+)['"]([^'"]+)['"]/g
  for (const m of code.matchAll(re)) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || spec.startsWith('node:')) continue
    if (nodeBuiltins.has(spec)) continue
    /** 取包名部分：@scope/name/子路径 → @scope/name */
    const parts = spec.split('/')
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    /** 过滤掉正则误匹配出来的东西（空格 / 括号 / 引号等都不是合法包名） */
    if (!/^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i.test(name)) continue
    found.add(name)
  }
  return found
}

/** 最近的 package.json（用于取依赖声明的版本） */
function nearestPackage(dir) {
  let cur = dir
  while (cur.startsWith(CWD)) {
    const pkg = path.join(cur, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        return JSON.parse(fs.readFileSync(pkg, 'utf8'))
      } catch {
        return {}
      }
    }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return {}
}

/**
 * 一键安装松散 JS 插件的依赖
 *
 * 只管「没有 index.js 的平铺插件目录」（如 plugins/example/）——这类插件的 import 没有
 * 任何地方声明依赖。插件包（miao-plugin 等有 index.js 的）依赖由各自 package.json 负责，
 * 跑 pnpm i 即可，扫它们只会报出一堆假缺失。
 */
function cmdDeps(args) {
  const USAGE = '用法：node jiuli deps [--dry]'
  const { flags } = parseArgs(args, { flags: ['--dry'], usage: USAGE })
  const dry = flags.has('--dry')

  const pluginDir = path.join(CWD, 'plugins')
  if (!fs.existsSync(pluginDir)) fail('没有 plugins/ 目录')

  const loose = []
  let packaged = 0
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(pluginDir, entry.name)
    if (fs.existsSync(path.join(dir, 'index.js'))) packaged++
    else loose.push(dir)
  }
  if (!loose.length) return ok('没有需要扫描的松散 JS 插件目录（插件包的依赖由 pnpm i 负责）')

  const names = loose.map(d => path.relative(CWD, d).replace(/\\/g, '/'))
  info(`扫描松散 JS 插件目录：${names.join(' · ')}　（另有 ${packaged} 个插件包的依赖由 pnpm i 负责）`)

  /** 每个目录缺哪些包（同一目录的合成一条 pnpm add） */
  const targets = new Map()
  let scanned = 0
  for (const dir of loose) {
    const files = walkFiles(dir).filter(f => /\.(js|mjs|cjs)$/.test(f))
    scanned += files.length
    const missing = targets.get(dir) || new Map()
    for (const file of files) {
      let code = ''
      try {
        code = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const spec of scanSpecifiers(code)) {
        /** 插件内部自己的文件（如 models/xx.js 这种写法）不算依赖 */
        if (fs.existsSync(path.join(path.dirname(file), spec))) continue
        try {
          createRequire(file).resolve(spec)
          continue
        } catch {}
        missing.set(spec, [...(missing.get(spec) || []), path.relative(CWD, file).replace(/\\/g, '/')])
      }
    }
    if (missing.size) targets.set(dir, missing)
  }

  const total = [...targets.values()].reduce((n, m) => n + m.size, 0)
  if (!total) return ok(`${scanned} 个插件文件，依赖齐全，没有缺失`)

  console.log()
  for (const [dir, missing] of targets) {
    info(`${path.relative(CWD, dir).replace(/\\/g, '/')} 缺失 ${missing.size} 个依赖：`)
    for (const [name, files] of missing)
      console.log(`    ${color(31, name)} ← ${files.slice(0, 3).join(' · ')}${files.length > 3 ? ' …' : ''}`)
  }
  console.log()

  /** 逐目录安装：目录自带 package.json（如 plugins/example/）就装进它，否则装到项目根 */
  const jobs = []
  for (const [dir, missing] of targets) {
    const specs = [...missing.keys()].map(name => {
      const ver = nearestPackage(dir).dependencies?.[name] || nearestPackage(dir).devDependencies?.[name]
      if (!ver || /^(link|file|workspace):/.test(ver)) return name
      return `${name}@${ver}`
    })
    const rel = path.relative(CWD, dir).replace(/\\/g, '/')
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'))
    jobs.push({
      dir,
      specs,
      args: hasPkg ? ['--dir', rel, 'add', ...specs] : ['-w', 'add', ...specs],
      text: `pnpm ${hasPkg ? `--dir ${rel} ` : '-w '}add ${specs.join(' ')}`,
    })
  }

  if (dry) {
    info('--dry：不会真的安装。将要执行：')
    for (const job of jobs) console.log(`    ${job.text}`)
    return
  }

  for (const job of jobs) {
    info(`安装中：${job.text}`)
    const ret = spawnCmd('pnpm', job.args)
    if (ret.status !== 0) {
      const detail = `${ret.stdout || ''}${ret.stderr || ''}`.trim().split('\n').slice(-3).join('\n        ')
      fail(`安装失败：\n${detail}\n        也可手动执行：${job.text}`)
    }
    ok(`已安装 ${job.specs.length} 个依赖 → ${path.relative(CWD, job.dir).replace(/\\/g, '/')}`)
  }
  ok('发 #重载 或 #重启 后生效')
}

function cmdHelp() {
  console.log(`JiuLi CLI   （node jiuli <命令> 或 node jiuli.mjs <命令>）

  命令            简写            说明
  ─────────────────────────────────────────────────────────────
  init            i             安装依赖 + 编译内核 + 生成配置
  start           s             pm2 后台启动（自动检查依赖/构建/配置）
  start --fg      f             前台启动（Ctrl+C 退出）
  session         m             在 tmux 会话里启动，可随时脱离/接回（服务器推荐）
  attach          at            接回 tmux/screen 会话（实时日志 + 可输入指令）
  stop            x             停止
  restart         r / rs        重启
  log [条数]       l             查看日志（-f 持续输出）
  status          st            环境与运行状态
  list            ls            列出 plugins/ 下的插件目录
  create <名称>    c             生成插件骨架（--dsl 函数式 / --dir 独立目录）
  add <git地址>    a             安装第三方插件（克隆到 plugins/ 并装依赖）
                                  --name 目录名 可指定插件目录名（URL 写前面）
  tune                         一键内存优化（堆上限/浏览器释放），--show 查看、--revert 还原
  build           b             编译内核
  deps            d             扫描 plugins/ 下 JS 插件，一键装齐缺失的依赖（--dry 只看不装）
  flush                         清空 pm2 日志文件
  help            h / ?         本说明

  等价 npm scripts：pnpm setup / pnpm start / pnpm stop / pnpm rs / pnpm log / pnpm build

  服务器上想「进程常驻 + 看实时日志 + 能敲 #重启」，用：
    node jiuli m         启动进 tmux（首次新建，之后接管已有会话）
    Ctrl+B 再按 D        脱离，进程继续跑（SSH 断了也不受影响）
    node jiuli attach    重新接上：日志与终端输入都还在
  会话名默认 jiuli，可用 JIULI_SESSION 覆盖。`)
}

const [cmd = 'help', ...args] = process.argv.slice(2)
/** 命令表：长命令 + 短别名 */
const commands = {
  // 安装/初始化
  init: cmdInit,
  i: cmdInit,
  setup: cmdInit,
  // 插件
  create: () => cmdCreate(args),
  c: () => cmdCreate(args),
  new: () => cmdCreate(args),
  add: () => cmdAdd(args),
  a: () => cmdAdd(args),
  install: () => cmdAdd(args),
  list: cmdList,
  ls: cmdList,
  // 运行
  start: () => cmdStart(args),
  s: () => cmdStart(args),
  run: () => cmdStart(args),
  f: () => cmdStart(['--fg']),
  fg: () => cmdStart(['--fg']),
  // 可重连的常驻会话（tmux / screen）
  session: () => cmdSession(args),
  tmux: () => cmdSession(args),
  m: () => cmdSession(args),
  attach: cmdAttach,
  at: cmdAttach,
  stop: cmdStop,
  x: cmdStop,
  kill: cmdStop,
  restart: cmdRestart,
  r: cmdRestart,
  rs: cmdRestart,
  // 观测
  log: () => cmdLog(args),
  l: () => cmdLog(args),
  logs: () => cmdLog(args),
  status: cmdStatus,
  st: cmdStatus,
  info: cmdStatus,
  flush: cmdFlush,
  // 优化
  tune: () => cmdTune(args),
  // 依赖
  deps: () => cmdDeps(args),
  d: () => cmdDeps(args),
  // 开发
  build: cmdBuild,
  b: cmdBuild,
  help: cmdHelp,
  h: cmdHelp,
  '?': cmdHelp,
}

if (!commands[cmd]) {
  warn(`未知命令：${cmd}`)
  cmdHelp()
  process.exit(1)
}
commands[cmd]()
