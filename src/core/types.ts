/** JiuLi 公共类型定义；字段命名沿用云崽（TRSS-Yunzai），旧插件零改动 */

/** 消息元素（segment） */
export interface Segment {
  type: string
  [key: string]: unknown
}

/** 发送者信息 */
export interface Sender {
  user_id?: string | number
  nickname?: string
  card?: string
  role?: string
  [key: string]: unknown
}

/** e.reply 的可选参数 */
export interface ReplyData {
  /** 撤回消息，0-120 秒，0 不撤回 */
  recallMsg?: number
  at?: boolean | string | number
  [key: string]: unknown
}

/** 事件对象（兼容云崽字段命名） */
export interface JiuLiEvent {
  [key: string]: any

  post_type: string
  message_type?: string
  notice_type?: string
  request_type?: string
  sub_type?: string

  self_id: string | number
  user_id?: string | number
  group_id?: string | number
  message_id?: string | number

  raw_message?: string
  message?: Segment[]

  /** loader 注入：文本消息 */
  msg?: string
  /** loader 注入：图片 url 数组 */
  img?: string[]
  /** loader 注入：被 at 的用户 */
  at?: string | number
  /** loader 注入：是否 at 机器人 */
  atBot?: boolean
  /** 是否群聊 / 私聊 */
  isGroup?: boolean
  isPrivate?: boolean
  isMaster?: boolean
  reply_id?: string | number
  hasAlias?: boolean
  /** 只关注主动 at 的消息 */
  only_reply_at?: boolean

  sender?: Sender
  bot?: any
  friend?: any
  group?: any
  member?: any

  reply?: (msg: any, quote?: boolean, data?: ReplyData) => Promise<any>
  recall?: (time?: number) => any
  getReply?: () => any
  /** 运行时扩展，按需挂载 */
  runtime?: any
  /** 插件链内数据传递 */
  store?: Map<string, unknown>
  /**
   * 规则命中但没插件接手时，由框架补发的具体提示
   * （插件自己不能抢先回复，否则会截胡后面插件的同名指令）
   */
  __pluginHint?: string
  raw?: unknown
}

/** 命令规则 */
export interface Rule {
  reg: RegExp | string
  /** 执行方法名，或直接传入函数（JiuLi 原生写法） */
  fnc: string | ((e: JiuLiEvent, match?: RegExpMatchArray) => any)
  /** 执行事件，默认 message */
  event?: string
  /** false 时不显示执行日志 */
  log?: boolean
  /** 权限 master / owner / admin / all */
  permission?: 'master' | 'owner' | 'admin' | 'all' | string
  [key: string]: any
}

/** 定时任务 */
export interface Task {
  name?: string
  cron: string
  /** 执行方法名，或直接传入函数 */
  fnc: string | ((...args: any[]) => any)
  /** false 时不显示执行日志 */
  log?: boolean
  [key: string]: any
}

/** 跨插件 handler */
export interface HandlerConfig {
  key?: string
  event?: string
  fnc: string | ((...args: any[]) => any)
  priority?: number
  ns?: string
  [key: string]: any
}

/** 插件构造参数 */
export interface PluginOptions {
  name?: string
  dsc?: string
  event?: string
  priority?: number
  rule?: Rule[]
  task?: Task | Task[]
  handler?: HandlerConfig | HandlerConfig[]
  namespace?: string
  [key: string]: any
}

/** 适配器契约 */
export interface Adapter {
  id: string
  name: string
  /** 唯一路径，用于去重 */
  path: string
  load: () => any
  [key: string]: any
}

/** 插件类（可被 new 的构造函数） */
export interface PluginClass {
  new (e?: JiuLiEvent): any
  prototype: any
}

/** 已加载插件条目 */
export interface PluginEntry {
  plugin: any
  class: PluginClass
  /** 来源文件 key，如 system/add.js */
  key: string
  name: string
  /**
   * 插件声明的优先级，升序匹配（小的先）。
   *
   * 允许 undefined：插件是任意外部对象，漏传 / 显式传 undefined 都可能发生
   * （实测占位、降级类最容易漏）。排序时由 loader 兜底成默认值，
   * 这里如实标注，避免调用方以为拿到的一定是数字。
   */
  priority: number | undefined
  namespace: string
  /**
   * 首次加载的顺序号（重载后不变）。
   * priority 相同时按它排序，保证重载过的插件不会掉到同优先级队伍的最后、
   * 从而改变指令归属（见 loader 的 sortPriority）。
   */
  order?: number
  /** 事件索引桶 */
  events?: string[]
}

/** 渲染配置 */
export interface RenderOptions {
  /** 返回值类型：default/空 自动发送图片；msgId 返回消息 id；base64 返回 base64 */
  retType?: 'default' | 'msgId' | 'base64' | string
  recallMsg?: boolean
  /** 渲染前改写 data */
  beforeRender?: (data: { data: any }) => any
  [key: string]: any
}

/** 插件性能指标 */
export interface PluginMetric {
  name: string
  key: string
  count: number
  total: number
  max: number
  last: number
  lastAt: number
}
