# JiuLi 插件开发

三种形态共用同一套内核与分发流程：

| 形态 | 写法 | 场景 |
|---|---|---|
| 云崽插件 | `export class X extends plugin` | 从 TRSS-Yunzai 迁移，零改动 |
| JiuLi 类形态 | `import { JiuLiPlugin } from 'jiuli'` | 新插件，想要类型提示与渲染 / 数据目录辅助 |
| JiuLi DSL | `definePlugin({ apps: [command(...)] })` | 函数式，不用 `this` |

```bash
node jiuli c my-plugin          # 生成插件骨架（--dsl 函数式 / --dir 独立目录）
```

## 目录与加载规则

```
plugins/my-plugin/
├─ package.json     有依赖时才需要（记得 "jiuli": "link:../.."）
├─ index.js         入口
├─ apps/            拆分的命令文件
├─ model/           业务逻辑
├─ resources/       渲染模板与静态资源
└─ defSet/          默认配置
```

- 只扫描 `plugins/` 下的**目录**（根下的散文件不加载）
- 目录里有 `index.js` → 只加载它；没有 → 加载该目录下所有 `.js`（不递归）
- 一个文件可以导出多个插件类，都会被注册

## 云崽风格

```js
export class Demo extends plugin {
  constructor() {
    super({
      name: '演示', dsc: '描述', event: 'message', priority: 5000,
      rule: [
        { reg: '^#演示$', fnc: 'demo' },
        { reg: '^#管理$', fnc: 'admin', permission: 'master' },
        { reg: '^#静默$', fnc: 'quiet', log: false },
      ],
      task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }],
    })
  }

  async demo(e) { return e.reply('你好') }

  async init() { /* 加载时一次；返回 "return" 跳过整个插件 */ }

  async accept(e) { /* 每条事件都跑，在 rule 之前 */ }

  async daily() { /* 定时任务里没有 this.e */ }
}
```

`rule` 字段：`reg`（字符串/正则，预编译）、`fnc`、`event`（三段通配）、`permission`（master/owner/admin）、`log`。

`permission: 'master'` 只管这一条规则（非主人会收到一句"没有权限"）。要让整个机器人只服务主人，用群配置层的 `onlyReplyMaster: 1`：非主人的消息会被整层静默跳过，不触发任何插件、也不回提示。

规则方法返回 `false` = 放弃这条指令，继续匹配后面的规则与插件。**规则写得宽（例如 `^#更新`）时不要在自己这里先 `reply` 再返回 false** —— 那句回复会挡在别人的同名指令前面（`#更新抽卡记录` 会被 `#更新` 吃掉）。要提示就把话挂到事件上，框架在确实没有插件接手时才补发：

内置插件的 `#帮助` 用的是普通优先级（4000），你的菜单插件用更小的 priority 即可接管它；框架自带的说明另外留了 `#玖璃帮助`，与生态插件的现有指令不冲突，适合作为不会被误接管的入口。

```js
async fnc(e) {
  if (!target) {
    e.__pluginHint = `plugins/ 下没有「${name}」，可用 #插件列表 查看`   // 延迟提示，不截胡
    return false
  }
}
```

上下文会话：

```js
async start() { this.setContext('waiting'); return this.reply('请发送内容') }
async waiting() { this.finish('waiting'); return this.reply(`收到：${this.e.msg}`) }
// Promise 形式：const next = await this.awaitContext()   // 超时返回 false
```

会话按「插件名 + bot + 群/用户」隔离，默认 120 秒超时。

## CJS 依赖

插件用原生 `import()` 加载，Node 自己处理 CJS 互操作：`import COS from 'cos-nodejs-sdk-v5'` 拿到的就是 `module.exports` 本身（包内即使写了 `exports.default` 也不会被优先取用），所以不需要、也不要去猜测"框架改了默认导出"。

`node-fetch` / `md5` / `oicq` 是框架提供的 ESM 壳包，`require` / `import` 两侧都可用。

回调式 SDK 的报错对象直接拼进模板串会变成 `[object Object]`，把线索丢掉。写清楚字段：

```js
if (err) {
  logger.error(`[插件名] 读取失败 ${err.code || err.statusCode || err.name}: ${err.message || err.error}`)
}
```

## JiuLi 原生

```js
import { JiuLiPlugin } from 'jiuli'

export default class Demo extends JiuLiPlugin {
  constructor() {
    super({ name: '演示', priority: 100, rule: [{ reg: '^#渲染$', fnc: 'render' }] })
  }
  async render() {
    const img = await this.render('hello/index', { title: '你好' })   // 失败返回 false
    return this.reply(img || '渲染失败')
  }
}
```

DSL 形态：

```js
import { definePlugin, command, task, accept, handler } from 'jiuli'

export default definePlugin({
  name: '演示',
  apps: [
    command(/^#演示$/, async (e, match) => e.reply('你好'), { name: '演示' }),
    command(/^#管理$/, async e => e.reply('ok'), { permission: 'master' }),
    task('0 8 * * *', () => logger.mark('早安')),
    accept('notice.group.poke', async e => e.reply('别戳了')),
    handler('demo.hello', (e, args) => `hello ${args}`),
  ],
})
```

分发钩子（旧体系没有）：

```js
beforeMessage(async e => {
  if (e.msg === '#禁止') return false      // 返回 false 拦截本次分发
})
afterMessage(e => logger.mark(`[审计] ${e.user_id}: ${e.msg}`))
```

类形态需显式声明方法名：`super({ hooks: { beforeMessage: 'onBefore', afterMessage: 'onAfter' } })`。
钩子不会因为插件里恰好有同名方法就被调用。

生命周期与配置：

```js
async onLoad() { this.timer = setInterval(() => {}, 60_000) }
async onUnload() { clearInterval(this.timer) }        // 卸载 / 热重载前清理
async init() {
  const { config, configSave } = await this.useConfig({ enable: true })
  await configSave()                                   // → config/<插件名>.yaml
}
```

实例属性：`this.e`、`this.dataDir`（`data/plugins/<插件名>/`）、`this.resDir`、
`this.render` / `this.renderBase64`、`this.reply`。

## 热重载与模块级资源

改 `plugins/` 下的 js（含目录型插件的 `apps/`、`lib/`）等 2 秒自动生效，原理见
[架构说明](architecture.md#插件热重载)：**整张插件模块图会重新求值**，也就是模块顶层的代码
会再跑一遍。这带来一条必须遵守的约定：

- **别在模块顶层写回自己目录下的文件**（配置 / 数据 / 代码都不行）。写文件会触发一次重载，
  重载时又写一遍 —— 框架会认出"这个文件是插件自己加载时写的"并跳过那次重载，同时打一条
  ERROR；连续自激重载还会熔断该插件的热重载（`perf.reload_limit`）。原因是每次重载都会永久
  占住一张模块图（ESM 缓存不释放旧图），几十秒就能把内存打爆。要落盘就放到运行期（指令 /
  定时任务里）写，并且存成 `config/`、`data/` 下的 `.json` / `.yaml` 这类非 `.js` 文件。

- **别把「循环 import」和「顶层副作用」混在一起**。重载会改变整张模块图的**求值顺序**，
  而循环依赖下的求值顺序本来就依赖先后：`model/db/BaseModel.js` 顶层就用从 `#index` 来的
  `Data.createDir(...)`，而 `#index` 又与 `base.js`、`gsCfg.js` 互成环 —— 冷启动时顺序恰好是好的，
  重载后新顺序会让 `Data` 仍处于 TDZ：

  ```
  ReferenceError: Cannot access 'Data' before initialization
      at plugins/xxx/model/db/BaseModel.js?jiuli_reload=2:5:1
  ```

  这类失败发生在模块求值里，**可能被插件自己的 `Promise.allSettled` 吞掉**，表现是「日志一堆
  ERROR，但插件指令全没了」。框架会认出这种「重载导致的模块初始化失败」并**自动重启恢复**
  （新进程的求值顺序回到冷启动那份；两分钟内只自动重启一次，`bot.yaml → reload_restart_on_error: false`
  可关掉）。根治办法是拆掉环，或把顶层副作用挪进函数、用惰性取值：

  ```js
  // 别这样：模块顶层就依赖另一个模块的导出
  import { Data } from '#index'
  Data.createDir('/data/db', 'root')

  // 改成运行期惰性执行
  import { Data } from '#index'
  function ensureDir() { Data.createDir('/data/db', 'root') }
  ```

- **实例资源**用 `onUnload()` 清理：卸载 / 热重载前框架会调用它（定时器、socket、进程）。
- **事件监听**（模块顶层 `Bot.on(...)`）与 express 路由、`Bot.wsf` 路径一样由框架**按插件记账**，
  卸载 / 重载时自动移除 —— 这类不用自己管。只有**运行期**（指令、定时任务里）动态挂的监听
  不在记账范围内（那是运行时行为，不是插件资源），需要的话自己收。
- **其它模块级资源**（在文件顶层 `setInterval`、`fs.watch`、开数据库句柄、起浏览器、
  自己 `listen` 的服务）必须在入口里自己交接 —— 旧的模块图收不到任何通知，Node 已经把它从
  缓存里换掉了。写法是把「交还资源」的函数挂在 `globalThis` 上，新的一次加载先 await 上一个：

  ```js
  // index.js（目录型入口）
  if (typeof globalThis.__myPluginHandoff === 'function') {
    try { await globalThis.__myPluginHandoff() } catch (e) { logger.warn('上一个模块图交还资源失败', e) }
  }

  startWatcher()                      // 顶层建资源
  globalThis.__myPluginHandoff = () => stopWatcher()
  ```

  用 `globalThis` 而不是模块级变量，是因为模块级变量在重新求值后已经清零，新图看不见旧图
  握着什么。不这么做的话，每热重载一次就多一份：定时任务跑两遍、文件变更处理两次、
  浏览器进程留在系统里。

  交接函数里只收**本图自己起的**东西：框架已经管了 express 路由、`Bot.wsf` 与上面的加载期
  监听，重复 close 反而可能把框架的服务器关掉。

- 把「该用哪份清理函数」存成可覆盖的指针（而不是闭包抓住当前这份）同样重要：挂钩子
  （`process.on('exit')`、包 `Bot.restart`）的代码跨模块图存活，闭包里那份属于旧图、
  资源早交出去了，重启/退出时新图的资源就没人收。

## 事件对象 `e`

`msg` / `raw_message` / `message` / `img` / `at` / `atBot` / `user_id` / `group_id` / `self_id` /
`isGroup` / `isPrivate` / `isMaster` / `sender` / `e.group` / `e.friend` / `e.member` / `e.runtime`，
方法 `reply` / `getReply` / `recall` / `logText`。

```js
await e.reply('纯文本')
await e.reply('带引用', true)
await e.reply([segment.at(e.user_id), '\n你好'])
await e.reply('10 秒后撤回', true, { recallMsg: 10 })
await e.group.sendMsg('主动发群消息')
await Bot.sendGroupMsg(bot_id, group_id, '指定机器人发送')
```

## 事件总线（Bot.on）

`Bot` 是 EventEmitter，`on` / `once` / `emit` / `off` / `listenerCount` / `eventNames` 等全部可用：

```js
Bot.on('message', e => logger.debug(`${e.group_id ?? e.user_id}: ${e.raw_message}`))
Bot.on('notice.group.poke', e => { /* ... */ })
Bot.on('connect.' + Bot.uin[0], ({ bot }) => logger.mark(`账号 ${bot.uin} 已连接`))
```

- `Bot.on('message')` 收到的是**原始事件**，不经过 accept / rule，也没有权限与冷却
- `Bot.em(name, data)` 逐级 emit（`message.group.normal` → `message.group` → `message`），
  且仅在 `data.self_id` 是已注册账号时才补全 `bot` / `friend` / `group` / `member`
- 监听器按注册顺序触发；插件先于 `lib/events/*` 加载，所以插件顶层注册的监听器先收到事件
- 需要权限与指令匹配的用 `rule` / `accept`，不要在 `Bot.on` 里自己解析文本

## 渲染

模板放 `plugins/<插件>/resources/<路径>.html`（art-template）：

```js
const img = await this.render('help/index', { title: '标题' })      // 可直接回复
const b64 = await this.renderBase64('help/index', data)             // base64:// 字符串
await e.runtime.render('插件目录名', 'help/index', data)             // 直接发送
```

长图分页与旧写法：

```js
import puppeteer from '../../lib/puppeteer/puppeteer.js'

const imgs = await puppeteer.screenshots('插件名/long/index', {
  tplFile: './plugins/插件名/resources/long/index.html',
  saveId: 'index',
  pluResPath: '../../../plugins/插件名/resources/',
  pageHeight: 4000, ...data,
})
for (const img of imgs) await e.reply(img)
```

模板里可用 `pluResPath` / `_res_path`（资源目录）。后端配置在 `renderers/puppeteer/config.yaml`
（`chromiumPath`、`headless`、`restartNum`、`idleTime`），浏览器懒启动、空闲自动关闭。
示例见 `plugins/demo/render-demo.js`。

## 配置与数据

```js
import makeConfig from '../../lib/plugins/config.js'          // 云崽写法
const { config, configSave } = await makeConfig('demo', { enable: true })
config.enable = false
await configSave()                                            // → config/demo.yaml
```

插件私有数据用 `this.dataDir`（`data/plugins/demo/`），或 `Bot.getMap('data/demo')`。

## 跨插件调用

```js
handler('a.hello', (e, args) => `hello ${args}`)               // 注册
const ret = await e.runtime.handler.call('a.hello', e, '参数')  // 调用
e.runtime.handler.has('a.hello')                               // 是否存在
```

类形态用 `super({ namespace: 'a', handler: [{ key: 'a.hello', fnc: 'hello' }] })`。
`reject()` 机制与云崽一致。

## 适配器

```js
Bot.adapter.push({
  id: 'QQ', name: 'MyAdapter', path: 'MyAdapter',   // path 唯一，用于去重
  async load() {
    Bot[uin] = { adapter: this, uin, fl: new Map(), gl: new Map(), gml: new Map(),
                 pickFriend: id => c, pickGroup: id => c, pickMember: (g, u) => c }
    Bot.uin.push(uin)
    Bot.em(`connect.${uin}`, { self_id: uin, bot: Bot[uin] })
  },
})
```

`Bot.em` 逐级派发（`message.group.normal` → `message.group` → `message`）并补全事件字段。
参考 `plugins/adapter/mock.js`。

## 调试

- `node .` 前台运行，终端直接敲指令；`plugins/adapter/mock.js` 打印机器人发出的消息
- `JIULI_MOCK_STDIN=1 node .` 后，stdin 每行一个 JSON 事件
- 日志等级：`config/config/bot.yaml → log_level: debug`
- `#玖璃性能`（示例插件提供）或 `import { metrics } from 'jiuli'` 看耗时排行
- 改文件等 2 秒自动热重载（`apps/`、`lib/` 里的嵌套模块也会重新求值，见
  [热重载与模块级资源](#热重载与模块级资源)）；没生效看 `file_watch` 是否为 false，或 `#重载`
