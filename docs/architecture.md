# JiuLi 架构说明

## 设计约束

1. **零改动兼容云崽插件**（硬约束）：插件里写死的相对路径（`../../lib/plugins/plugin.js` 等）
   无法用模块别名绕过，因此这些路径必须在 `lib/` 下真实存在。
2. **内核 TS + 兼容层 JS**：内核编译到 `lib/core/`；兼容层手写，状态越少越好。
3. **内核不依赖插件**：云崽内核反向 import 了 genshin / miao 的内部模块，JiuLi 改为动态加载 + 扩展点。

## 分层

```
plugins/**            旧插件（extends plugin）/ JiuLi 原生插件
   │  import（旧路径 / 'jiuli'）
lib/**  兼容层（手写 JS shim）
   lib/plugins/{plugin,loader,handler,runtime,config}.js
   lib/config/{config,init,log,redis}.js
   lib/common/common.js  lib/puppeteer/puppeteer.js
   lib/renderer/*  lib/events/*  lib/listener/*  lib/util.js
   lib/modules/{oicq,md5,node-fetch}
   │  import '../core/...'
lib/core/**  内核（由 src/** 编译）
   bot.ts          Bot 单例（Proxy / uin / adapter / HTTP / WS / 文件）
   loader.ts       插件加载 + 消息分发 + 任务 + 热重载
   loading.ts      「当前正在加载哪个插件」的异步上下文（路由归属用）
   reload-hooks.ts 模块解析钩子：给 plugins/ 下的模块打代数戳，实现整图热重载
   plugin.ts       插件基类（rule / 上下文 / renderImg）
   config/         配置中心（YAML + Proxy 回落 + 热更新）
   redis.ts        Redis + 内存降级
   render/         art-template Renderer + 后端加载器
   runtime.ts      e.runtime / e.user（genshin 生态动态接入）
   events.ts       监听器基类 + 监听 / 适配器加载
   handler.ts      跨插件 handler 总线
   metrics.ts      插件耗时统计
   log.ts          日志（等级短路 + 文件输出）
   util.ts         工具（Bot.* 回落实现）
   plugin-config.ts  makeConfig 兼容实现
   globals.ts / start.ts / types.ts / segment.ts / common.ts
```

## 启动流程

```
app.js（模式：internal / external / pm2 / daemon / stop）
 └─ lib/core/start.ts → start()
     ├─ 时区、进程标题（compat.spoof_yunzai 决定对外显示名）
     ├─ setLogDir + ensureDirs（temp/data/logs/resources）
     ├─ new Bot() → injectGlobals()：Bot / logger / plugin / segment / Renderer / start_type
     ├─ 未捕获异常与退出钩子
     └─ bot.run()
         ├─ redisInit()（失败 → 拉起本机 redis-server → 内存降级）
         ├─ serverLoad()（HTTP，可选 HTTPS）
         ├─ renderService.load()（扫描 renderers/，浏览器首次截图才启动）
         ├─ PluginsLoader.load()
         │    ├─ 扫描 plugins/（有 index.js 只加载它，否则平铺 .js）
         │    ├─ 并行 import → loadPlugin：new → init() → task → rule 预编译 → handler
         │    ├─ 事件索引 + 优先级排序 + 定时任务
         │    └─ 热重载 watcher
         ├─ loadEvents()（lib/events/*.js + Bot.adapter 逐个 load()）
         └─ stat.online = 2 → emit('online')
```

## 启动耗时分析

插件是**并行 `import()`** 的，日志里的「启动关键路径」记录的是「开始加载 → 该插件就绪」的耗时
（含公共依赖解析），最后就绪的几个就是拖慢启动的，不代表插件有问题。

实测（Windows / 102 个插件 / Node 25）：

| 环节 | 耗时 |
| --- | --- |
| 内置 16 个 system 插件 | 0.24s |
| 单个重插件（genshin） | 2.2s |
| 全部 102 个插件 | 8~14s |

耗时构成（`--cpu-prof` 采样，修 yenai 之前 / 之后）：

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 模块解析（`internalModuleStat` / `lstat` / `getPackageScopeConfig`） | 55% | 68% |
| 子进程（`spawn` / `spawnSync`，即 PowerShell） | 15% | 2% |
| 插件自身 JS | ~1% | ~1% |

结论：

1. **主因是 Node 解析模块图的文件系统调用**：本机 `statSync` 单次约 107µs
   （Defender 实时扫描 + pnpm 软链结构），1119 个模块文件 × 每个约百次候选路径探测 ≈ 十几秒。
   **串行 13.61s ≈ 并行 13.68s**，与并发策略无关。
2. **避免第三方插件在 import 阶段做同步外部调用**：典型是 `systeminformation`——Windows 下用
   PowerShell 查 WMI，`si.graphics()` 单次约 10s、`si.cpu()` / `si.osInfo()` 各约 4.6s。
   yenai-plugin 原本在 5 个模块顶层调用，光 import 就占 10s；改为惰性后 23.5s → 13.7s。
3. V8 编译缓存（`NODE_COMPILE_CACHE`）实测无收益（24.9s → 28.0s），瓶颈不在解析 / 编译。
4. 进一步提速只能改**惰性加载**（静态提取规则正则，命中才 import），
   与运行时改规则的插件存在兼容风险，暂未实现。

## 插件热重载

`plugins/` 下的 js 变更（2 秒窗口合并后）走 `changePlugin`：卸载旧插件 → 重新 `import` 入口 →
重建事件索引与定时任务。四处细节都不显眼，但少了任何一处都会出现「日志说重载了、行为却没变」：

1. **入口带时间戳不足以保证新代码生效**。原来只给入口加 `?<时间戳>`，而入口里
   `import './apps/x.js'` / `import './lib/y.js'` 这类嵌套说明符解析出的 URL 不带时间戳，
   命中 Node 的 ESM 缓存 —— 目录型插件（index.js + apps/ + lib/）改完还是跑旧模块，
   必须重启。现在由 `reload-hooks.ts` 注册同步解析钩子（`module.registerHooks`，Node 22.15+），
   给 `plugins/` 下的模块 URL 统一追加 `?jiuli_reload=<代数>`，每次重载代数 +1，
   **整张插件模块图**重新求值；框架自身、根 `node_modules`、插件自带的 `node_modules` 不加戳，
   避免把共享依赖也复制一份。Node 偏老（无该钩子）时退回旧行为并在启动日志里说明。
2. **重载不能改变插件在同优先级里的次序**。分发按 priority 升序、同优先级按加载顺序先匹配
   先赢，而重载是「删掉条目再 push 到末尾」：重载过的插件会掉到同优先级队伍最后，指令归属
   随之改变（重载 miao-plugin 后 `#更新面板` 被 system/update.js 的 `^#更新` 顶掉就是这个
   原因，两者 priority 都是 `-Infinity`）。现在每条插件条目带一个首次加载时分配的 `order`，
   `sortPriority()` 用 `priority || order` 排序，重载前后完全一致。
3. **监听事件按批处理**。原来每种事件各自走 `util.debounce`，而 debounce 在一个窗口内只保留
   最后一次调用 —— 快速连改多个文件（IDE 全部保存、批量改、一次新建整个插件目录）只有最后
   一个会触发。现在窗口内的事件收进待处理表、到点整批处理，同一个插件的多个文件只处理一次。
4. **加载期挂的事件监听按插件记账**。插件在模块顶层 `Bot.on(...)`（xiaofei 的 `guild.message`、
   yenai 的 `message.group` 点赞都是这种写法）时，旧那份监听留在 EventEmitter 上，每重载一次
   多一份，一条消息被处理 N 次（实测重载三次：监听数 2→5、一条消息命中 4 次）。现在与 express
   路由、`Bot.wsf` 路径同一套机制：加载上下文里挂的监听记在插件名下，卸载 / 重载时移除；
   **运行期**动态挂的监听不记（那不属于插件资源）。

5. **配置/数据目录里的 js 不再无条件重载，机器自激的循环会被直接跳过，并且有熔断兜底**。
   ESM 缓存永不释放旧模块图，所以「重载→写文件→再重载」的自激循环会在几十秒内把内存打爆
   （实测：miao-plugin 的 `config/cfg.js` 在模块顶层把配置写回自己，watcher 看到变化就重载 miao，
   重载又写一遍，~2.2 秒一轮，每轮永久泄漏一张模块图 → OOM）。三道闸：
   ① `config|data|resources|temp` 下的 `.js` 先用正则判结构（插件类 / `rule` / `apps` /
   `task` / `accept` / `handler` / `fnc` / `reg`…），纯数据不重载，确实是插件的照旧；
   ② **自激改写跳过**：`importPlugin` 记下每个插件模块求值的起止时间（`loadWindows`），
   事件到来时若文件 mtime 落在这个窗口里，说明是插件自己加载时写的 → 这一次重载跳过
   （循环当场断掉，一个模块图都不多花）；结构判定只覆盖 config/data 目录，代码文件靠这条；
   ③ **熔断**：只统计"机器自激"的重载，窗口内达到 `perf.reload_limit`（默认 5 次 / 60 秒，
   配 0 关闭）就只暂停**这个**插件的重载监听并打 ERROR，`#重载 <插件名>` 强制刷新即恢复。
   **人工改文件（mtime 在所有求值窗口之外）一律不计入** —— 开发者一分钟里存十几次代码是常态，
   被当成风暴暂停就没法调插件了；另有 `perf.reload_global_limit`（默认 12 次/分钟）做全局频率
   告警（只提醒不暂停，避免批量格式化误伤）。
   `resumeReload` 只能由指令层调用：watcher 重载也走 `changePlugin`，放里面会顺手清计数，
   熔断就永不触发。
6. **删嵌套文件不等于删插件**。`keyOf()` 把 `apps/x.js` 这类深层文件归属到插件目录，早期
   `unlink` 一律 `unloadPlugin(key)`，于是删一个文件就把整个插件卸掉（用户的插件直接失联报错）。
   现在只有入口（目录插件的 `index.js`、文件型插件自己的 `.js`）被删才卸载；插件目录还在时按
   "修改"处理 —— 重新导入：代码里已不再引用它就直接成功，还引用着就给出明确的加载错误，
   而 `changePlugin` 失败时会恢复旧实例，不影响其它功能。

另外两处与热重载配套：

- **资源归属**：Bot 登记插件注册的 express 路由 / WS 路径 / 加载期事件监听时，读的是
  `loading.ts` 里的 AsyncLocalStorage（不是全局变量）。插件是并行导入的，全局量会被别的插件
  改掉，路由就会记到别人名下 —— 重载自己时清不掉（路由翻倍、限流闸门跑两遍），重载别人时
  反而把自己的路由删掉。
- **模块级副作用**：整图重新求值意味着插件在 import 阶段建的定时器 / 连接 / 自建服务会各多一份。
  类形态的实例资源用 `onUnload()` 清理（卸载前会调用）；express 路由、`Bot.wsf` 路径与加载期
  监听由框架记账清理；剩下的（定时器、`fs.watch`、数据库句柄、浏览器、自己 `listen` 的服务）
  只能在入口里自己交接 —— 见 [插件开发](plugin-guide.md#热重载与模块级资源)。

## 消息分发

```
适配器: Bot.em('message.group.normal', e)
  → Bot.prepareEvent(e)：补全 bot/friend/group/member/sender、adapter_*、reply、sendFile
  → EventEmitter 逐级 emit：message.group.normal → message.group → message
  → lib/events/message.js → PluginsLoader.deal(e)

deal(e):
   1. pushCount（内存聚合，默认 1s 批量写回）
   2. checkBlack（白 / 黑名单）
   3. checkLimit（禁言、群 / 个人 CD、1s 去重）
   4. dealEvent：解析消息段 → e.msg/img/at/atBot/reply_id/file → logText
                → isMaster → 别名剥离 → only_reply_at
   5. setLimit
   6. reply(e)：包装 e.reply，支持 {recallMsg, at}、异常捕获、计数
   7. Runtime.attach(e)：只挂载 e.runtime（e.user 由插件按需通过 e.runtime 接口初始化）
   8. 候选插件：事件索引分桶 + checkDisable + filtEvent
   9. 上下文 hook：探针对象取 getContext，命中则执行（返回 'continue' 继续）
  10. only_reply_at 过滤 + 星铁 / 绝区零前缀标准化
  11. accept 循环（'return' 终止，真值跳出）
  12. rule 循环：event 过滤 → reg 匹配 → 权限 → 调用（绑定实例）→ false 继续
  13. 未命中：debug 日志「暂无插件处理」
```

### 与云崽的语义差异（有意为之）

| 项 | 云崽 | JiuLi |
|---|---|---|
| 共享实例写入 `e` | `Object.assign(plugin, { e })`，实例长期持有最后一个事件 | 不污染共享实例；上下文检查用探针对象，规则调用用每事件实例 |
| 实例创建 | accept 与 rule 各 `new` 一次 | 默认复用（`perf.once_instance`） |
| 计数写入 | 每条消息直接写 16~32 个键 | 内存聚合 + 定时批量写回，键格式不变 |
| `e.runtime` / `e.user` | 每条消息 await `Runtime.init` | 只挂 `e.runtime`；`e.user` 由插件自己调 `e.runtime` 接口时按需初始化 |
| 候选插件 | 遍历全部插件 | 事件索引分桶（`perf.event_index`） |

## 渲染

- `Renderer`（art-template）：读模板（带缓存 + 热更新）→ 渲染 → 写 `temp/html/<name>/<saveId>.html`。
  落盘是刻意的，模板里的相对资源路径依赖 html 文件位置。
- `RendererLoader`：扫描 `renderers/<name>/`，后端导出 `(config) => { id, type, render(name, data) }`，
  按 `<script>` 支持度分组依次尝试。
- 内置 `renderers/puppeteer`：用本机 Chrome / Edge（`.puppeteerrc.cjs` 跳过下载）、
  多进程共享 ws 端点、截图数达阈值重启、空闲自动关闭。
- 两条调用通道：`e.runtime.render(plugin, path, data, cfg)` 与 `lib/puppeteer/puppeteer.js` 的
  `screenshot` / `screenshots`。
- **浏览器选择**：`chromiumPath`（`renderers/puppeteer/config.yaml`，或更推荐
  `config/config/bot.yaml` 的 `chromium_path`）→ puppeteer 自带缓存 → 系统已装浏览器 → 自动安装。
  自动选择会**跳过 snap 版浏览器**（`/snap/bin/*` 及指向 snap 启动器的软链）：
  snap 沙箱读不到 `--user-data-dir`，截图会缺内容 / 白屏而且不报错；只有显式配置时才按配置使用。
- **渲染配置归属**：`renderers/<id>/config.yaml` 是**用户文件**（不入库，首次运行由
  `RendererLoader` 从 `config_default.yaml` 复制），所以 `#更新` 不会覆盖用户的改动；
  升级只更新 `config_default.yaml` 模板。

## 存储

- **Redis**：按 node-redis v4 原生用法（键格式与云崽一致）。连接失败且为本机地址时先尝试拉起
  `cfg.redis.path`，仍失败则按 `redis_fallback` 降级为内存实现或退出。
  内存实现覆盖 string / hash / set / zset / list / scan / multi，未实现的命令返回 null 并告警一次。
- **本地 Map**：`util.getMap(dir)` 基于 level（与云崽一致，数据目录 `data/*-leveldb`）。
- **米游社 ck**：数据源是 `data/db/data.db`（genshin 插件的数据层：`Users` / `MysUsers` 表），
  云崽 v3 的 `data/MysCookie/<qq>.yaml` 只作为**兼容导出**由 `plugins/system/mys-ck-compat.js` 维护
  （生态插件按文件路径读 ck；`login_ticket` DB 不存，由该插件在用户粘贴 ck 时旁路捕获）。
  该插件**只读 sqlite、不 import genshin 的任何模块**；导出挂在 `online` 之后（genshin 启动迁移
  会"导入旧文件后删掉"），并在文件缺失时按需重建。
- **生态闸门**：genshin 的 `model/gsCfg.js`（import `#miao.models`）、`model/db/BaseModel.js`
  （顶层 `Data.createDir`，import `#miao`）与 miao 的模块图互相纠缠，链上还有顶层 await。
  框架**绝不主动 import** 这批模块：只有 `plugins/genshin` 插件导入成功
  （`Runtime.markEcosystemReady()`，那批模块已正常求值完，import 全是缓存命中）后才允许
  `Runtime.ecosystem()` 去取。插件没加载好时一律绕开 —— 否则会复用 errored / 半求值的模块，
  轻则 `Cannot access 'Data' before initialization`，重则 V8 Fatal 杀进程。
  回归用例：`test/ecosystem-gate.mjs`。

## 扩展点

| 扩展点 | 用法 |
|---|---|
| 渲染后端 | `renderers/<id>/index.js` + `config_default.yaml`，导出 `(config) => renderer` |
| 适配器 | `Bot.adapter.push({ id, name, path, load() })` |
| 事件监听器 | `lib/events/` 新增 `.js`，继承 `lib/listener/listener.js` |
| 运行时扩展 | `Runtime.use({ initUser, getMysInfo, ... })` |
| WS 处理器 | `Bot.wsf[path] = [handler]` |
| HTTP 路由 | `Bot.express.get/post(...)`，可改 `express.skip_auth` / `quiet` |
| 文本预处理 | 目前沿用云崽的 `loader.srReg` / `zzzReg`（可覆盖） |

## 目录与文件约定

| 路径 | 说明 |
|---|---|
| `config/default_config/*.yaml` | 默认配置，首次启动复制到 `config/config/` |
| `plugins/<name>/index.js` | 存在时只加载它（旧插件的 `apps/` 模式由它导入） |
| `plugins/<name>/resources/<tpl>.html` | 渲染模板（`pluResPath` 指向此处） |
| `temp/html/<plugin>/<path>/<saveId>.html` | 渲染中间产物，可随时清理 |
| `data/plugins/<name>/` | 原生插件私有数据目录（`this.dataDir`） |
| `logs/jiuli.YYYY-MM-DD.log` | 运行日志，错误另写 `logs/error/` |
