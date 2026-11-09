/**
 * Runtime（e.runtime）
 *
 * 默认只做轻量挂载：不初始化用户信息，也不 import genshin 生态模块（理由见 loadGenshin）。
 * 第三方通过 Runtime.use() 注册了扩展（eagerUser）时才在分发前初始化。
 */
import type { JiuLiEvent, RenderOptions } from './types.js'
import cfg from './config/index.js'
import common from './common.js'
import Handler from './handler.js'
import { logger } from './log.js'

export interface RuntimeProvider {
  name: string
  /** 是否需要在分发前初始化用户信息 */
  eagerUser?: boolean
  initUser?: (e: JiuLiEvent, runtime: Runtime) => any
  getMysInfo?: (e: JiuLiEvent, targetType: string, runtime: Runtime) => any
  getUid?: (e: JiuLiEvent, runtime: Runtime) => any
  createMysApi?: (uid: any, ck: any, option: any, isSr: boolean, runtime: Runtime) => any
}

/** genshin 生态懒加载入口，不存在时各项为 undefined */
const genshin: Record<string, any> = { loaded: false }

/** 共享同一个 import Promise：并发拿到的不会是"加载到一半"的对象 */
let genshinLoading: Promise<Record<string, any>> | null = null

/**
 * 取 genshin 生态模块
 *
 * **只有 `Runtime.ecosystemReady`（genshin 插件已成功加载）时才真的去 import**：
 * 那些模块是 genshin 插件自己 import 的，加载成功时这里全是 ESM 缓存命中，不产生求值；
 * 插件缺失 / 加载报错时它的模块图可能停在 errored 或半求值状态，框架再 import 一次
 * 会复用这些坏模块 —— 轻则 `Cannot access 'Data' before initialization`（TDZ），
 * 重则触发 V8 Fatal（`Check failed: module->status() == kLinked …`）直接把进程干掉。
 */
function loadGenshin(): Promise<Record<string, any>> {
  if (!Runtime.ecosystemReady) return Promise.resolve({ ...genshin, ready: false })
  genshinLoading ??= (async () => {
    genshin.loaded = true
    const tryImport = async (spec: string) => {
      try {
        return (await import(spec)).default
      } catch {
        return undefined
      }
    }
    genshin.gsCfg = await tryImport('../../plugins/genshin/model/gsCfg.js')
    genshin.MysApi = await tryImport('../../plugins/genshin/model/mys/mysApi.js')
    genshin.MysInfo = await tryImport('../../plugins/genshin/model/mys/mysInfo.js')
    genshin.NoteUser = await tryImport('../../plugins/genshin/model/mys/NoteUser.js')
    genshin.MysUser = await tryImport('../../plugins/genshin/model/mys/MysUser.js')
    genshin.Version = await tryImport('#miao')
    if (genshin.Version) genshin.Version = genshin.Version.Version
    return genshin
  })()
  return genshinLoading
}

export default class Runtime {
  static providers: RuntimeProvider[] = []

  /** 注册扩展（第三方生态接入点） */
  static use(provider: RuntimeProvider) {
    this.providers.push(provider)
    return this
  }

  /**
   * genshin 插件是否已成功加载（由 loader 在导入成功后标记）
   *
   * 只有它为 true 时才允许框架去 import 生态模块：那些模块已经由插件正常求值完，
   * import 是纯缓存命中；插件没加载好时框架一律不碰它的模块图（见 loadGenshin 注释）。
   */
  static ecosystemReady = false

  /** 由 loader 调用：plugins/genshin 导入成功 */
  static markEcosystemReady() {
    this.ecosystemReady = true
  }

  /**
   * 已加载的 genshin 生态模块：`{ gsCfg, MysApi, MysInfo, NoteUser, MysUser, Version }`
   *
   * 未安装 / 未成功加载 genshin 时各项为 undefined。框架自带的兼容层（如云崽 ck 文件导出）
   * 用它读用户 ck，这样第三方插件的数据结构变化只影响这一处。
   */
  static async ecosystem() {
    return loadGenshin()
  }

  e: JiuLiEvent
  handler: { has: typeof Handler.has; call: typeof Handler.call; callAll: typeof Handler.callAll }
  private _mysInfo: Record<string, any> = {}
  private _userReady?: Promise<any>

  constructor(e: JiuLiEvent) {
    this.e = e
    this.handler = {
      has: Handler.has,
      call: Handler.call,
      callAll: Handler.callAll,
    }
  }

  /** 兼容：云崽在分发前调用 Runtime.init(e) */
  static async init(e: JiuLiEvent) {
    const runtime = new Runtime(e)
    e.runtime = runtime
    if (Runtime.providers.some(p => p.eagerUser)) await runtime.ready()
    return runtime
  }

  /** JiuLi：轻量挂载，重活留给首次访问 */
  static attach(e: JiuLiEvent) {
    if (e.runtime) return e.runtime
    const runtime = new Runtime(e)
    Object.defineProperty(e, 'runtime', {
      value: runtime,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    if (Runtime.providers.length) runtime.ready().catch(() => {})
    return runtime
  }

  /** 用户信息懒初始化，重复调用复用同一 Promise */
  ready() {
    this._userReady ??= (async () => {
      for (const provider of Runtime.providers) if (provider.initUser) await provider.initUser(this.e, this)
      if (!Runtime.providers.length) {
        const g = await loadGenshin()
        if (g.NoteUser) await this.initUser()
      }
      return this
    })()
    return this._userReady
  }

  get uid() {
    return this.user?.uid
  }

  get hasCk() {
    return this.user?.hasCk
  }

  get user() {
    return this.e.user
  }

  get cfg() {
    return cfg
  }

  get common() {
    return common
  }

  get gsCfg() {
    return genshin.gsCfg
  }

  get MysInfo() {
    return genshin.MysInfo
  }

  get NoteUser() {
    return genshin.NoteUser
  }

  get MysUser() {
    return genshin.MysUser
  }

  /** 包装 NoteUser，自动补上 e.game 参数（云崽行为） */
  async initUser() {
    const g = await loadGenshin()
    if (!g.NoteUser) return
    const e = this.e
    const user = await g.NoteUser.create(e)
    if (user) {
      e.user = new Proxy(user, {
        get(self: any, key: string) {
          const game = e.game
          const fnMap: Record<string, string> = {
            uid: 'getUid',
            uidList: 'getUidList',
            mysUser: 'getMysUser',
            ckUidList: 'getCkUidList',
          }
          if (fnMap[key]) return self[fnMap[key]](game)
          if (key === 'uidData') return self.getUidData('', game)
          if (['getUid', 'getUidList', 'getMysUser', 'getCkUidList', 'getUidMapList', 'getGameDs'].includes(key))
            return (_game: string, arg2: any) => self[key](_game || game, arg2)
          if (['getUidData', 'hasUid', 'addRegUid', 'delRegUid', 'setMainUid'].includes(key))
            return (uid: any, _game = '') => self[key](uid, _game || game)
          return self[key]
        },
      })
    }
  }

  async getMysInfo(targetType = 'all') {
    for (const provider of Runtime.providers)
      if (provider.getMysInfo) return provider.getMysInfo(this.e, targetType, this)

    const g = await loadGenshin()
    if (!g.MysInfo) return false
    if (!this._mysInfo[targetType])
      this._mysInfo[targetType] = await g.MysInfo.init(this.e, targetType === 'cookie' ? 'detail' : 'roleIndex')
    return this._mysInfo[targetType]
  }

  async getUid() {
    for (const provider of Runtime.providers) if (provider.getUid) return provider.getUid(this.e, this)
    const g = await loadGenshin()
    return g.MysInfo ? g.MysInfo.getUid(this.e) : undefined
  }

  async getMysApi(targetType = 'all', option: any = {}, isSr = false) {
    for (const provider of Runtime.providers)
      if (provider.createMysApi) {
        const mys = await this.getMysInfo(targetType)
        if (!mys?.uid || !mys?.ckInfo?.ck) return false
        return provider.createMysApi(mys.uid, mys.ckInfo.ck, option, isSr, this)
      }

    const mys: any = await this.getMysInfo(targetType)
    const g = await loadGenshin()
    if (mys?.uid && mys?.ckInfo?.ck && g.MysApi) {
      if (isSr) option.game = 'sr'
      return new g.MysApi(mys.uid, mys.ckInfo.ck, option)
    }
    return false
  }

  createMysApi(uid: any, ck: any, option: any, isSr = false) {
    for (const provider of Runtime.providers)
      if (provider.createMysApi) return provider.createMysApi(uid, ck, option, isSr, this)
    if (isSr) option.game = 'sr'
    if (!genshin.MysApi) return false
    return new genshin.MysApi(uid, ck, option)
  }

  /** 渲染并发送图片，兼容云崽 e.runtime.render；cfg 见 RenderOptions */
  async render(pluginName: string, path: string, data: any = {}, cfgIn: RenderOptions = {}) {
    const { default: renderService } = await import('./render/index.js')

    let filePath = path.replace(/.html$/, '')
    const paths = filePath.split('/').filter(Boolean)
    filePath = paths.join('/')

    await (globalThis as any).Bot.mkdir(`temp/html/${pluginName}/${filePath}`)

    // 模板产物位于 temp/html/<插件>/<子路径>/，故按层级数回退到 plugins/ 下
    const up = '../'.repeat(paths.length)
    const pluResPath = `../../../${up}plugins/${pluginName}/resources/`
    const miaoResPath = `../../../${up}plugins/miao-plugin/resources/`
    const miaoRoot = `${process.cwd()}/plugins/miao-plugin/resources/`

    let out = {
      sys: { scale: 1 },
      copyright: `Created By JiuLi`,
      _res_path: pluResPath,
      _miao_path: miaoResPath,
      _tpl_path: `${miaoRoot}common/tpl/`,
      defaultLayout: `${miaoRoot}common/layout/default.html`,
      elemLayout: `${miaoRoot}common/layout/elem.html`,

      ...data,

      _plugin: pluginName,
      _htmlPath: filePath,
      pluResPath,
      tplFile: `./plugins/${pluginName}/resources/${filePath}.html`,
      saveId: data.saveId || data.save_id || paths[paths.length - 1],
    }

    if (cfgIn.beforeRender) out = cfgIn.beforeRender({ data: out }) || out

    if (process.argv.includes('dev')) {
      const saveDir = `temp/ViewData/${pluginName}`
      await (globalThis as any).Bot.mkdir(saveDir)
      const file = `${saveDir}/${out._htmlPath.split('/').join('_')}.json`
      const fs = await import('node:fs/promises')
      await fs.writeFile(file, JSON.stringify(out))
    }

    const base64 = await renderService.screenshot(`${pluginName}/${filePath}`, out)
    if (cfgIn.retType === 'base64') return base64

    let ret: any = true
    if (base64) {
      if (cfgIn.recallMsg) ret = await this.e.reply?.(base64, false, {})
      else ret = await this.e.reply?.(base64)
    }
    return cfgIn.retType === 'msgId' ? ret : true
  }
}

export { logger }
