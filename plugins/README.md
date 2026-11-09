# plugins/ 目录说明

这里是插件目录。内核只扫描本目录下的**一级子目录**（一个子目录 = 一个插件来源），
子目录里的 `node_modules`、`resources`、`apps` 不会被当成独立插件。

## 各目录是谁的

| 目录 | 归属 | 内容 | 能否删 |
|---|---|---|---|
| `example/` | **你的** | 自己写的插件，一个 `.js` 一个功能，增删改即时热重载 | 随意 |
| `system/` | 框架 | 内置功能：状态 / 帮助 / 设置主人（新增·删除主人）/ 词条 / 诊断 / 重载 / 重启 / 更新 / 日志 / 版本 / 云崽 ck 文件兼容（`data/MysCookie`） … | 不要整删 |
| `adapter/` | 框架 | `stdin.js` 终端交互、`mock.js` 调试 | 不要删 |
| `demo/` | 框架 | 三种写法的示例 + 渲染自检（`#渲染测试`） | 可删 |
| `<第三方>/` | 别人 | clone 来的插件，**不入 git**，依赖由 `pnpm install` 装 | 随意 |

第三方插件必须放在 `plugins/` **里面**：放在项目根目录既扫不到，pnpm 也不会装它的依赖。
推荐用 `pnpm jiuli add <git地址>` 安装（克隆 + 自动装依赖），装好后约 2 秒自动加载。

自己的代码只放 `example/`，升级时不会被覆盖，也不会和框架文件混在一起。

## 加载规则

1. 目录里有 `index.js` → **只加载它**（适合把功能拆到 `apps/`、`model/`）
2. 没有 `index.js` → 加载该目录下所有 `.js`（`example/`、`system/`、`adapter/` 都是这种）
3. 热重载（`bot.yaml → file_watch: true`）：新增 / 修改 / 删除 js（含 `index.js` 与深层 `apps/`）自动生效；
   模板与图片改动由渲染层自动失效缓存，无需重载
4. 手动重载：`#重载`（补漏）或 `#重载 关键词`（强制刷新）

哪些改动会触发重载：

- 入口、`apps/`、`lib/`、`model/` 等**代码目录**里的 `.js` → 改完立即重载 ✓
- `config/`、`data/`、`resources/`、`temp/` 里的 `.js` → **只有它自己像插件模块**（plugin 类、
  `rule` / `apps` / `task` / `accept` / `handler` / `fnc` / `reg` 这些结构）才重载；
  纯 `export const a = false` 这类私有配置 / 数据**不重载** —— 插件加载时常常自己改写这些文件，
  一重载又写一遍就变成自激循环（实测 30 秒能把内存打爆，见下）
- 确实要让私有配置生效：改完发 `#重载 <插件名>`，或者重启
- 删掉**嵌套文件**（`apps/x.js`、`lib/y.js`）只重载一次，不会卸载整个插件；只有入口
  （目录插件的 `index.js`、文件型插件自己的 `.js`）被删才算插件被删

**自激改写跳过**：某个文件的修改时间落在**该插件自己的求值窗口**内（也就是"它刚加载时自己写的"），
这次重载直接跳过并打一条 ERROR —— 这是自激循环的通用兜底（结构判定只覆盖 config/data 目录，
代码文件靠这条）。插件不该在模块顶层写回自己目录下的 `.js`：写文件 → 触发重载 → 加载时又写一遍，
每轮都会永久占住一张模块图（ESM 缓存不释放旧图），几十秒必 OOM。
正确做法：写文件挪到运行期（指令 / 定时任务里），或改存 `.json` / `.yaml`。

**重载风暴熔断**：上面这条兜不住时（例如两个插件互相写对方的文件），同一插件在窗口内**自激**
重载 ≥5 次就暂停它的重载监听并打一条 ERROR 日志（只暂停它，其它插件照常）；
修好根因后发 `#重载 <插件名>` 强制刷新即恢复监听（无参数的 `#重载` 只补漏，不解除熔断），
内存已经涨上去就直接 `#重启`。
**人工改文件不计入熔断** —— 开发时连着存十几次代码不会被暂停。
阈值可调：`config/config/jiuli.yaml → perf.reload_limit / perf.reload_window`
（`reload_limit: 0` 关闭熔断）；另有 `perf.reload_global_limit`：一分钟内任何来源的重载超过它
（默认 12）就打一条 ERROR 提醒（只告警不暂停，避免批量格式化误伤）。
已知边界：插件**异步**延迟写回自己的文件（加载完过几秒再写）不在"求值窗口"内，
自激跳过抓不到它，靠上面那条全局频率告警暴露出来。

## 写自己的插件

```bash
pnpm jiuli create my-plugin          # plugins/example/my-plugin.js（类形态）
pnpm jiuli create my-plugin --dsl    # 函数式 DSL
pnpm jiuli create my-plugin --dir    # 独立目录（含 resources/ 与 package.json）
```

最小可用插件：

```js
import { JiuLiPlugin } from 'jiuli'

export default class MyPlugin extends JiuLiPlugin {
  constructor() {
    super({
      name: '我的插件',                    // #插件列表、群配置 enable/disable 用这个名字
      dsc: '演示',
      event: 'message',                   // 通知类事件写 notice.group.poke
      priority: 5000,                     // 数字越小越先执行
      rule: [
        { reg: '^#你好$', fnc: 'hello' },
        { reg: /^#戳我\s+(.+)$/, fnc: 'poke' },
      ],
    })
  }

  async hello(e) {
    await e.reply('你好呀')
    return true          // 返回 false 表示继续匹配后面的规则
  }

  async poke(e, match) {
    await e.reply(`你说了：${match?.[1]}`)
  }
}
```

常用能力速查：

- 发消息：`e.reply('文本')` / `e.reply('带引用', true)` / `e.reply([segment.at(e.user_id), '\n你好'])`
- 发图片：`await e.reply(await this.render('我的模板/index', { title: '标题' }))`
  （模板放 `<插件目录>/resources/我的模板/index.html`）
- 定时任务：`task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }]`
- 会话（等用户回复）：`this.setContext('waiting')` + 写一个 `waiting()` 方法
- 存储：`this.dataDir`（插件私有目录）、全局 `redis`、`Bot.getMap('data/xxx')`
- 排查：`#诊断`，日志里的 `[  Plugin ]` 与 `[   Msg   ]` 行

完整说明见 [docs/plugin-guide.md](../docs/plugin-guide.md)。
