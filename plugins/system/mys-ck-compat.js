/**
 * 云崽 ck 文件兼容层（框架内置，随 `#更新` 分发，不改任何第三方插件）
 *
 * 背景
 *   JiuLi 把米游社 ck 存进插件的 sqlite（`data/Mys-plugin/db/data.db`，旧版 genshin 是
 *   `data/db/data.db`），而大量云崽插件不看 DB，只按 `data/MysCookie/<qq>.yaml` 找 uid / ck ——
 *   逍遥插件的 `#更新抽卡记录` 就是这么读的（`apps/user.js` → `gsCfg.getBingCookie`）。
 *   迁到 DB 后这个文件就没了，插件永远读不到，表现是
 *   `uid:undefined,authkey获取失败：登录状态失效，请重新登录`。
 *
 * 做法
 *   1. 导出：把 uid / ck 按云崽 v3 的文件格式写回 `data/MysCookie/<qq>.yaml`。
 *      触发点：启动 online 后全量同步一次、ck 变动（首次绑定 / 重绑）时补写、文件被删时按需重建、
 *      DB 文件变化时防抖同步。
 *   2. 旁路捕获：用户粘贴的 ck 消息里带 `login_ticket`（部分插件要它换 stoken）时记到本插件数据目录。
 *      DB 里已经有 `login_ticket` / `stoken` 列的（Mys-plugin v3）优先用库里的值。
 *   3. 默认只读；唯一会写库的是主人显式发 `#同步ck 恢复 确认`，且只补空行、不覆盖已有 ck。
 *
 * 数据库路径不写死
 *   框架没有全局 DB 配置，各插件自己定路径，所以这里扫描 `data/db/*.db` 与
 *   `data/<任意插件>/db/*.db`，凡是带 `Users` / `MysUsers` 表、且有 `mys` 类型 ck 的库都读，
 *   结果按 QQ 合并。要指定固定路径就设环境变量 `JIULI_MYS_DB`（多个用系统路径分隔符隔开）。
 *
 * 删除策略（踩过的坑）
 *   以前读库失败也返回空数组，`syncAll` 就当成"这些账号已经没有 ck"，把之前导出的文件删了。
 *   数据库换路径 / 迁移没完成 / 文件被锁 / 暂时读不到时，这一步等于把用户的 ck 兼容文件清空。
 *   现在区分「读失败」与「真的没有」：
 *     - 任何一个库读失败 → 本次只写不删；
 *     - 库里一条 ck 都没有、但导出记录还在 → 视为异常，只写不删，日志 warn；
 *     - 确认是用户自己解绑（库里还有别的 ck）才清理，而且是移动到 `temp/MysCookieBak/`，不是 unlink。
 *
 * 注意
 *   - 只导出国服（`type: mys`）的 gs / sr uid：迁移靠 `region_name` 猜游戏与类型，
 *     绝区零会被猜成 gs、国际服会被猜成 mys，导出去反而污染 DB。
 *   - 文件由本插件维护，`data/MysCookie/` 里其它（云崽遗留）文件不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { Sequelize } from 'sequelize'
import { JiuLiPlugin, logger } from 'jiuli'

const DATA_DIR = path.join(process.cwd(), 'data')
/** 云崽 v3 的 ck 文件目录（生态插件按这个路径读） */
const COOKIE_DIR = path.join(DATA_DIR, 'MysCookie')
/** 清理时把文件挪到这里，误删还能捞回来，而且不会被 genshin 启动迁移再导入 */
const BAK_DIR = path.join(process.cwd(), 'temp', 'MysCookieBak')
/** 游戏 → 云崽 v3 的 region_name：迁移用 `region_name === '星穹列车'` 判断星铁，其余认成原神 */
const GAME_REGION = { gs: '天空岛', sr: '星穹列车' }
/** 参与导出的游戏，见文件头注释 */
const EXPORT_GAMES = ['gs', 'sr']
/** 米游社 ck 的两个特征串 */
const TICKET_RE = /login_ticket=([^;\s&'"]+)/
const CK_RE = /(ltoken|cookie_token)/

const fileOf = qq => path.join(COOKIE_DIR, `${qq}.yaml`)

/** 环境变量指定的库 + `data/db/*.db` + `data/<插件>/db/*.db` */
function dbCandidates() {
  const out = new Set(
    String(process.env.JIULI_MYS_DB || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map(file => path.resolve(file)),
  )
  const pushDir = dir => {
    try {
      for (const name of fs.readdirSync(dir)) if (/\.db$/i.test(name)) out.add(path.join(dir, name))
    } catch {}
  }
  pushDir(path.join(DATA_DIR, 'db'))
  try {
    for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== 'db') pushDir(path.join(DATA_DIR, entry.name, 'db'))
  } catch {}
  return [...out].filter(file => fs.existsSync(file))
}

/**
 * 读一个库里的用户与 ck
 * @returns {Promise<{ok: boolean, users: Array<{id: string, ltuids: string}>, cks: Map<string, object>}>}
 *   ok=false 表示库存在但读失败（锁定 / 损坏 / 权限），不代表"没有数据"
 */
async function readDbFile(file) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: file, logging: false })
  try {
    const [users] = await sequelize.query('SELECT id, ltuids FROM Users')
    const [cks] = await sequelize.query('SELECT * FROM MysUsers')
    return { ok: true, users, cks: new Map(cks.map(row => [String(row.ltuid), row])) }
  } catch (err) {
    /** 没有这两张表的库不是 ck 库，不算读失败 */
    if (/no such table/i.test(String(err?.message))) return { ok: true, users: [], cks: new Map() }
    logger.debug(`[云崽ck兼容] 读取 ${path.basename(file)} 失败：${err}`)
    return { ok: false, users: [], cks: new Map() }
  } finally {
    await sequelize.close().catch(() => {})
  }
}

/**
 * 汇总所有库里的「绑定过国服 ck 的用户 → uid 条目」，同一 QQ 跨库合并
 * @param qq 指定用户；留空表示全部
 * @returns {Promise<{ok: boolean, users: Array<{qq: string, entries: Array<object>}>, files: string[]}>}
 *   ok=false：至少一个库读失败，调用方不得据此清理文件
 */
async function readCkData(qq = '') {
  const files = dbCandidates()
  const merged = new Map()
  let ok = files.length > 0
  for (const file of files) {
    const db = await readDbFile(file)
    if (!db.ok) {
      ok = false
      continue
    }
    for (const row of db.users) {
      const id = String(row.id || '')
      if (!id || (qq && id !== String(qq))) continue
      for (const ltuid of String(row.ltuids || '').split(',').filter(Boolean)) {
        const ck = db.cks.get(String(ltuid))
        /** 只导出国服 ck，见文件头注释 */
        if (!ck?.ck || ck.type !== 'mys') continue
        let uids = {}
        try {
          uids = JSON.parse(ck.uids || '{}') || {}
        } catch {
          uids = {}
        }
        if (!merged.has(id)) merged.set(id, new Map())
        const bag = merged.get(id)
        for (const game of EXPORT_GAMES) {
          for (const uid of uids[game] || []) {
            const entry = {
              uid: String(uid),
              game,
              ltuid: String(ltuid),
              ck: ck.ck,
              type: ck.type,
              device_id: ck.device,
            }
            /** v3 的库里直接有 stoken / login_ticket，省得再等用户粘贴一次 */
            if (ck.stoken) entry.stoken = ck.stoken
            if (ck.login_ticket) entry.login_ticket = ck.login_ticket
            bag.set(`${game}:${entry.uid}`, entry)
          }
        }
      }
    }
  }
  const users = [...merged].map(([id, bag]) => ({ qq: id, entries: [...bag.values()] })).filter(u => u.entries.length)
  return { ok, users, files }
}

/**
 * 模块级状态
 *
 * beforeMessage / afterMessage 跑在加载期的共享实例上，而规则（#同步ck）跑在「每事件 new 一个」
 * 的实例上 —— 放在 this 上的状态两边不通，所以这里统一放模块级。
 */
/** 备份目录里某个 QQ 的兼容文件，按时间从新到旧 */
function backupFilesOf(qq) {
  try {
    return fs
      .readdirSync(BAK_DIR)
      .map(name => {
        const m = /^(.+)\.(\d{10,})\.yaml$/.exec(name)
        return m && m[1] === String(qq) ? { file: path.join(BAK_DIR, name), ts: Number(m[2]) } : null
      })
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

/** 读一个云崽 ck 文件的条目（兼容数组与 uid 映射两种写法） */
function readCookieFile(file) {
  const data = YAML.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(data) ? data : Object.values(data || {})
  return list.filter(row => row && row.ck).map(row => ({ ...row, uid: String(row.uid || '') }))
}

/**
 * 恢复来源：当前兼容文件优先，文件已经没了才用 temp/MysCookieBak/ 里最新的备份
 * @param qq 只恢复某个 QQ；留空表示全部
 */
function restoreSources(qq = '') {
  const ids = new Set()
  try {
    for (const name of fs.readdirSync(COOKIE_DIR)) if (name.endsWith('.yaml')) ids.add(name.slice(0, -5))
  } catch {}
  try {
    for (const name of fs.readdirSync(BAK_DIR)) {
      const m = /^(.+)\.(\d{10,})\.yaml$/.exec(name)
      if (m) ids.add(m[1])
    }
  } catch {}
  const sources = []
  for (const id of ids) {
    if (qq && id !== String(qq)) continue
    const current = fileOf(id)
    const fromCurrent = fs.existsSync(current)
    const file = fromCurrent ? current : backupFilesOf(id)[0]?.file
    if (!file) continue
    try {
      const entries = readCookieFile(file)
      if (entries.length) sources.push({ qq: id, file, fromBackup: !fromCurrent, entries })
    } catch (err) {
      logger.debug(`[云崽ck兼容] 读取 ${path.basename(file)} 失败：${err}`)
    }
  }
  return sources
}

/** 把云崽文件条目按 ltuid 折叠成「一个米游社账号 + 它的国服 uid」 */
function groupRestore(entries) {
  const plan = new Map()
  for (const row of entries) {
    const ltuid = String(row.ltuid || '').trim()
    if (!ltuid || !row.ck) continue
    let item = plan.get(ltuid)
    if (!item) {
      const ck = String(row.ck)
      item = {
        ltuid,
        ck,
        type: row.type || 'mys',
        device: row.device_id || row.device || '',
        login_ticket: row.login_ticket || (/login_ticket=([^;\s]+)/.exec(ck)?.[1] ?? ''),
        ltoken: row.ltoken || (/ltoken=([^;\s]+)/.exec(ck)?.[1] ?? ''),
        stoken: row.stoken || '',
        uids: { gs: [], sr: [] },
      }
      plan.set(ltuid, item)
    }
    if (row.stoken && !item.stoken) item.stoken = row.stoken
    const game = row.region_name === GAME_REGION.sr ? 'sr' : GAME_REGION.gs ? 'gs' : ''
    if (game && row.uid && !item.uids[game].includes(String(row.uid))) item.uids[game].push(String(row.uid))
  }
  return plan
}

/** 选可写的插件库：优先 Mys-plugin 那份，其次任意带 Users + MysUsers 的库 */
async function pickRestoreDb() {
  const ranked = []
  for (const file of dbCandidates()) {
    const sequelize = new Sequelize({ dialect: 'sqlite', storage: file, logging: false })
    try {
      const [rows] = await sequelize.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Users', 'MysUsers')",
      )
      if (rows.length === 2) ranked.push({ file, score: /mys-?plugin/i.test(path.dirname(file)) ? 2 : 1 })
    } catch {
    } finally {
      await sequelize.close().catch(() => {})
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked[0]?.file || ''
}

/**
 * 把兼容文件里的 ck 写回插件库
 *
 * 只补不覆盖：库里已有非空 ck 的账号直接跳过，避免把用户后来重绑的新 ck 换回旧的。
 * @returns {Promise<{file: string, restored: number, inserted: number, updated: number, backupSources: number, skipped: string[]}>}
 */
async function restoreRows(file, sources, apply) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: file, logging: false })
  const report = { file, restored: 0, inserted: 0, updated: 0, backupSources: 0, skipped: [] }
  try {
    await sequelize.query('PRAGMA busy_timeout = 5000')
    const [cols] = await sequelize.query('PRAGMA table_info(MysUsers)')
    const names = new Set(cols.map(c => c.name))
    /** v3 有多出来的 stoken / ltoken / login_ticket / mid，旧库没有，按实际列写 */
    const fields = ['ltuid', 'type', 'ck', 'device', 'uids']
    for (const extra of ['stoken', 'ltoken', 'login_ticket', 'device_fp', 'mid']) if (names.has(extra)) fields.push(extra)
    const [rows] = await sequelize.query('SELECT ltuid, ck, uids FROM MysUsers')
    const have = new Map(rows.map(row => [String(row.ltuid), row]))
    /** 旧库不一定有 updatedAt，按实际列拼 SET，别让恢复在缺列时整条失败 */
    const stamp = names.has('updatedAt') ? ", updatedAt = datetime('now')" : ''
    const insert = `INSERT INTO MysUsers (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})
      ON CONFLICT(ltuid) DO UPDATE SET ck = excluded.ck, uids = excluded.uids${stamp}
      WHERE MysUsers.ck IS NULL OR MysUsers.ck = ''`
    const [userCols] = await sequelize.query('PRAGMA table_info(Users)')
    const userNames = new Set(userCols.map(column => column.name))
    const userStamp = userNames.has('updatedAt') ? ", updatedAt = datetime('now')" : ''
    const userInsertCols = ['id']
    const userInsertValues = ['?']
    if (userNames.has('type')) {
      userInsertCols.push('type')
      userInsertValues.push("'qq'")
    }
    userInsertCols.push('ltuids')
    userInsertValues.push('?')
    for (const field of ['createdAt', 'updatedAt']) {
      if (!userNames.has(field)) continue
      userInsertCols.push(field)
      userInsertValues.push("datetime('now')")
    }
    for (const source of sources) {
      const plan = groupRestore(source.entries)
      if (!plan.size) continue
      if (source.fromBackup) report.backupSources++
      for (const item of plan.values()) {
        const existing = have.get(item.ltuid)
        if (existing?.ck) {
          report.skipped.push(item.ltuid)
          continue
        }
        let uids = {}
        try {
          uids = JSON.parse(existing?.uids || '{}') || {}
        } catch {
          uids = {}
        }
        for (const game of EXPORT_GAMES) {
          const merged = new Set([...(uids[game] || []).map(String), ...item.uids[game]])
          if (merged.size) uids[game] = [...merged]
        }
        const values = {
          ltuid: item.ltuid,
          type: item.type,
          ck: item.ck,
          device: item.device,
          uids: JSON.stringify(uids),
          stoken: item.stoken,
          ltoken: item.ltoken,
          login_ticket: item.login_ticket,
          device_fp: '',
          mid: '',
        }
        report.restored++
        if (existing) report.updated++
        else report.inserted++
        if (!apply) continue
        await sequelize.query(insert, { replacements: fields.map(field => values[field] ?? '') })
        have.set(item.ltuid, { ltuid: item.ltuid, ck: item.ck, uids: values.uids })
      }
      /** QQ → ltuid 的绑定关系也要补，否则插件按 QQ 查不到账号 */
      const [urows] = await sequelize.query('SELECT ltuids FROM Users WHERE id = ?', { replacements: [source.qq] })
      const current = String(urows[0]?.ltuids || '')
      const merged = [...new Set(`${current},${[...plan.keys()].join(',')}`.split(',').filter(Boolean))].join(',')
      if (merged === current) continue
      if (!apply) continue
      if (urows.length) {
        await sequelize.query(`UPDATE Users SET ltuids = ?${userStamp} WHERE id = ?`, {
          replacements: [merged, source.qq],
        })
      } else {
        await sequelize.query(
          `INSERT INTO Users (${userInsertCols.join(', ')}) VALUES (${userInsertValues.join(', ')})`,
          { replacements: [source.qq, merged] },
        )
      }
    }
    return report
  } finally {
    await sequelize.close().catch(() => {})
  }
}

let store = null
/** 本轮消息里捕获到 login_ticket 的用户（首次绑定时 ck 要等分发结束才入库） */
const pending = new Set()

const emptyStore = () => ({ tickets: {}, exported: {} })

export default class MysCookieCompat extends JiuLiPlugin {
  constructor() {
    super({
      name: '云崽ck兼容',
      dsc: '#同步ck / #同步ck 恢复',
      event: 'message',
      /** 只做旁路观察与补写，排在最后，不跟任何插件抢指令 */
      priority: Infinity,
      rule: [{ reg: '^#同步ck(?:\s*(恢复|还原)(?:\s*(确认|执行|写入))?)?$', fnc: 'syncCk', permission: 'master', log: false }],
    })
  }

  async init() {
    if (this.initialized || this.unloaded) return
    this.initialized = true
    this.loadStore()
    const sync = () => {
      this.onlineHandler = null
      if (this.unloaded) return
      return this.syncAll().catch(err => logger.debug(`[云崽ck兼容] 同步失败：${err}`))
    }
    /**
     * online 在所有插件 init() 之后：旧版 genshin 的启动迁移（导入 data/MysCookie/ 后删文件）
     * 已经跑完，这时候导出的文件才不会被它吃掉。热重载 / 迟到加载时 online 早发过了，直接同步。
     */
    this.onlineBot = Bot
    if (Bot.stat?.online === 2) sync()
    else {
      this.onlineHandler = sync
      Bot.once('online', sync)
    }
    this.watchDb()
  }

  onUnload() {
    this.unloaded = true
    clearTimeout(this.syncTimer)
    clearInterval(this.syncTick)
    this.syncTimer = null
    this.syncTick = null
    if (this.onlineHandler) this.onlineBot?.removeListener('online', this.onlineHandler)
    this.onlineHandler = null
    this.onlineBot = null
    for (const watcher of this.dbWatchers || []) watcher.close()
    this.dbWatchers = null
  }

  /**
   * 监听 ck 数据库变化：扫码登录 / 重新绑定这类流程不会发「带 login_ticket 的消息」，
   * 旁路捕获拿不到，只能靠数据库变更兜底把新 ck 导出到云崽文件。
   * sequelize 走 WAL，写入是异步的，所以做 2 秒防抖 + 单飞，避免重复全量同步。
   */
  watchDb() {
    if (this.unloaded || this.syncTick) return
    /** 目录 → 该目录下参与同步的库文件名（WAL/SHM 变更也算） */
    const byDir = new Map()
    for (const file of dbCandidates()) {
      const dir = path.dirname(file)
      if (!byDir.has(dir)) byDir.set(dir, new Set())
      byDir.get(dir).add(path.basename(file))
    }
    this.maybeSync = () => {
      if (this.unloaded || this.syncTimer) return
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null
        if (this.unloaded || this.syncing) return
        this.syncing = true
        this.syncAll()
          .catch(err => logger.debug(`[云崽ck兼容] 自动同步失败：${err}`))
          .finally(() => (this.syncing = false))
      }, 2000)
      this.syncTimer.unref?.()
    }
    this.dbWatchers = []
    for (const [dir, names] of byDir) {
      try {
        /** 目录级监听：data.db / -wal / -shm 都在这个目录里，监听单个文件容易漏 */
        const watcher = fs.watch(dir, (_event, name) => {
          if (!name) return this.maybeSync()
          /** 同目录可能有别的 sqlite 文件，只认自己扫到的那些 */
          if (names.has(String(name).replace(/-(wal|shm)$/i, ''))) this.maybeSync()
        })
        watcher.on('error', err => logger.debug(`[云崽ck兼容] 数据库监听失败：${err}`))
        watcher.unref?.()
        this.dbWatchers.push(watcher)
      } catch (err) {
        logger.debug(`[云崽ck兼容] 无法监听 ${dir}：${err}`)
      }
    }
    /** 兜底：文件系统事件偶发丢失时每 10 分钟补一次（内容没变不会重写） */
    this.syncTick = setInterval(() => this.maybeSync(), 10 * 60 * 1000)
    this.syncTick.unref?.()
  }

  /* ==================== 旁路捕获 ==================== */

  /**
   * 分发前：只观察，不拦截（返回 undefined）
   *
   * 粘贴的完整 ck 里有 login_ticket，部分插件要靠它换 stoken，而它们又是从
   * `data/MysCookie/<qq>.yaml` 里取的 —— 只能在这儿顺手记下来。
   */
  async beforeMessage(e) {
    const qq = String(e.user_id || '')
    const raw = String(e.raw_message || e.msg || '')
    if (qq && raw.includes('login_ticket=') && CK_RE.test(raw)) {
      const ticket = TICKET_RE.exec(raw)?.[1]
      if (ticket) this.remember(qq, ticket)
      pending.add(qq)
      /** 已有 ck 的老用户重绑：文件立刻刷新；首次绑定等 afterMessage（那时 ck 才入库） */
      const { ok, users } = await readCkData(qq)
      if (ok && users.length) await this.writeUser(users[0], ticket)
      return
    }

    /**
     * 文件被删（旧版 genshin 启动迁移会"导入即删"）时按需重建。
     * 只对**导出过**的用户做，避免每条消息都去读一次数据库。
     */
    if (qq && this.loadStore().exported[qq] && !fs.existsSync(fileOf(qq))) {
      const { users } = await readCkData(qq)
      if (users.length) await this.writeUser(users[0])
    }
  }

  /** 分发后：ck 绑定已在本轮消息里完成，补写一次 */
  async afterMessage(e) {
    const qq = String(e.user_id || '')
    if (!qq || !pending.delete(qq)) return
    const { ok, users } = await readCkData(qq)
    if (ok && users.length) await this.writeUser(users[0], this.ticketOf(qq))
  }

  /* ==================== 导出 ==================== */

  /**
   * 全量同步：所有库里的 ck → data/MysCookie/<qq>.yaml
   * 读失败或库全空时只写不删，理由见文件头「删除策略」
   */
  async syncAll() {
    if (this.unloaded) return { count: 0, retired: 0, ok: true, files: [] }
    const { ok, users, files } = await readCkData()
    if (this.unloaded) return { count: 0, retired: 0, ok, files }
    let count = 0
    for (const data of users) {
      if (this.unloaded) return { count, retired: 0, ok, files }
      if (await this.writeUser(data)) count++
    }

    const exported = Object.keys(this.loadStore().exported)
    const missing = exported.filter(qq => !users.some(u => u.qq === qq))
    let retired = 0
    if (!missing.length) return { count, retired, ok, files }
    if (!ok) {
      const why = files.length ? `只读到 ${files.length} 个库中的一部分` : '没有找到 ck 数据库'
      logger.warn(`[云崽ck兼容] ${why}，本次跳过清理 ${missing.length} 个文件`)
      return { count, retired, ok, files }
    }
    if (!users.length) {
      logger.warn(`[云崽ck兼容] 数据库里一条 ck 都没有，但 ${exported.length} 个兼容文件还在，跳过清理`)
      return { count, retired, ok, files }
    }
    /** 库里还有别的 ck，说明库是活的，缺的那几个是用户真的解绑了 */
    for (const qq of missing) {
      if (this.unloaded) return { count, retired, ok, files }
      if (await this.retireUser(qq)) retired++
    }
    if (count > 0) logger.mark(`[云崽ck兼容] 已同步 ${count} 个用户的 ck → data/MysCookie/`)
    return { count, retired, ok, files }
  }

  /** 手动同步（#同步ck）；带「恢复」时把兼容文件写回库 */
  async syncCk() {
    const msg = String(this.e?.msg || '')
    if (/恢复|还原/.test(msg)) return this.restoreCk(/确认|执行|写入/.test(msg))
    const { count, retired, ok, files } = await this.syncAll()
    if (!ok)
      return this.reply(
        `${files.length ? `数据库没读全（扫到 ${files.length} 个库）` : '没有找到 ck 数据库'}，只写了 ${count} 个用户的 ck，没有删任何文件`,
      )
    const lines = [`已同步 ${count} 个用户的 ck → data/MysCookie/`]
    if (retired) lines.push(`清理 ${retired} 个已解绑的文件（移到 temp/MysCookieBak/）`)
    return this.reply(lines.join('\n'))
  }

  /**
   * 把兼容文件里的 ck 写回插件库（#同步ck 恢复 [确认]）
   * 库被清空 / 换过库之后用来找回绑定，只补不覆盖
   */
  async restoreCk(apply = false) {
    const sources = restoreSources()
    if (!sources.length) return this.reply('data/MysCookie/ 与 temp/MysCookieBak/ 里都没有可恢复的 ck 文件')
    const file = await pickRestoreDb()
    if (!file) return this.reply('没找到带 Users / MysUsers 表的插件数据库，先在插件里绑定一次 ck')
    const report = await restoreRows(file, sources, apply)
    const target = path.relative(process.cwd(), file)
    const lines = [
      apply ? `已恢复 ${report.restored} 个账号 → ${target}` : `可恢复 ${report.restored} 个账号 → ${target}`,
    ]
    if (report.backupSources) lines.push(`其中 ${report.backupSources} 个用户只有备份文件`)
    if (report.skipped.length) lines.push(`跳过 ${report.skipped.length} 个：库里已有 ck，不覆盖`)
    if (!apply) lines.push('先备份数据库，再发 #同步ck 恢复 确认 写入')
    else lines.push('接着发 #同步ck 让兼容文件按新库重建')
    return this.reply(lines.join('\n'))
  }

  /**
   * 把不再有 ck 的用户的兼容文件挪进备份目录
   * 直接 unlink 一旦误判就是丢数据，挪走还能手工捞回来
   */
  async retireUser(qq) {
    const state = this.loadStore()
    if (!state.exported[qq]) return false
    const file = fileOf(qq)
    if (fs.existsSync(file)) {
      try {
        fs.mkdirSync(BAK_DIR, { recursive: true })
        fs.renameSync(file, path.join(BAK_DIR, `${qq}.${Date.now()}.yaml`))
        logger.mark(`[云崽ck兼容] ${qq} 已解绑，兼容文件移到 temp/MysCookieBak/`)
      } catch (err) {
        logger.debug(`[云崽ck兼容] 移动 ${qq} 的兼容文件失败：${err}`)
        return false
      }
    }
    delete state.exported[qq]
    this.saveStore()
    return true
  }

  /**
   * 写一个用户的兼容文件
   * @param data `{ qq, entries }`（readCkData 的结果）
   * @param loginTicket 本次消息里捕获到的 login_ticket（可选，库里有就用库里的）
   */
  async writeUser(data, loginTicket = '') {
    const qq = String(data?.qq || '')
    const entries = data?.entries || []
    if (!qq || !entries.length) return false
    const state = this.loadStore()
    const file = fileOf(qq)

    const ticket = entries.find(e => e.login_ticket)?.login_ticket || loginTicket || this.ticketOf(qq)
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
      if (e.stoken) out[e.uid].stoken = e.stoken
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
    const bak = (() => {
      try {
        return fs
          .readdirSync(BAK_DIR)
          .filter(name => name.startsWith(`${qq}.`))
          .sort()
          .reverse()
      } catch {
        return []
      }
    })()
    for (const file of [fileOf(qq), ...bak.map(name => path.join(BAK_DIR, name))]) {
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
