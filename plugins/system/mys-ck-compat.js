/**
 * 云崽 ck 文件兼容层（框架内置，随 `#更新` 分发，不改任何第三方插件）
 *
 * 背景
 *   JiuLi 把米游社 ck 存在 `data/db/data.db`，而大量云崽插件不看 DB，
 *   只按 `data/MysCookie/<qq>.yaml` 找 uid / ck —— 逍遥插件的 `#更新抽卡记录` 就是这么读的
 *   （`apps/user.js` → `gsCfg.getBingCookie`）。JiuLi 迁到 DB 后这个文件就没了，插件永远读不到，
 *   表现就是 `uid:undefined,authkey获取失败：登录状态失效，请重新登录`。
 *
 * 做法
 *   1. 旁路捕获：用户粘贴 ck 的消息里带 `login_ticket`（DB 不保存这个字段，但米游社 stoken 要用），
 *      在 beforeMessage 里记到自己的数据目录；消息照常走 genshin 的绑定流程，绝不拦截。
 *   2. 导出：把 uid / ck 按云崽 v3 的文件格式写回 `data/MysCookie/<qq>.yaml`。
 *      触发点：启动 online 后全量同步一次、ck 变动（首次绑定 / 重绑）时补写、文件被删时按需重建
 *      （genshin 启动迁移会"导入即删"，所以导出必须放在它之后）。
 *
 * 只读 sqlite，**不 import genshin 插件的任何模块**
 *   genshin 的 model/gsCfg.js、model/db/BaseModel.js 与 miao 的 `#miao` / `#miao.models` 是
 *   互相纠缠、还带顶层 await 的模块图；框架侧一旦主动 import，插件加载异常时会复用
 *   errored / 半求值的模块 —— 轻则 `Cannot access 'Data' before initialization`（TDZ），
 *   重则 V8 Fatal（`Check failed: module->status() == kLinked …`）把进程干掉。
 *   所以这里直接读 DB 文件，表结构取自 genshin 的数据层：
 *     Users(id, ltuids) · MysUsers(ltuid, type, ck, device, uids)
 *   读不到就静默跳过，绝不影响任何插件的加载。
 *
 * 注意
 *   - 只导出国服（`type: mys`）的 gs / sr uid：genshin 的迁移靠 `region_name` 猜游戏与类型，
 *     绝区零会被猜成 gs、国际服会被猜成 mys，导出去反而污染 DB；不导出时 genshin 会保留 DB 原值。
 *   - 文件由本插件维护，`data/MysCookie/` 里其它（云崽遗留）文件不动，仍交给 genshin 迁移处理。
 *   - 每次启动 genshin 迁移都会"重新导入 + 删掉"我们的文件（日志里的"DB导入V3用户ck N 个"），
 *     内容与 DB 镜像一致所以是无害的；导入完本插件会在 online 后重新写出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { Sequelize } from 'sequelize'
import { JiuLiPlugin, logger } from 'jiuli'

const DB_FILE = path.join(process.cwd(), 'data', 'db', 'data.db')
/** 云崽 v3 的 ck 文件目录（生态插件按这个路径读） */
const COOKIE_DIR = path.join(process.cwd(), 'data', 'MysCookie')
/** genshin 启动迁移会把导入过的文件备份到这里，login_ticket 可以从这里捞回来 */
const BAK_DIR = path.join(process.cwd(), 'temp', 'MysCookieBak')
/** 游戏 → 云崽 v3 的 region_name：迁移用 `region_name === '星穹列车'` 判断星铁，其余认成原神 */
const GAME_REGION = { gs: '天空岛', sr: '星穹列车' }
/** 参与导出的游戏，见文件头注释 */
const EXPORT_GAMES = ['gs', 'sr']
/** 米游社 ck 的两个特征串 */
const TICKET_RE = /login_ticket=([^;\s&'"]+)/
const CK_RE = /(ltoken|cookie_token)/

const fileOf = qq => path.join(COOKIE_DIR, `${qq}.yaml`)

/**
 * 只读 DB：取出「绑定过国服 ck 的用户 → uid 条目」
 * @param qq 指定用户；留空表示全部
 * @returns {Promise<Array<{qq: string, entries: Array<object>}>>}
 */
async function readCkData(qq = '') {
  if (!fs.existsSync(DB_FILE)) return []
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: DB_FILE, logging: false })
  try {
    const [users] = await sequelize.query(
      qq ? 'SELECT id, ltuids FROM Users WHERE id = ?' : 'SELECT id, ltuids FROM Users',
      qq ? { replacements: [String(qq)] } : {},
    )
    const [cks] = await sequelize.query('SELECT ltuid, type, ck, device, uids FROM MysUsers')
    const byLtuid = new Map(cks.map(row => [String(row.ltuid), row]))

    const ret = []
    for (const row of users) {
      const id = String(row.id || '')
      if (!id) continue
      const entries = []
      for (const ltuid of String(row.ltuids || '').split(',').filter(Boolean)) {
        const ck = byLtuid.get(String(ltuid))
        /** 只导出国服 ck，见文件头注释 */
        if (!ck?.ck || ck.type !== 'mys') continue
        let uids = {}
        try {
          uids = JSON.parse(ck.uids || '{}') || {}
        } catch {
          uids = {}
        }
        for (const game of EXPORT_GAMES)
          for (const uid of uids[game] || [])
            entries.push({
              uid: String(uid),
              game,
              ltuid: String(ltuid),
              ck: ck.ck,
              type: ck.type,
              device_id: ck.device,
            })
      }
      if (entries.length) ret.push({ qq: id, entries })
    }
    return ret
  } catch (err) {
    logger.debug(`[云崽ck兼容] 读取 ck 数据库失败：${err}`)
    return []
  } finally {
    await sequelize.close().catch(() => {})
  }
}

/**
 * 模块级状态
 *
 * beforeMessage / afterMessage 跑在加载期的共享实例上，而规则（#同步ck）跑在「每事件 new 一个」
 * 的实例上 —— 放在 this 上的状态两边不通，所以这里统一放模块级。
 */
let store = null
/** 本轮消息里捕获到 login_ticket 的用户（首次绑定时 ck 要等分发结束才入库） */
const pending = new Set()

const emptyStore = () => ({ tickets: {}, exported: {} })

export default class MysCookieCompat extends JiuLiPlugin {
  constructor() {
    super({
      name: '云崽ck兼容',
      dsc: '#同步ck',
      event: 'message',
      /** 只做旁路观察与补写，排在最后，不跟任何插件抢指令 */
      priority: Infinity,
      rule: [{ reg: '^#同步ck$', fnc: 'syncCk', permission: 'master', log: false }],
    })
  }

  async init() {
    this.loadStore()
    const sync = () => this.syncAll().catch(err => logger.debug(`[云崽ck兼容] 同步失败：${err}`))
    /**
     * online 在所有插件 init() 之后：genshin 的启动迁移（导入 data/MysCookie/ 后删文件）
     * 已经跑完，这时候导出的文件才不会被它吃掉。热重载 / 迟到加载时 online 早发过了，直接同步。
     */
    if (Bot.stat?.online === 2) sync()
    else Bot.once('online', sync)
    this.watchDb()
  }

  /**
   * 监听 ck 数据库变化：扫码登录 / 重新绑定这类流程不会发「带 login_ticket 的消息」，
   * 旁路捕获拿不到，只能靠数据库变更兜底把新 ck 导出到云崽文件。
   * sequelize 走 WAL，写入是异步的，所以做 2 秒防抖 + 单飞，避免重复全量同步。
   */
  watchDb() {
    const dir = path.dirname(DB_FILE)
    this.maybeSync = () => {
      if (this.syncTimer) return
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null
        if (this.syncing) return
        this.syncing = true
        this.syncAll()
          .catch(err => logger.debug(`[云崽ck兼容] 自动同步失败：${err}`))
          .finally(() => (this.syncing = false))
      }, 2000)
      this.syncTimer.unref?.()
    }
    try {
      /** 目录级监听：data.db / -wal / -shm 都在这个目录里，监听单个文件容易漏 */
      this.dbWatcher = fs.watch(dir, (_event, name) => {
        if (name && /^data\.db(-wal|-shm)?$/.test(String(name))) this.maybeSync()
      })
      this.dbWatcher.on('error', err => logger.debug(`[云崽ck兼容] 数据库监听失败：${err}`))
      this.dbWatcher.unref?.()
    } catch (err) {
      logger.debug(`[云崽ck兼容] 无法监听数据库目录：${err}`)
    }
    /** 兜底：文件系统事件偶发丢失时每 10 分钟补一次（内容没变不会重写） */
    this.syncTick = setInterval(() => this.maybeSync(), 10 * 60 * 1000)
    this.syncTick.unref?.()
  }

  /* ==================== 旁路捕获 ==================== */

  /**
   * 分发前：只观察，不拦截（返回 undefined）
   *
   * 粘贴的完整 ck 里有 login_ticket，DB 不存它，但米游社 stoken / genAuthKey 要用，
   * 而逍遥等插件又是从 `data/MysCookie/<qq>.yaml` 里取它的 —— 只能在这儿顺手记下来。
   */
  async beforeMessage(e) {
    const qq = String(e.user_id || '')
    const raw = String(e.raw_message || e.msg || '')
    if (qq && raw.includes('login_ticket=') && CK_RE.test(raw)) {
      const ticket = TICKET_RE.exec(raw)?.[1]
      if (ticket) this.remember(qq, ticket)
      pending.add(qq)
      /** 已有 ck 的老用户重绑：文件立刻刷新；首次绑定等 afterMessage（那时 ck 才入库） */
      const [data] = await readCkData(qq)
      await this.writeUser(data || { qq, entries: [] }, ticket)
      return
    }

    /**
     * 文件被删（genshin 启动迁移会"导入即删"）时按需重建。
     * 只对**导出过**的用户做，避免每条消息都去读一次数据库。
     */
    if (qq && this.loadStore().exported[qq] && !fs.existsSync(fileOf(qq))) {
      const [data] = await readCkData(qq)
      if (data) await this.writeUser(data)
    }
  }

  /** 分发后：ck 绑定已在本轮消息里完成，补写一次 */
  async afterMessage(e) {
    const qq = String(e.user_id || '')
    if (!qq || !pending.delete(qq)) return
    const [data] = await readCkData(qq)
    await this.writeUser(data || { qq, entries: [] }, this.ticketOf(qq))
  }

  /* ==================== 导出 ==================== */

  /** 全量同步：DB 里所有绑定过 ck 的用户 → data/MysCookie/<qq>.yaml */
  async syncAll() {
    const all = await readCkData()
    let count = 0
    for (const data of all) if (await this.writeUser(data)) count++
    /** 清理：导出过、但现在 DB 里已经没有 ck 的用户（否则文件会被 genshin 迁移灌回 DB） */
    for (const qq of Object.keys(this.loadStore().exported))
      if (!all.some(u => u.qq === qq)) await this.writeUser({ qq, entries: [] })
    if (count > 0) logger.mark(`[云崽ck兼容] 已同步 ${count} 个用户的 ck → data/MysCookie/`)
    return count
  }

  /** 手动同步（#同步ck） */
  async syncCk() {
    const count = await this.syncAll()
    return this.reply(`已同步 ${count} 个用户的 ck → data/MysCookie/`)
  }

  /**
   * 写一个用户的兼容文件
   * @param data `{ qq, entries }`（readCkData 的结果；entries 为空表示没有 ck，走清理）
   * @param loginTicket 本次消息里捕获到的 login_ticket（可选）
   */
  async writeUser(data, loginTicket = '') {
    const qq = String(data?.qq || '')
    if (!qq) return false
    const state = this.loadStore()
    const entries = data?.entries || []
    const file = fileOf(qq)

    /** 没有 ck（含已删除）：只清理我们导出过的文件，云崽遗留文件不动 */
    if (!entries.length) {
      if (state.exported[qq]) {
        if (fs.existsSync(file)) fs.unlinkSync(file)
        delete state.exported[qq]
        this.saveStore()
      }
      return false
    }

    const ticket = loginTicket || this.ticketOf(qq)
    /** 没有原神 uid 时至少留一个 isMain：逍遥用 isMain 那条取 uid / game_uid */
    const mainUid = String(entries.find(e => e.game === 'gs')?.uid || '')
    const out = {}
    for (const e of entries) {
      out[e.uid] = {
        uid: e.uid,
        qq,
        ltuid: e.ltuid,
        ck: e.ck,
        type: e.type,
        device_id: e.device_id,
        login_ticket: ticket,
        isMain: e.uid === mainUid,
        region_name: GAME_REGION[e.game],
      }
    }
    if (!Object.values(out).some(ds => ds.isMain)) Object.values(out)[0].isMain = true

    const text = `# 由 JiuLi「云崽ck兼容」自动维护：改 ck 请用 #绑定ck，不要手工编辑\n${YAML.stringify(out)}`
    /** 自动同步会频繁触发，内容没变就不落盘，避免无谓的写放大 */
    let same = false
    try {
      same = fs.readFileSync(file, 'utf8') === text
    } catch {
      same = false
    }
    if (!same) {
      fs.mkdirSync(COOKIE_DIR, { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    }
    if (!state.exported[qq]) {
      state.exported[qq] = Date.now()
      this.saveStore()
    }
    return true
  }

  /* ==================== login_ticket 存取 ==================== */

  get storeFile() {
    return path.join(this.dataDir, 'mys-ck.json')
  }

  /** 读取（只读一次）login_ticket / 导出记录 */
  loadStore() {
    if (store) return store
    try {
      const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'))
      store = { tickets: raw?.tickets || {}, exported: raw?.exported || {} }
    } catch {
      store = emptyStore()
    }
    return store
  }

  saveStore() {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true })
      fs.writeFileSync(this.storeFile, JSON.stringify(store || emptyStore(), null, 2), 'utf8')
    } catch (err) {
      logger.debug(`[云崽ck兼容] 保存 login_ticket 失败：${err}`)
    }
  }

  remember(qq, ticket) {
    this.loadStore().tickets[qq] = { login_ticket: ticket, at: Date.now() }
    this.saveStore()
  }

  /** 优先用捕获到的，其次沿用上一次导出 / 迁移备份里的（老用户不用重新绑定） */
  ticketOf(qq) {
    const saved = this.loadStore().tickets[qq]?.login_ticket
    if (saved) return saved
    for (const file of [fileOf(qq), path.join(BAK_DIR, `${qq}.yaml`)]) {
      try {
        const data = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
        for (const key in data) if (data[key]?.login_ticket) return data[key].login_ticket
      } catch {
        /* 文件不存在或格式不对，继续找下一个来源 */
      }
    }
    return ''
  }
}
