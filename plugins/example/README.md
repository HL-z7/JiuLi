# 你自己的插件放这里

往里丢一个 `.js` 就会被加载，改动即时热重载。

```bash
pnpm jiuli create my-plugin     # 生成骨架（默认生成到这个目录）
```

目录里的 `qqbot图床.js` 是自行放入的第三方文件，已在 `.gitignore` 中排除。

## 依赖

`package.json` 是本目录插件的依赖清单。加依赖的步骤：

```bash
# 1. 在 plugins/example/package.json → dependencies 里加，例如 "axios": "^1.7.9"
# 2. 根目录安装
pnpm install
# 3. #重启（动态 import 的解析结果会被缓存，新装依赖必须重启）
```

已装好：`jiuli`（框架包）、`axios`、`form-data`。

> 任何自带 `package.json` 的插件目录都要声明 `"jiuli": "link:../.."`，否则
> `import ... from 'jiuli'` 会解析失败——Node 会就近找 package.json，找不到框架包。
> 本目录已声明，`pnpm jiuli create --dir` 生成的目录也会自动带上。

## 约定

- 一个 `.js` = 一个插件；也可以建子目录放 `index.js`
- 渲染模板放 `resources/<模板名>/index.html`，代码里 `await this.render('模板名/index', data)`
- 插件数据放 `this.dataDir`（`data/plugins/<插件目录名>/`）
- 内置功能在 `../system/`，示例在 `../demo/`，适配器在 `../adapter/`——这三个目录随框架更新，不要往里写自己的代码

完整说明见 [`../README.md`](../README.md) 与 [`../../docs/plugin-guide.md`](../../docs/plugin-guide.md)。
