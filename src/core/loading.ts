/**
 * 「当前正在加载哪个插件」的加载上下文
 *
 * loader 在导入插件前后要让 Bot 知道「这批 express 路由 / WS 路径归哪个插件」，
 * 原来只用一个全局变量 `globalThis.__jiuliLoading`。而插件是**并行导入**的
 * （load() 起多个 worker），全局量会被同时进行的另一个插件覆盖：实测把生态插件
 * 全开时，某个插件的 35 条路由全被记到了 `HMeme` 名下。后果有两层 ——
 * 卸载/重载它时清理不到自己的路由（路由翻倍、限流闸门跑两遍），而重载 HMeme 时
 * 反而会把这个插件的路由删掉（面板直接 404）。
 *
 * 改用 AsyncLocalStorage 携带：`import()` 进来的模块，其顶层代码以及顶层 await
 * 之后的代码都在同一个异步上下文里（Node 20+ 实测可穿透），并行导入互不干扰。
 * 全局变量保留为兜底 —— 插件自己直接 import 文件、或第三方代码主动读它时行为不变。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage<string>()

/**
 * 当前正在加载的插件 key；不在任何加载上下文里时返回 undefined。
 * @returns plugins/ 下的相对 key（如 `hl-douyin-plugin`、`example/foo.js`）
 */
export function currentLoadingKey(): string | undefined {
  return als.getStore() ?? (globalThis as any).__jiuliLoading
}

/**
 * 在「正在加载 key」的上下文里执行 fn。用于包住 `await import(插件入口)`。
 *
 * 全局变量只在同步阶段有效（fn 返回 Promise 时立即恢复，避免并行导入看到错的值），
 * 异步部分由 ALS 负责 —— 这正是原来出错的地方。
 *
 * @param key plugins/ 下的相对 key
 * @param fn 一般是 `async () => { ... await import(...) ... }`
 * @returns fn 的返回值
 */
export function runAsLoading<T>(key: string, fn: () => T): T {
  const g = globalThis as any
  const prev = g.__jiuliLoading
  g.__jiuliLoading = key
  try {
    return als.run(key, fn)
  } finally {
    g.__jiuliLoading = prev
  }
}
