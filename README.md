# JiuLi（玖璃）

**官方文档：<https://hlz7.com/jiuli/>**

兼容 TRSS-Yunzai 生态的机器人框架，内核 TypeScript。

- **旧插件零改动**：云崽插件放进 `plugins/` 即可用，物理路径、全局变量、`e` 对象契约全部保留
- **内核 TS**：`src/` 编译到 `lib/core/`，可 `pnpm typecheck`
- **轻量**：不带业务，开箱功能只有状态 / 帮助 / 主人 / 词条 / 重启这些基础件
- **可换适配器**：协议端通过适配器插件接入（`Bot.adapter.push`）
- 性能：`e.runtime` 懒加载、事件类型索引、单实例分发、计数批量写回、日志惰性求值

## 快速开始

两种取法，按「要不要自己编译内核」二选一：

```bash
# 已构建版（推荐）：内核已编译好，装上就能跑
git clone -b release --depth 1 https://github.com/HL-z7/JiuLi.git
cd JiuLi && pnpm install && pnpm start

# 源码版：跟最新提交 / 要改内核，启动时自动编译
git clone https://github.com/HL-z7/JiuLi.git
cd JiuLi && pnpm install && pnpm start
```

国内访问 GitHub 慢的话，在地址前加代理前缀 `https://gh-proxy.org/` 即可（clone 友好，分支与 tag 都正常）：

```bash
git clone -b release --depth 1 https://gh-proxy.org/https://github.com/HL-z7/JiuLi.git
```

也可以整体换用 Gitee 镜像（分支名一致）：`https://gitee.com/fox-glaze/jiuli.git`。

`master` 的 `lib/core/` 是 tsc 产物、不入库，所以源码版首次启动会多一步编译（CLI 自动做）。
每次发版会打 tag、建 Release，并把编译好的产物推到 `release` 分支，两个分支内容同步。

调试推荐前台运行，终端里可以直接敲指令：

```bash
node .
> #玖璃帮助
> #设置主人
```

CLI 用法 `node jiuli <命令>`（等价 `pnpm jiuli`）：

| 命令 | 简写 | 说明 |
|---|---|---|
| `init` | `i` | 安装依赖 + 编译内核 + 生成配置 |
| `start` | `s` | pm2 后台启动（`--fg` / `f` 前台） |
| `stop` | `x` | 停止 |
| `restart` | `r` / `rs` | 重启 |
| `log [条数]` | `l` | 查看日志（`-f` 持续输出，`flush` 清空） |
| `status` | `st` | 环境与运行状态 |
| `list` | `ls` | 列出插件目录 |
| `create <名称>` | `c` | 生成插件骨架（`--dsl` / `--dir`） |
| `add <git地址>` | `a` | 安装第三方插件（`--name 目录名` 指定目录名） |
| `session` | `m` | 在 tmux 会话里启动（可脱离/接回，服务器推荐） |
| `attach` | `at` | 接回 tmux/screen 会话（实时日志 + 可输入指令） |
| `build` | `b` | 编译内核 |
| `deps` | `d` | 扫描 `plugins/` 下 JS 插件的 import，一键装齐缺失依赖（`--dry` 只看不装） |
| `tune` |  | 一键内存优化：堆上限 512MB、浏览器空闲 10 分钟关闭、50 张重启（`--show` 查看 / `--revert` 还原） |

启动模式：

| 命令 | 进程模型 | 重启行为 |
|---|---|---|
| `node .` | 守护进程 + 主进程，占用当前终端 | 以退出码 255 退出，守护进程在同一终端重新拉起（不开新窗口） |
| `pnpm start` | pm2 托管 | 交给 pm2 |
| `node . start` | 单进程 | 交给外部管理器（systemd / supervisor） |

## 内置功能

| 目录 | 归属 | 内容 |
|---|---|---|
| `plugins/example/` | **你自己** | 平铺 js 插件，增删改即时热重载 |
| `plugins/system/` | 框架 | 帮助 / 状态 / 诊断 / 版本 / 设置主人（含新增·删除主人）/ 词条 / 撤回 / 重载 / 重启 / 关机 / 日志 / 更新 / 上下线 |
| `plugins/adapter/` | 框架 | `stdin.js` 终端交互、`mock.js` 无协议端调试 |
| `plugins/demo/` | 框架 | 三种插件写法与渲染示例（`#渲染测试`） |
| `plugins/<其它>/` | 第三方 | clone 来的插件，不入库，依赖由 pnpm workspace 安装 |

目录地图与加载规则见 [plugins/README.md](plugins/README.md)。

## 日志

```
[  JiuLi  ] ──────── 启动中 ────────
[  JiuLi  ] v3.1.3 · 插件可见的框架标识 JiuLi v3.1.3
[  Redis  ] 已连接 redis://127.0.0.1:6379/0
[  Server ] 启动 HTTP 服务器 http://[::]:1721
[  Render ] 渲染后端 puppeteer 已就绪 · 类型 image · 支持 script 是
[  Plugin ] 插件 110 个 · 规则 377 条 · 事件监听 28 个 · 定时任务 4 个 · 用时 14秒345
[ Adapter ] 适配器 3 个 · Mock(QQ) · 标准输入(stdin) · QQBot(QQBot)
[  JiuLi  ] ──────── 启动完成 · 总耗时 15秒021 ────────

[   Msg   ] 收 ◀ 群 测试群(888777666) · 小明(10001) · 主人 · #状态
[  Plugin ] 中 ▶ 状态统计 <system/status.js> · 规则 /^#(状态|统计)/ · 方法 status · 优先级 5000
[   Msg   ] 发 ▶ 群 测试群(888777666) · 转发(2节点) · 由 状态统计 · 0ms
[  Plugin ] 完成 状态统计 · 73ms
```

左侧 `[  xxx  ]` 是日志 id 列，宽度由 `bot.yaml → log_align` 决定（默认 `"  JiuLi  "`），
未指定 id 的框架级日志会显示 `[  JiuLi  ]`。

- 收发消息内容、命中插件与正则、耗时都会记录（`bot.yaml → log_msg: false` 可关）
- 指令命中规则但插件没响应时会补一句提示（默认关；开启后也只对 `#` 开头的消息提示，
  `bot.yaml → no_handler_tip` / `no_handler_tip_prefix`）
- 插件并行导入，启动慢时看「启动关键路径」那一行（详见[排查](docs/architecture.md#启动耗时分析)）

## 热重载

内核监听整个 `plugins/` 目录，新增 / 修改 / 删除 js、新建插件目录约 2 秒内自动生效
（含 `index.js` 与 `apps/` 深层文件），`bot.yaml → file_watch: false` 可关。

卸载插件时会清理它注册的 express 路由与 WebSocket 路径，自带 Web 服务的插件反复重载不会出现路由重复或端口占用。

重载会重新求值整张插件模块图，**求值顺序会变**。插件若把循环 import 和顶层副作用混在一起，重载时可能撞上 `ReferenceError: Cannot access 'x' before initialization`（冷启动顺序恰好是好的）；这种失败可能被插件自己吞掉，表现为「指令全没了但进程还在线」。框架会认出它并自动重启恢复（两分钟内只重启一次，`bot.yaml → reload_restart_on_error: false` 可关），根治办法见[插件指南](docs/plugin-guide.md#热重载与模块级资源)。

`#重载` 只用于自动机制覆盖不到的情况：`#重载` 补漏加载磁盘上还没加载的插件，`#重载 关键词` 强制刷新匹配的插件。

## 服务器上常驻运行

想在服务器上同时保住「进程常驻」「实时日志」「终端敲 `#重启`」，用一条命令进 tmux 会话：

```bash
node jiuli m           # 进入 tmux 会话 jiuli：不存在则新建，已存在则接管
# Ctrl+B 再按 D        # 脱离：进程继续跑，SSH 断开也不受影响
node jiuli attach      # 重新连上：实时日志与终端输入都还在（历史输出 Ctrl+B 再按 [）
```

会话名默认 `jiuli`，可用环境变量 `JIULI_SESSION` 覆盖。没装 tmux 会自动尝试 screen；
两者都没有则打印三种选择（装 tmux / 前台 `node .` / 后台 `pnpm start`），不会硬启动。

## 更新

聊天里的内置指令（与云崽一致，更新成功后自动重启）：

| 指令 | 说明 |
|---|---|
| `#更新` | 更新框架本体 |
| `#更新ICQQ` | 只更新指定插件，插件名可简写（`Yunzai-ICQQ-Plugin` → `ICQQ`） |
| `#静更新` / `#安静更新` | 静默：仅在有更新或出错时回复 |
| `#强制更新[插件名]` | `git reset --hard origin/<分支>` 后拉取，丢弃本地改动 |
| `#全部[静][强制]更新` | 框架 + `plugins/` 下所有 git 仓库（非 git 目录自动跳过） |
| `#更新日志 [插件名]` | 最近提交，以转发消息发出 |

- 只有 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 变动时才 `pnpm install`
- 同一时间只允许一个更新流程；拉取失败会给出原因与下一步，本地改动不会被静默丢弃
- 自动更新：`bot.yaml → update_time`（分钟，默认 1440）/ `update_cron`

命令行等价：`git pull && pnpm install && node jiuli r`。

## 写插件

```bash
node jiuli c my-plugin          # plugins/example/my-plugin.js
node jiuli c my-plugin --dsl    # 函数式 DSL
```

```js
import { JiuLiPlugin } from 'jiuli'

export default class Hello extends JiuLiPlugin {
  constructor() {
    super({ name: '你好', rule: [{ reg: '^#你好$', fnc: 'hello' }] })
  }
  async hello(e) {
    await e.reply('你好呀')
  }
}
```

三种形态（云崽 `plugin` 基类 / `JiuLiPlugin` 类 / `definePlugin` DSL）共用同一套注册表与分发流程。
完整说明见 [docs/plugin-guide.md](docs/plugin-guide.md)。

## 目录结构

```
jiuli/
├─ app.js              启动入口
├─ jiuli.mjs           CLI
├─ src/                内核 TS 源码（编译到 lib/core/）
├─ lib/                运行时：编译产物 + 手写兼容层 shim
├─ renderers/puppeteer 渲染后端
├─ plugins/            插件目录
├─ config/
│  ├─ default_config/  默认配置（随仓库）
│  └─ config/          用户配置（首次启动生成，不入库）
├─ templates/          插件骨架模板
└─ test/               测试脚本（不入库，开发者本地保留）
```

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| 内核 | `src/` → `lib/core/` | 事件总线、插件注册与分发、配置中心、存储、渲染协议、指标、日志 |
| 兼容层 | `lib/**`（手写 JS） | 复刻云崽契约的 shim：物理路径、全局变量、`e` 对象、`Bot` 语义 |
| 插件 | `plugins/**` | 两套写法共用同一注册与分发流程 |

旧插件里写死的 `../../lib/plugins/plugin.js` 这类路径无法重定向，因此兼容层必须物理存在于 `lib/` 下。

```
适配器 Bot.em('message.group.normal', e)
  → Bot.prepareEvent(e)         补全 bot/friend/group/member/sender/reply
  → lib/events/message.js       监听器
  → PluginsLoader.deal(e)       黑白名单 → 冷却 → 回复包装 → runtime 挂载
  → 事件索引取候选插件 → accept（短路）→ rule 匹配 → 权限校验 → 调用插件方法
  → e.reply(...) → 适配器发送
```

详见 [docs/architecture.md](docs/architecture.md)。

## 兼容性

已支持：`plugin` 基类全部字段与方法、`rule` / `task` / `handler` / `accept` / `init()`、上下文会话、
事件对象 `e` 常用面、全局变量与 `lib/` 下可导入路径、云崽的消息计数键、渲染模板约定与旧截图入口、
适配器契约、`Bot` 事件总线（`Bot.on('message')` 原始事件流）、热重载。

**框架标识固定为 `JiuLi`，不可自定义**。只有 `config/config/jiuli.yaml → compat.spoof_yunzai: true`
（插件伪装模式）才对外展示 `trss-yunzai`，让个别插件走 TRSS 专属分支。插件里写死的框架名框架改不了。

已知限制：深层内部状态不保证与云崽一致；`e.runtime.MysInfo` 需要 `plugins/genshin` 存在；
`plugins/system`、`plugins/other` 在云崽里是插件而非内核，缺失时把目录复制过来即可。

## 生态插件移植

miao-plugin、genshin、yenai-plugin、xiaofei-plugin、HMeme、TRSS-Plugin、
Yunzai-QQBot-Plugin、Yunzai-ICQQ-Plugin、hl-icqq-web 均已实机验证。

```bash
node jiuli a <插件仓库地址>     # 或手动复制目录后 pnpm install
```

对插件所做的适配（跨插件路径、具名导出、`systeminformation` 惰性化等）逐条记录在提交信息里，
插件更新后照着重新应用。

## 配置

`config/config/*.yaml` 由 `config/default_config/` 首次启动生成。常用的：

- `bot.yaml`：`log_level`（`command` 等级只记录命中指令的消息，普通聊天不写日志）、`log_msg`、`log_rule_length`（规则日志里正则的显示上限）、`plugin_load_timeout`、`file_watch`、`chromium_path`、`max_old_space_size`
- `jiuli.yaml`：`compat.spoof_yunzai`、`redis_fallback`、`perf.*`
- `group.yaml`：群冷却、`enable` / `disable` 功能开关
- `server.yaml`：`url` / `port`（默认 1721）、`auth`（`access_token: <密钥>`，支持同名请求头、`Authorization: Bearer` 或 query 参数）、`public`（免鉴权路径前缀，面板类插件挂载的路径要加进来，例如 `/hl-icqq-web`、`/hl-qqbot-web`；插件也可以在挂载时 push 到 `Bot.express.public` 自行登记）、`trust_local_network`（未配 `auth` 时内网直连是否免鉴权，默认 `true`）、`allow_remote`（未配 `auth` 时是否允许公网直连，默认 `false`）

## 开发

```bash
pnpm build        # 编译内核
pnpm watch        # 增量编译
pnpm typecheck    # 仅类型检查
node jiuli.mjs status
```

改 `lib/**` 手写兼容层不用编译；改 `src/**` 需要 `pnpm build`。

**多实例 / 测试隔离**：`JIULI_CONFIG_DIR` 指定用户配置目录，`JIULI_PLUGINS_DIR` 指定插件目录。端口冲突时本次启动只报错退出，不会去结束占了端口的那个实例。

**升级排障时不要删** `data/`、`logs/`、`config/config/`——它们是运行状态。要重置就删单个
`config/config/*.yaml`，下次启动重新生成。

### 版本与发布

发布由 release-please 依据 conventional commits 自动判断，**默认走小版本（patch）**：

| 提交类型 | 版本变化 | 用途 |
| --- | --- | --- |
| `fix` / `perf` / `refactor` / `docs` / `test` / `chore` | 3.4.0 → **3.4.1** | 日常改动、小功能、体验优化 |
| `feat` | 3.4.x → **3.5.0** | 只给确实重大的新能力 |
| `feat!` / `BREAKING CHANGE` | → **4.0.0** | 破坏性变更 |

一批改动里混了 `feat` 但整体算不上大版本时，在提交正文里加一行 footer 压成 patch：

```
feat: xxx

Release-As: 3.4.1
```

release-please 会按这个版本出 Release PR（合并后才生效，平时不用写）。

## 许可

AGPL-3.0，与 TRSS-Yunzai 一致。本项目是其重构版本，保留原作者（TimeRainStarSky、Yoimiya-Kokomi、
Le-niao 等）的著作权声明。
