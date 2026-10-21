/**
 * 日志系统，兼容云崽 logger 形态
 * logger.logger.{defaultLogger,commandLogger,errorLogger} 各只放行自己的等级，并统一提供 isLevelEnabled。
 */
import { Chalk } from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

export const chalk = new Chalk({ level: 3 })

export type LogLevel = 'trace' | 'debug' | 'info' | 'command' | 'mark' | 'warn' | 'error' | 'fatal' | 'off'

const LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  /** 只记录真正命中指令的消息（介于 info 与 mark 之间，普通聊天不落日志） */
  command: 2.5,
  mark: 3,
  warn: 4,
  error: 5,
  fatal: 6,
  off: 7,
}

export interface LoggerChannel {
  isLevelEnabled(level: string): boolean
  trace(...args: any[]): void
  debug(...args: any[]): void
  info(...args: any[]): void
  mark(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  fatal(...args: any[]): void
}

let logLevel: LogLevel = 'info'
let logDir = 'logs'
let writeFile = true

/** 流式追加写日志，按天分文件 */
class FileWriter {
  streams = new Map<string, fs.WriteStream>()
  /**
   * 已交给流、尚未确认落盘的行：进程 exit 时用它同步补齐。
   * 写回调触发后立刻移除 —— 以前只加不减，日志量一大（或被请求刷日志）就是无界内存泄漏。
   */
  pending = new Map<string, Array<{ id: number; line: string }>>()
  private pendingBytes = new Map<string, number>()
  private seq = new Map<string, number>()
  /** 已切到同步追加的文件：切了之后不再走流，避免同一批数据被写两次 */
  synced = new Set<string>()

  /** 单文件待补写上限：超出丢最旧的（这些行早已交给流，正常运行不受影响） */
  private static MAX_PENDING_BYTES = 512 * 1024
  private static MAX_PENDING_LINES = 512
  /** 写流积压上限：磁盘慢时宁可丢日志，也不让写缓冲把内存拖垮 */
  private static MAX_STREAM_BUFFER = 2 * 1024 * 1024

  write(file: string, line: string) {
    if (!writeFile) return
    try {
      if (this.synced.has(file)) {
        fs.appendFileSync(file, line)
        return
      }
      let stream = this.streams.get(file)
      if (!stream) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        stream = fs.createWriteStream(file, { flags: 'a' })
        stream.on('error', () => {})
        this.streams.set(file, stream)
      }
      if (stream.writableLength > FileWriter.MAX_STREAM_BUFFER) return

      const id = (this.seq.get(file) || 0) + 1
      this.seq.set(file, id)
      let queue = this.pending.get(file)
      if (!queue) this.pending.set(file, (queue = []))
      queue.push({ id, line })
      let bytes = (this.pendingBytes.get(file) || 0) + line.length
      while (queue.length > FileWriter.MAX_PENDING_LINES || bytes > FileWriter.MAX_PENDING_BYTES) {
        const dropped = queue.shift()!
        bytes -= dropped.line.length
      }
      this.pendingBytes.set(file, bytes)

      stream.write(line, () => {
        const list = this.pending.get(file)
        if (!list?.length) return
        let removed = 0
        while (list.length && list[0].id <= id) removed += list.shift()!.line.length
        if (removed) this.pendingBytes.set(file, Math.max(0, (this.pendingBytes.get(file) || 0) - removed))
      })
    } catch {
      /* 日志写入失败不影响运行 */
    }
  }

  /**
   * 把还没落盘的行同步写入，并把该文件切到同步追加。
   *
   * process.exit 不会等 WriteStream 的异步写，退出前不补齐就会丢掉最后几行
   * ——端口冲突这类「打一行就退出」的场景，丢的恰好是死因。
   * 流已经接过的那部分由流自己刷，这里只补它还没拿到的；切换后不再混用两种写，
   * 否则同一批数据会被写两遍。
   */
  flushSync() {
    for (const [file, entries] of this.pending) {
      if (!entries.length) {
        this.pendingBytes.delete(file)
        continue
      }
      const text = entries.map(i => i.line).join('')
      entries.length = 0
      this.pendingBytes.delete(file)
      if (this.synced.has(file)) continue
      this.synced.add(file)
      try {
        fs.appendFileSync(file, text)
      } catch {
        /* 日志写入失败不影响退出 */
      }
      /** 流里还压着先前的数据：先让流收尾，再同步写会把顺序打乱，故不主动 end */
      const stream = this.streams.get(file)
      if (stream && !stream.closed) {
        this.streams.delete(file)
        stream.on('error', () => {})
        try {
          stream.end()
        } catch {}
      }
    }
  }

  close() {
    this.flushSync()
    for (const stream of this.streams.values()) stream.end()
    this.streams.clear()
  }
}

const fileWriter = new FileWriter()

function dateStr() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStr() {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 写文件前去除 ANSI 颜色码 */
function stripColor(str: string) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '')
}

function renderArgs(args: any[]): string {
  const parts: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg)
    else if (arg instanceof Error) parts.push(arg.stack || String(arg))
    else {
      try {
        parts.push(
          // 动态引用，避免与 util 循环依赖
          (globalThis as any).Bot?.Loging?.(arg) ?? JSON.stringify(arg),
        )
      } catch {
        parts.push(String(arg))
      }
    }
  }
  return parts.join(' ')
}

/**
 * 单行硬上限：log_length 只截每个参数，来源列等字段不受它约束，
 * 恶意请求行仍能让单行膨胀到几十 KB。日志队列再有限，也先在这里挡一道。
 */
const MAX_LOG_LINE = 32 * 1024

/** 等级配色，只作用于终端（写文件前会 stripColor） */
const LEVEL_STYLE: Record<string, (str: string) => string> = {
  trace: chalk.gray,
  debug: chalk.gray,
  info: chalk.cyan,
  command: chalk.greenBright,
  mark: chalk.magenta,
  warn: chalk.yellow,
  error: (str: string) => chalk.bold.red(str),
  fatal: (str: string) => chalk.bgRed.white(str),
}

/** 终端里的等级短名：command 太长会顶掉后面的来源列 */
const LEVEL_LABEL: Record<string, string> = { command: 'CMD' }

/** 没有携带 id 的日志（插件直接调 logger.xxx、第三方库）统一挂框架名 */
const DEFAULT_ID = 'JiuLi'

/** 与 util.makeLogID 同一套对齐规则；此处自带实现，避免 util ←→ log 循环依赖 */
function alignId(id: string) {
  const align: string | undefined = (globalThis as any).cfg?.bot?.log_align
  if (!align) return id
  const length = (align.length - id.length) / 2
  if (length > 0) return `${' '.repeat(Math.ceil(length))}${id}${' '.repeat(Math.floor(length))}`
  if (length < 0) return `${id.slice(0, align.length - 1)}.`
  return id
}

function sizeOf(level: string): 'command' | 'error' | 'default' {
  if (level === 'command' || level === 'mark' || level === 'warn') return 'command'
  if (level === 'error' || level === 'fatal') return 'error'
  return 'default'
}

/** 重复日志折叠窗口（秒，0 关闭）：插件刷同一条日志时终端只留一条 */
function dedupeWindow() {
  const sec = (globalThis as any).cfg?.bot?.log_dedupe
  if (sec === 0 || sec === false) return 0
  const n = Number(sec)
  return (Number.isFinite(n) && n > 0 ? n : 10) * 1000
}

/** 上一条日志的重复情况（只用于终端折叠，文件始终完整） */
const repeat = { key: '', level: 'info', id: undefined as any, count: 0, at: 0, startedAt: 0 }

/** 判断当前这条要不要打印；返回上一条的折叠汇总（如果有） */
function trackRepeat(key: string, level: string, id: any) {
  const window = dedupeWindow()
  if (!window) return { print: true, folded: null as any }
  const now = Date.now()
  if (key === repeat.key && now - repeat.at < window) {
    repeat.count++
    repeat.at = now
    return { print: false, folded: null }
  }
  const folded = repeat.key && repeat.count > 1 ? { ...repeat } : null
  repeat.key = key
  repeat.level = level
  repeat.id = id
  repeat.count = 1
  repeat.at = now
  repeat.startedAt = now
  return { print: true, folded }
}

function output(level: string, args: any[], id?: string | false, raw = false) {
  if (!isEnabled(level)) return
  const plain = renderArgs(args)
  const size = sizeOf(level)

  /** 按「等级 + 来源列 + 内容」拼一行；折叠汇总复用同一个格式 */
  const format = (text: string, lvl: string, sourceId: any) => {
    const style = LEVEL_STYLE[lvl] || ((str: string) => str)
    /** id 为 false 表示这行不带来源列；raw 用于长 id（如 `10001 => 20002`），不做对齐 */
    const source = sourceId ?? DEFAULT_ID
    const name = raw ? String(source) : alignId(String(source))
    const color = String(source) === DEFAULT_ID ? chalk.bold.green : chalk.blue
    const tag = sourceId === false ? '' : `${color(`[${name}]`)} `
    const label = (LEVEL_LABEL[lvl] || lvl.toUpperCase()).padEnd(5)
    return `${timeStr()} ${style(label)} ${tag}${text}`
  }

  /** 终端 + 文件；文件里始终是完整日志（含被折叠的每一条），print=false 时只写文件 */
  const emit = (text: string, lvl: string, sourceId: any, print = true) => {
    let msg = format(text, lvl, sourceId)
    if (msg.length > MAX_LOG_LINE)
      msg = `${msg.slice(0, MAX_LOG_LINE)}…[单行超限，已截断 ${msg.length - MAX_LOG_LINE} 字符]`
    if (print) {
      if (sizeOf(lvl) === 'error') console.error(msg)
      else console.log(msg)
    }

    const line = `${stripColor(msg)}\n`
    const day = dateStr()
    fileWriter.write(path.join(logDir, `jiuli.${day}.log`), line)
    /** 云崽的日志文件名，插件会直接读这两个文件（如按指令/错误列日志） */
    if (sizeOf(lvl) === 'command') fileWriter.write(path.join(logDir, `command.${day}.log`), line)
    if (sizeOf(lvl) === 'error') {
      fileWriter.write(path.join(logDir, 'error.log'), line)
      fileWriter.write(path.join(logDir, 'error', `error.${day}.log`), line)
    }
  }

  const { print, folded } = trackRepeat(`${level}|${String(id)}|${plain}`, level, id)
  /** 同一内容刷屏时，终端只留第一条 + 折叠计数；写文件不受影响 */
  if (folded)
    emit(
      `↑ 相同内容 ${Math.max(1, Math.round((folded.at - folded.startedAt) / 1000))} 秒内重复 ${folded.count} 次，已折叠（完整日志见 logs/）`,
      folded.level,
      folded.id,
    )
  emit(plain, level, id, print)
}

/** 带来源列的写入入口：框架内部（util.makeLog）用它把模块名放进日志左边那列 */
export function writeLog(level: string, id: string | false | undefined, args: any[], raw = false) {
  output(level, args, id, raw)
}

function isEnabled(level: string) {
  return LEVEL_RANK[level] >= LEVEL_RANK[logLevel]
}

/** 只放行本通道包含的等级 */
function createChannel(...levels: string[]): LoggerChannel {
  const channel: any = {}
  channel.isLevelEnabled = (level: string) => levels.includes(level) && isEnabled(level)
  for (const level of levels) {
    channel[level] = (...args: any[]) => output(level, args)
  }
  return channel as LoggerChannel
}

const defaultLogger = createChannel('trace', 'debug', 'info')
const commandLogger = createChannel('command', 'mark', 'warn')
const errorLogger = createChannel('error', 'fatal')

/** 全等级直通通道，logger.logger 同时挂载它和三个子通道 */
const anyLogger: LoggerChannel = (() => {
  const channel: any = {
    isLevelEnabled: (level: string) => isEnabled(level),
  }
  for (const level of ['trace', 'debug', 'info', 'command', 'mark', 'warn', 'error', 'fatal']) {
    channel[level] = (...args: any[]) => output(level, args)
  }
  return channel as LoggerChannel
})()

type LevelMethod = (...args: any[]) => void

type Logger = typeof chalk & {
  trace: LevelMethod
  debug: LevelMethod
  info: LevelMethod
  mark: LevelMethod
  warn: LevelMethod
  error: LevelMethod
  fatal: LevelMethod
  logger: {
    defaultLogger: LoggerChannel
    commandLogger: LoggerChannel
    errorLogger: LoggerChannel
  } & LoggerChannel
  setLevel(level: LogLevel): void
  getLevel(): LogLevel
  setWriteFile(enable: boolean): void
}

export const logger = chalk as unknown as Logger

logger.logger = Object.assign(anyLogger, {
  defaultLogger,
  commandLogger,
  errorLogger,
})

const levels: LogLevel[] = ['trace', 'debug', 'info', 'command', 'mark', 'warn', 'error', 'fatal']
for (const level of levels) {
  ;(logger as any)[level] = (...args: any[]) => (anyLogger as any)[level](...args)
}

logger.setLevel = (level: LogLevel) => {
  logLevel = level in LEVEL_RANK ? level : 'info'
}
logger.getLevel = () => logLevel
logger.setWriteFile = (enable: boolean) => {
  writeFile = enable
  if (!enable) fileWriter.close()
}
export function setLogDir(dir: string) {
  logDir = dir
}

/** 退出前同步补齐日志（process.exit 不等异步写，见 FileWriter.flushSync） */
export function flushLog() {
  fileWriter.flushSync()
}

/** 按配置初始化日志等级 */
export function setLog(level?: LogLevel) {
  logger.setLevel(level || (globalThis as any).cfg?.bot?.log_level || 'info')
}
