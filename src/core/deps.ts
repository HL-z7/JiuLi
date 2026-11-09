/**
 * 系统外部命令自检与补装
 *
 * 插件普遍依赖外部命令（ffmpeg 用于转视频 / 合成语音 / 图片合成），
 * 缺了只在插件运行时报 `Command failed: ffmpeg …`，从报错里很难看出是缺命令。
 * 这里在启动后自检一次：能装就自动装，装不了给出安装命令。
 */
import util from './util.js'
import { logger } from './log.js'

export interface SystemDep {
  /** 命令名 */
  cmd: string
  /** 缺了会影响什么 */
  desc: string
  /** Linux 各发行版的包名 */
  pkg: { apt: string; dnf: string; yum: string }
  /** Windows 的 winget 包 id */
  winget?: string
  /** macOS 的 brew 包名 */
  brew?: string
}

/** 需要自检的外部命令 */
export const SYSTEM_DEPS: SystemDep[] = [
  {
    cmd: 'ffmpeg',
    desc: '插件转视频 / 合成语音 / 图片合成',
    pkg: { apt: 'ffmpeg', dnf: 'ffmpeg', yum: 'ffmpeg' },
    winget: 'Gyan.FFmpeg',
    brew: 'ffmpeg',
  },
]

/** 已探测到的命令（cmd → 路径），避免重复 shell 探测 */
const found = new Map<string, string>()

/** 探测命令路径，命中则记入缓存 */
export async function depPath(dep: SystemDep | string): Promise<string> {
  const cmd = typeof dep === 'string' ? dep : dep.cmd
  const cached = found.get(cmd)
  if (cached) return cached
  const path = await util.cmdPath(cmd)
  if (path) found.set(cmd, path)
  return path || ''
}

/** 当前缺失的依赖 */
export async function missingDeps(): Promise<SystemDep[]> {
  const missing: SystemDep[] = []
  for (const dep of SYSTEM_DEPS) {
    const path = await depPath(dep)
    if (!path) missing.push(dep)
    else util.makeLog('debug', `${dep.cmd} · ${path}`, 'Deps')
  }
  return missing
}

/** 是否具备自动安装条件：Linux + root，且没设 JIULI_NO_AUTO_INSTALL=1 */
export function canAutoInstall(): boolean {
  return (
    !process.env.JIULI_NO_AUTO_INSTALL &&
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0
  )
}

/** 按平台 / 发行版挑包管理器组装安装命令，都给不出则返回空串 */
async function installCommand(dep: SystemDep): Promise<string> {
  if (process.platform === 'win32') return dep.winget ? `winget install ${dep.winget}` : ''
  if (process.platform === 'darwin') return dep.brew ? `brew install ${dep.brew}` : ''
  if (await depPath('apt-get')) return `apt-get update -qq && apt-get install -y -qq ${dep.pkg.apt}`
  if (await depPath('dnf')) return `dnf install -y ${dep.pkg.dnf}`
  if (await depPath('yum')) return `yum install -y ${dep.pkg.yum}`
  return ''
}

/**
 * 自检并补装缺失的外部命令
 *
 * 调用方应当 fire-and-forget（安装 ffmpeg 这类包可能要几十秒），不要阻塞启动。
 * 返回是否全部就绪。
 */
export async function ensureDeps(): Promise<boolean> {
  const missing = await missingDeps()
  if (!missing.length) return true

  const commands: string[] = []
  for (const dep of missing) commands.push(await installCommand(dep))
  const auto = canAutoInstall()
  const tips = commands.map((cmd, i) => cmd || `请手动安装 ${missing[i].cmd}`)
  util.makeLog(
    'warn',
    `缺少系统命令 ${logger.yellow(missing.map(i => i.cmd).join(' · '))}（${missing.map(i => i.desc).join(' / ')}）\n` +
      `  ${auto ? '正在自动安装' : '安装命令（非 Linux / 非 root 需手动执行）'}：${tips.join(' && ')}`,
    'Deps',
  )
  if (!auto) return false

  for (const [i, dep] of missing.entries()) {
    if (!commands[i]) continue
    const ret = await util.exec(commands[i], { quiet: true, timeout: 600000 })
    found.delete(dep.cmd)
    const path = await depPath(dep)
    if (path) util.makeLog('mark', `${dep.cmd} 安装完成 · ${path}`, 'Deps')
    else util.makeLog('error', `${dep.cmd} 安装失败${ret.error ? ` · ${ret.error.message}` : ''}\n  可手动执行：${commands[i]}`, 'Deps')
  }
  return (await missingDeps()).length === 0
}
