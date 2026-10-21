# Changelog

## [4.2.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v4.1.1...jiuli-v4.2.0) (2026-10-21)


### ✨ 新功能

* 新增 command 日志等级，只记录命中指令的消息 ([4fd42d0](https://github.com/HL-z7/JiuLi/commit/4fd42d08d1c05af29409200d86891f2b1e15fb9c))


### 🐛 Bug 修复

* 加固公网请求日志的内存放大与积压 ([d6ccec0](https://github.com/HL-z7/JiuLi/commit/d6ccec09942c245811380138cca886aee4ad0147))

## [4.1.1](https://github.com/HL-z7/JiuLi/compare/jiuli-v4.1.0...jiuli-v4.1.1) (2026-10-20)


### 🐛 Bug 修复

* #插件速度 改用合并转发并列出全部插件 ([84d3760](https://github.com/HL-z7/JiuLi/commit/84d3760f331235c5e459c5e09a61e493a1c79ec1))

## [4.1.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v4.0.2...jiuli-v4.1.0) (2026-10-20)


### ✨ 新功能

* 新增 #插件速度 查看插件加载耗时 ([e62c72c](https://github.com/HL-z7/JiuLi/commit/e62c72cd0776a2b6c6cec59cb7f168597e9e8283))


### 🐛 Bug 修复

* #状态 修正 Windows 11 的版本显示 ([adb4e7c](https://github.com/HL-z7/JiuLi/commit/adb4e7c69923f821f1f9af06a9e9e2a5628a366c))

## [4.0.2](https://github.com/HL-z7/JiuLi/compare/jiuli-v4.0.1...jiuli-v4.0.2) (2026-10-20)


### 🐛 Bug 修复

* 插件上下文方法缺失时不再打断消息分发 ([2a61bda](https://github.com/HL-z7/JiuLi/commit/2a61bda1c777fdfba5ddec1cb8ca412ef6e838a7))

## [4.0.1](https://github.com/HL-z7/JiuLi/compare/jiuli-v4.0.0...jiuli-v4.0.1) (2026-10-20)


### 🐛 Bug 修复

* 兜底层不再被记进插件路由 ([e0a5202](https://github.com/HL-z7/JiuLi/commit/e0a52024e1231176f80d915d3003bcc0cc169d97))
* **内核:** 插件热重载后保持兜底层在栈末尾 ([ca7eabe](https://github.com/HL-z7/JiuLi/commit/ca7eabe59b21b51e119320bd75f487741d49577d))

## [4.0.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.4.3...jiuli-v4.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* 公网免鉴权接入（远程 OneBot 反连、Milky webhook 等）需要配置 server.auth，或显式设置 allow_remote: true

### 🐛 Bug 修复

* 核心 HTTP 默认拒绝公网未鉴权请求 ([d3941e4](https://github.com/HL-z7/JiuLi/commit/d3941e4c6b300c0e87020187386c3c6adda3f23f))

## [3.4.3](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.4.2...jiuli-v3.4.3) (2026-10-19)


### 🐛 Bug 修复

* 被禁言的群不再继续发消息 ([106797d](https://github.com/HL-z7/JiuLi/commit/106797de581a212b444467f3d4bc86b6119af830))

## [3.4.2](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.4.1...jiuli-v3.4.2) (2026-10-18)


### 🐛 Bug 修复

* 关浏览器时不再误报 browser.close is not a function ([a699e33](https://github.com/HL-z7/JiuLi/commit/a699e33ccbbe4560393f73c4f24b5a62668ee6a4))

## [3.4.1](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.4.0...jiuli-v3.4.1) (2026-10-17)


### ✨ 新功能

* 守护进程按配置注入堆上限 ([e647792](https://github.com/HL-z7/JiuLi/commit/e647792670e316852dd766043ee71d1098ce4655))


### 📝 文档

* 补充版本号规则 ([17b3be3](https://github.com/HL-z7/JiuLi/commit/17b3be360adc23c21952c5436822c4ecf82b72ab))

## [3.4.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.3.0...jiuli-v3.4.0) (2026-10-17)


### ✨ 新功能

* 完成、慢插件、执行出错日志带触发场景 ([f73be4c](https://github.com/HL-z7/JiuLi/commit/f73be4c9cc44eed6b5a5ec93d21179ed0f790266))
* 规则日志的正则长度可配置 ([5b92ec0](https://github.com/HL-z7/JiuLi/commit/5b92ec0f55977ba211cae19fdb8de4d0cb70bb6c))

## [3.3.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.5...jiuli-v3.3.0) (2026-10-17)


### ✨ 新功能

* 新增 node jiuli tune 一键内存优化与还原 ([65bf935](https://github.com/HL-z7/JiuLi/commit/65bf93503445fa7c3913b35821f33cf2ebd87221))


### 🐛 Bug 修复

* 重启前关闭 Chromium，避免残留孤儿浏览器 ([5df9a4c](https://github.com/HL-z7/JiuLi/commit/5df9a4cf72e0c5044ad6ff8d291979b16248fe80))

## [3.2.5](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.4...jiuli-v3.2.5) (2026-10-16)


### 🐛 Bug 修复

* chromium_path 支持目录与 .app 写法，并在用不了时给出提示 ([6069da2](https://github.com/HL-z7/JiuLi/commit/6069da2c282331c8ad895c6aeb344f28aac9c12e))

## [3.2.4](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.3...jiuli-v3.2.4) (2026-10-15)


### 🐛 Bug 修复

* 已编译分支不再尝试编译内核 ([509c050](https://github.com/HL-z7/JiuLi/commit/509c0508c02d0d60794735d34ad824d9bdcb623c))

## [3.2.3](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.2...jiuli-v3.2.3) (2026-10-15)


### 🐛 Bug 修复

* 「本轮未加载」不再把 0ms 的记录当成没加载 ([6fc105d](https://github.com/HL-z7/JiuLi/commit/6fc105dc5e424a41621d2c8547f777f7dbeee16d))

## [3.2.2](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.1...jiuli-v3.2.2) (2026-10-15)


### 🐛 Bug 修复

* 插件加载异常不再带走同批剩余插件 ([53eb80a](https://github.com/HL-z7/JiuLi/commit/53eb80ad06fb4bfeefc9582ff494ad3a82f526e2))

## [3.2.1](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.2.0...jiuli-v3.2.1) (2026-10-13)


### 📝 文档

* README 补已构建版本与 GitHub 代理加速 ([52f5ba3](https://github.com/HL-z7/JiuLi/commit/52f5ba387b59cdb650ff387772a5ba09f8e8c63b))

## [3.2.0](https://github.com/HL-z7/JiuLi/compare/jiuli-v3.1.3...jiuli-v3.2.0) (2026-10-13)


### ✨ 新功能

* **cli:** node jiuli deps 一键装齐插件依赖 ([5abf7a8](https://github.com/HL-z7/JiuLi/commit/5abf7a89c3b30d165bb828715e6c67d4436286bd))
* **cli:** 新增 session / attach，服务器上一条命令进 tmux 会话 ([431b63c](https://github.com/HL-z7/JiuLi/commit/431b63cb413c35558c97e4e784e174fc6e3c04b1))
* **compat:** 对外框架标识改为 JiuLi（原先显示 TRSS-Yunzai） ([5174251](https://github.com/HL-z7/JiuLi/commit/517425178cad8eede1070334b61496f8fa53211e))
* **compat:** 提供 plugins/other/ 别名，云崽插件不用再改路径 ([e2da6fb](https://github.com/HL-z7/JiuLi/commit/e2da6fb40c87a4551fa0b73178a0c274789b2f47))
* **config:** 默认关闭指令无响应时发送提示 ([251be7b](https://github.com/HL-z7/JiuLi/commit/251be7b836304a4a6d3ed47303370db0a89cd3d1))
* **deps:** ffmpeg 等外部命令启动自检 + 自动补装 ([e2a4b8d](https://github.com/HL-z7/JiuLi/commit/e2a4b8d2fda09f1d655e4911e143ca988e0e821f))
* **example:** 支持用户插件自带依赖（图床插件已可用）+ 修日志两处 bug ([cfad4a5](https://github.com/HL-z7/JiuLi/commit/cfad4a568e292200afa536b860e378ef5292960d))
* **hotreload:** #重载语义重定位 + 卸载时清理插件注册的路由/WS ([6299283](https://github.com/HL-z7/JiuLi/commit/6299283c0aac6d7116455b3d61ad64b02fe30290))
* JiuLi 框架首版实现（TS 内核 + 云崽兼容层 + 原生插件 API） ([231e7f2](https://github.com/HL-z7/JiuLi/commit/231e7f2c78940ffc2ab52b6c89d1b8fb4e7968cf))
* **log:** 重写日志输出与渲染细节，新增 #诊断 与渲染自检插件 ([be6af77](https://github.com/HL-z7/JiuLi/commit/be6af77c68198593958fb575100668bedf8e64e1))
* **log:** 重复日志折叠（终端只留一条 + 计数，文件仍完整）+ #诊断 改合并转发 ([49ed00a](https://github.com/HL-z7/JiuLi/commit/49ed00a09f7262d65a5d92c503963e386c3b6ec5))
* **reload:** #重载 会一并加载磁盘上未加载的插件 ([353a6f4](https://github.com/HL-z7/JiuLi/commit/353a6f4b14ac521ba9eedd3c5687075eaceb9476))
* **render:** 找不到浏览器时自动安装（含中文字体），并修正 .puppeteerrc 的误判 ([1a3da76](https://github.com/HL-z7/JiuLi/commit/1a3da767d70c26db25f506253e2ca9900ef77fd1))
* **update/render:** 游离 HEAD 容错 + 跳过 snap 浏览器 + 渲染配置改为用户文件 ([fd97fc0](https://github.com/HL-z7/JiuLi/commit/fd97fc0ab877ab821fe58f8ee66c79c4f2179d42))
* **update:** 支持 #更新&lt;插件名&gt; / #全部静更新，补齐云崽的 Update 类接口 ([c8a7f6d](https://github.com/HL-z7/JiuLi/commit/c8a7f6dc0df1eb6f4b5630bb1618bd927f98536f))
* 对外标识固定 JiuLi（仅伪装开关可切回）+ CLI 短命令 + 修 hl-icqq-web 硬编码 ([cbbf6fd](https://github.com/HL-z7/JiuLi/commit/cbbf6fd8f5fc1141dd774d0945dc7cc529a46f3f))
* 权限拒绝文案优化 + "指令无响应"主动提示 ([a68f06a](https://github.com/HL-z7/JiuLi/commit/a68f06a524984725a150fbe322779fed71e07866))
* **热重载:** 配置/数据 .js 结构判定 + 重载风暴熔断兜底 ([43c53ae](https://github.com/HL-z7/JiuLi/commit/43c53ae423742c7a0eb1354a2dde7dff75ea1937))
* 端口改 721 + 移植 5 个生态插件 + 完善原生插件体系 + 内核性能优化 ([a43bfc6](https://github.com/HL-z7/JiuLi/commit/a43bfc60cac3ebffb1b4177379190464c4b607ef))
* 群配置新增 onlyReplyMaster（只响应主人） ([83f80d8](https://github.com/HL-z7/JiuLi/commit/83f80d895ffefe1792dd8e06cdbe9a2e8e7853e0))
* 补上 ComWeChat / OPQBot / Satori / GSUIDCore / Milky 适配器 ([805f21a](https://github.com/HL-z7/JiuLi/commit/805f21a11c9f6875aac96e8a01a8d538cda75f03))
* 补上 Milky / Satori 的默认配置模板 ([eaa55db](https://github.com/HL-z7/JiuLi/commit/eaa55dbe5a090fd533fa6ee9f8b3255f6536e376))
* 补上 OneBotv11.js 适配器 ([34d290d](https://github.com/HL-z7/JiuLi/commit/34d290d8690559454bdebee75a6dcd255d9868cb))
* 补齐开箱可用能力（stdin 交互 / 内置插件 / pm2 / CLI）并实机验证 QQBot 适配器 ([6e83893](https://github.com/HL-z7/JiuLi/commit/6e83893be241a52b8864f231b2685f5d36be948a))


### 🐛 Bug 修复

* 「本轮未加载」不再把在飞文件算进去 ([484ef97](https://github.com/HL-z7/JiuLi/commit/484ef97e30a00c2bed18b7f86ad01aef988aae69))
* **bot:** Bot.express 被 bind 破坏导致插件挂路由失败（hl-icqq-web 加载报错） ([a88aab2](https://github.com/HL-z7/JiuLi/commit/a88aab25371e8e382b0d9c6fbce44e26f53295c6))
* **cli/redis:** screen 会话内不再套娃；首次启动自动补装 Redis ([b4e596c](https://github.com/HL-z7/JiuLi/commit/b4e596c09abd0858ff1b9a5f07a7a6c163634e92))
* **cli:** deps 只扫松散 JS 插件目录，并把依赖装到该目录 ([e17d1bd](https://github.com/HL-z7/JiuLi/commit/e17d1bd8ac32e00d2446cf99a9f043180545ae68))
* **cli:** session 补齐前置（依赖/编译/配置），app.js 对未编译给出明确指引 ([3026d32](https://github.com/HL-z7/JiuLi/commit/3026d329d3001af82c2e6f79204daf2008813f38))
* **cli:** 参数拼错不再默默忽略（--naem → 提示 --name；多余位置参数直接报错） ([12758aa](https://github.com/HL-z7/JiuLi/commit/12758aa3f8d869d350472a94873962027b8d2708))
* **compat:** 框架版本号 0.1.0 → 3.1.3（很多插件用它判断 V2/V3） ([536c4c5](https://github.com/HL-z7/JiuLi/commit/536c4c58ba4175694d449da8c17c0cc1367e3e9f))
* **compat:** 规则只传 e、补云崽日志文件名与浏览器接口、Mock 加头像 ([866ac77](https://github.com/HL-z7/JiuLi/commit/866ac776d1511f07d96ef27f3e6661179ddea58c))
* **compat:** 让出 #更新xxx 插件指令 + 补云崽 ck 文件兼容层 ([e97cc04](https://github.com/HL-z7/JiuLi/commit/e97cc04756469f6bb731ca7257e83e9f1273437b))
* **config:** 测试不再污染真实配置（JIULI_CONFIG_DIR）+ 设置主人跟随配置目录 ([33f19f7](https://github.com/HL-z7/JiuLi/commit/33f19f77ab556e62450deffa0d9026603fbdfe08))
* **config:** 用户配置被误删时的自愈（#设置主人 ENOENT 崩溃） ([ca8c7b2](https://github.com/HL-z7/JiuLi/commit/ca8c7b210717c271230005f7bfb722ddf7097d9f))
* **loader/log:** 同名类去重避免重复实例化；日志补框架名列并给等级上色 ([d290aed](https://github.com/HL-z7/JiuLi/commit/d290aed4fbdd48c202c7a406860c9c63c4257bd9))
* **loader:** priority 缺失时不再打乱分发顺序 ([996e640](https://github.com/HL-z7/JiuLi/commit/996e6402abb8d0ba2e442c0025ada76b8043266a))
* **loader:** 插件加载前预载 #miao，修掉 ZZZ-Plugin 触发的 Data TDZ ([3ee9f3d](https://github.com/HL-z7/JiuLi/commit/3ee9f3dc792c7f3849a17807185572461ee3d461))
* **loader:** 插件加载报错改成看得懂的两行 + 修好后的 #重载 能生效 ([313ee67](https://github.com/HL-z7/JiuLi/commit/313ee67ce070d24d6da0b9eec886f6d330c69584))
* **loader:** 插件加载期间每 5 秒报进度，不再"看着像卡死" ([a249737](https://github.com/HL-z7/JiuLi/commit/a24973765f979ed60563158213674d5c5ee0a81a))
* **loader:** 插件卡住时不再无限等下去（限并发 + 卡住即止损） ([8c33c78](https://github.com/HL-z7/JiuLi/commit/8c33c78c695b02f29862ae8be8a08f539104e522))
* **loader:** 通用加载错误也带上插件内的出错位置（没有行号只能靠猜） ([07a4495](https://github.com/HL-z7/JiuLi/commit/07a44954eeb29200ad0ea2aa8a1ff5bad1e1a47f))
* **log:** 发送成功被误报为失败（空 error 数组）+ 启动耗时 + 长命令日志截断 ([11a1a32](https://github.com/HL-z7/JiuLi/commit/11a1a32583594a160afde4a734e545732c7fb4df))
* **log:** 运行期报错同样只给一行 + 出错位置（不再整段堆栈） ([a7233b6](https://github.com/HL-z7/JiuLi/commit/a7233b6874e24db8951eac26679dfc9b2a76a441))
* master.js 缺 cfg 导入导致设置主人崩溃 + 无响应提示的归属 ([1314fb0](https://github.com/HL-z7/JiuLi/commit/1314fb046a2d54ceb1f2287a4c6990291641271a))
* **master:** #设置主人 与 #新增主人 同一规则；修复配置缓存失效不完整 ([281edc0](https://github.com/HL-z7/JiuLi/commit/281edc0b1299baca2ad9bb8fc382c140cd4c5302))
* **plugin:** 修复自带 package.json 的插件目录无法 import jiuli + 热重载忽略 node_modules ([17bcd32](https://github.com/HL-z7/JiuLi/commit/17bcd323bfc591520c17b0457f90fe52bf4def25))
* **plugin:** 第三方插件放错位置的问题 + 热重载忽略 node_modules ([49682dc](https://github.com/HL-z7/JiuLi/commit/49682dc5239c81772597ae276d741f24caf8a00c))
* **redis:** 连不上时不再谎报「已连接」+ 给出装法 + 反复失败自动降级 ([64d26a9](https://github.com/HL-z7/JiuLi/commit/64d26a99cd621765304097f87bd2ce67234919d2))
* **reload:** 加载期挂的事件监听也按插件记账清理 ([2561cbd](https://github.com/HL-z7/JiuLi/commit/2561cbd5adc6fa67f817f6b6596ff722eac6b90c))
* **reload:** 插件热重载真正生效：整图重算、同优先级次序不变、事件批量处理 ([96b062e](https://github.com/HL-z7/JiuLi/commit/96b062e61c754acb1dce72b77d43443c469ae58b))
* **render:** 空闲回收用了不存在的 browser.removeListener，导致浏览器永远关不掉 ([08f9841](https://github.com/HL-z7/JiuLi/commit/08f9841a95dbbdb6327d2bd03080a52e0c07a2c8))
* **render:** 补 emoji 字体（自动安装 + 启动自检 + 自检断言） ([fa8c7e7](https://github.com/HL-z7/JiuLi/commit/fa8c7e7dec0a1d87d515e580282ef76e025bafa4))
* **runtime:** 回退框架主动 import 生态模块的改动，修 TDZ / V8 Fatal 崩溃 ([a93a1db](https://github.com/HL-z7/JiuLi/commit/a93a1db2cc12697b21148d29785c4450b6cef6b0))
* **runtime:** 预热挪到插件加载结束之后，修掉 genshin/miao 模块图的 TDZ 报错 ([d886349](https://github.com/HL-z7/JiuLi/commit/d886349f73a6cea3ba85d334894d7593d5c97381))
* **update:** 恢复「匹配到多个插件」的当面提示，同时保住不截胡插件指令 ([a4bcf6a](https://github.com/HL-z7/JiuLi/commit/a4bcf6a727cb00fbd7440df0a758f3f5d4774a7d))
* **update:** 框架更新后自动重新编译内核（lib/core 是编译产物、不入库） ([946e730](https://github.com/HL-z7/JiuLi/commit/946e73093e27e580e1da8b90c670546b08454255))
* **依赖:** better-sqlite3 补进构建白名单，修鸣潮扫码取不到 ck ([76c5b39](https://github.com/HL-z7/JiuLi/commit/76c5b39725a88656f612530a23990d36b3d20f96))
* **依赖:** overrides 两处都放，pnpm 8/9+/12 全版本都能覆盖 sqlite3 ([fac20be](https://github.com/HL-z7/JiuLi/commit/fac20bec2a5e56280bf5da41e15d18db331730e4))
* **依赖:** sqlite3 覆盖改到 pnpm-workspace.yaml（pnpm 12 不再读 package.json 的 pnpm 字段） ([0a2b58a](https://github.com/HL-z7/JiuLi/commit/0a2b58a1a53bafc219689d0b3ef2600fcb23b8a6))
* **依赖:** 用 pnpm overrides 把 sqlite3 全量指向 NAPI 分支，避免插件触发原生编译 ([41e798e](https://github.com/HL-z7/JiuLi/commit/41e798edd32aca0edeee2a66c2f75e013b6e20d7))
* 停机 改为与关机同义 ([2fc88bb](https://github.com/HL-z7/JiuLi/commit/2fc88bb0cb0b1a743076b2dabc5733740c072fd2))
* 兼容壳包补 require 入口 ([cffe563](https://github.com/HL-z7/JiuLi/commit/cffe5638febabfa95744e57841c9509c131e6918))
* 内置 #帮助 归还用户插件 ([f47e13e](https://github.com/HL-z7/JiuLi/commit/f47e13e0a68574e7fece8848faacc3144ee57fa4))
* **启动:** 修中文路径下首次启动静默退出（Node 25 的 fs.cpSync 递归拷贝会崩进程） ([e3a5d2d](https://github.com/HL-z7/JiuLi/commit/e3a5d2dbbb0efe0f81e3a1fe249aa2fc3a5b9f9d))
* 守护进程拉起的子进程不再递归进入守护模式 ([ff5a1f7](https://github.com/HL-z7/JiuLi/commit/ff5a1f73716264d3c0fbe7ec980a24d2d7aaf9da))
* 守护进程收到终止信号时结束子进程（SSH 断开不留孤儿）+ 内置插件日志补 id 列 ([24343b3](https://github.com/HL-z7/JiuLi/commit/24343b3c53e86f4b126441f3a0a016bc0ab437aa))
* 守护进程设连续失败上限 ([9dff1de](https://github.com/HL-z7/JiuLi/commit/9dff1de192e8dbcb0a2c22aba971cb887fa0245b))
* 插件加载超时不再连坐整批插件 ([2173ec2](https://github.com/HL-z7/JiuLi/commit/2173ec2adf0f0347ff632ba1f6b58f212659e3a2))
* 日志左列统一 id、#状态 重写、#新增主人/#删除主人 ([83e9f0b](https://github.com/HL-z7/JiuLi/commit/83e9f0b67151003bfcca5f4d7c4835330c9bc3c8))
* 添加词条固定目标群 ([c49a352](https://github.com/HL-z7/JiuLi/commit/c49a352b94c616dfa67dd38622ce5cb38bc5ae96))
* 渲染按模板路径串行 ([d428ce8](https://github.com/HL-z7/JiuLi/commit/d428ce82c099911aff03c42cc967245568243e21))
* **热重载/提示:** 删嵌套文件不再卸载插件 · 熔断只算自激重载 · 无响应提示只认 # 前缀 ([7f827b4](https://github.com/HL-z7/JiuLi/commit/7f827b40e196da1edb28d24e0a894df08f30ceb3))
* **热重载:** #重载 &lt;插件名&gt; 强制刷新时解除该插件熔断 ([c39c8a7](https://github.com/HL-z7/JiuLi/commit/c39c8a716936fb4ff4103700763eee7602db2167))
* **热重载:** 归属修正与失败 key 判定 ([99d3bca](https://github.com/HL-z7/JiuLi/commit/99d3bcac87a90daa081db4389ecdbf3594e26678))
* 热重载恢复判定要覆盖浮动失败 ([c7b43ab](https://github.com/HL-z7/JiuLi/commit/c7b43abf1b81c23b7400c909bcf81aa05e034476))
* 热重载模块初始化失败自动重启恢复 ([6fa55f5](https://github.com/HL-z7/JiuLi/commit/6fa55f54257d1a2bc1288b5692fff801409da701))
* 端口冲突只结束自己，退出前同步补齐日志 ([7b97a72](https://github.com/HL-z7/JiuLi/commit/7b97a72589e2a0a4dc11d9f6905580502bcefc19))
* 群级等待上下文按对象身份收尾 ([7ea3c0e](https://github.com/HL-z7/JiuLi/commit/7ea3c0e01eb64e16d2c29f51523079fb7e57292d))
* 补拉后重载适配器 ([2bbf6e5](https://github.com/HL-z7/JiuLi/commit/2bbf6e5a645ed267282254268a58bd237403df21))
* 运行期间数据/配置目录被清理时的自愈 + 未处理错误日志名 ([b0884de](https://github.com/HL-z7/JiuLi/commit/b0884de37c45e1dac99ecf14646cd8092afa1a08))


### ⚡ 性能优化

* 启动提速约 40% + 端口改 1721 + HMeme 资源目录修复 ([3248719](https://github.com/HL-z7/JiuLi/commit/3248719d01e8c7e27540e411fcdd0f4502602c59))
* **热重载:** 不再给插件的图片等非 js 文件建监听，常驻内存明显下降 ([110ebf3](https://github.com/HL-z7/JiuLi/commit/110ebf3fe88a4087c1e71e4031d631f32060afa4))


### 📝 文档

* add 命令补充 --name 说明（插件目录重命名） ([5f8f8f9](https://github.com/HL-z7/JiuLi/commit/5f8f8f9562bccaf99664b0f569504898561da56f))
* other/ 路径适配已由框架别名取代；补充框架版本号必须为 V3 家族的原因 ([c54b82a](https://github.com/HL-z7/JiuLi/commit/c54b82aae3d9cb1520b83c56f2f1218ceed6e15d))
* README 补官方文档链接 ([960a2ce](https://github.com/HL-z7/JiuLi/commit/960a2ce6c74cf71bb15152c1a26a0b8dce241108))
* 删除调研报告与移植补丁记录 ([8668e34](https://github.com/HL-z7/JiuLi/commit/8668e34b68c5efa3d2f5d215b0545bbfaf1a183c))
* **插件开发:** 补「别在模块顶层写回自己的文件」与自激跳过/熔断说明 ([541841e](https://github.com/HL-z7/JiuLi/commit/541841e2edcd438196cb29f667cffbc6ca439474))
* 文档精简重写 + 全仓库注释去冗余 ([1880496](https://github.com/HL-z7/JiuLi/commit/1880496eff91db1627a21258800852616a9a2a63))
* **架构:** 补热重载第 5 条 —— 配置/数据结构判定与重载风暴熔断 ([f2d073b](https://github.com/HL-z7/JiuLi/commit/f2d073b1b6cee9dfe2318299f9128fade6355e7c))
* 补 onlyReplyMaster 说明 ([4d01af7](https://github.com/HL-z7/JiuLi/commit/4d01af769f76e9e38a850be35b375d917d898db5))
* 补充 Bot 事件总线（Bot.on）说明 ([8811114](https://github.com/HL-z7/JiuLi/commit/8811114e420d41150fec9555f57bed3a285ca0cb))
* 补热重载的循环依赖与 TDZ 说明 ([023cfd2](https://github.com/HL-z7/JiuLi/commit/023cfd20eae56094b3b66ccb73e3eeeb77d99c2b))
* 补热重载边界说明（插件目录只能一层、异步写回的自激抓不到） ([8369d03](https://github.com/HL-z7/JiuLi/commit/8369d0362b7cedab59c82e35e6546933bdfbdfbb))


### ♻️ 重构

* **plugins:** 目录按归属拆开——example 是你的，system/demo/adapter 是框架的 ([4b78970](https://github.com/HL-z7/JiuLi/commit/4b789709097349c6e3644516bef9893e1c7212ac))
* **plugins:** 目录收敛为 example/ + adapter/，热重载与重启行为重做 ([cbcc31f](https://github.com/HL-z7/JiuLi/commit/cbcc31f9a670321ceca14691dbb8f745f5db463a))


### ✅ 测试

* **hl-ai:** 新增图片内联验证（可选用例） ([1510ffa](https://github.com/HL-z7/JiuLi/commit/1510ffa76ac2033e03617ef620029963e31c1833))
* **hl-ai:** 新增工具上下文并发隔离用例（可选用例） ([f81b3b3](https://github.com/HL-z7/JiuLi/commit/f81b3b32961d5b7985923f1209360f8a1af2e08d))
* **hotreload:** 覆盖插件 onUnload 契约（卸载时确实调用，供释放端口/定时器） ([cfef805](https://github.com/HL-z7/JiuLi/commit/cfef80521deab05c52892b13b57da445729acb68))
* **render:** 新增 pnpm test:render 渲染自检（走插件 render()，一次截图，失败给排查方向） ([a78d2cd](https://github.com/HL-z7/JiuLi/commit/a78d2cd93779aa98ee8944e1d51ad35f01de731a))
* **smoke:** 补 Mock 头像断言 ([0626922](https://github.com/HL-z7/JiuLi/commit/06269223ae012285a147fb76b13f06580379e017))
* **trss:** 新增 Code 模板超长行溢出检测（可选用例） ([23b5376](https://github.com/HL-z7/JiuLi/commit/23b5376c765c8a79f6ccdf09b5f70deaf4724f6e))
* **trss:** 新增 TRSS-Plugin 解压功能验证（可选用例，未装则跳过） ([b560bf9](https://github.com/HL-z7/JiuLi/commit/b560bf9a7ab61bb5c0336288dc7c9a0f72e4d312))
* **trss:** 解压用例默认路径改为自用 fork 版 TRSS-Plugin ([21f8298](https://github.com/HL-z7/JiuLi/commit/21f8298f545e04b8ea1e34bfdafdaca942097735))
* **update:** 补充 15 个消息样例的规则路由断言 ([cf9f313](https://github.com/HL-z7/JiuLi/commit/cf9f313ce45e1dc3ae853d1d2767393d03ba881c))
* 放宽 #状态 用例等待（redis 统计偶尔超过 600ms 导致偶发失败） ([9c50d83](https://github.com/HL-z7/JiuLi/commit/9c50d83d30c579ff4b5af63b09b12a6e462d6bfe))
* 补 #设置主人 端到端用例（验证码→校验→写入配置） ([659bc40](https://github.com/HL-z7/JiuLi/commit/659bc40ee72ef10c2879fb00cc4c945a9838ccbb))


### 🤖 CI/CD 配置

* 发布产物推到 release 分支 ([9426a84](https://github.com/HL-z7/JiuLi/commit/9426a84d85875e3fa65be77b5c34b6e25d488f18))
* 接入 release-please 自动发版 ([ee9e4ec](https://github.com/HL-z7/JiuLi/commit/ee9e4ec01b4833db5d25252384ab8b96e2cceb79))
