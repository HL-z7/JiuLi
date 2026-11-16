/**
 * 插件代码热重载：让「日志写着重载、跑的却还是旧代码」真正生效 + 求值失败可恢复
 *
 * 原来的 changePlugin 只做一件事：`import('../../plugins/<key>/index.js?<时间戳>')`。
 * 入口带了时间戳，所以入口文件本身会重新求值；但入口里 `import './apps/x.js'`、
 * `import './lib/y.js'` 这类**嵌套说明符**解析出来的 URL 不带时间戳，直接命中 Node 的
 * ESM 模块缓存 —— 于是目录型插件（index.js + apps/ + lib/）改代码后日志里一行
 * 「插件修改 → 重载」，跑的还是旧模块，用户必须重启才生效。
 * 实测：给 lib/panel.js 里的标题加个标记，重载后指令输出里没有标记。
 *
 * 这里用 Node 的同步模块钩子（`module.registerHooks`，v22.15 / v23.5 起）在解析阶段
 * 给「plugins/ 下的插件文件」追加查询参数 `?jiuli_reload=<该插件的代数>`：
 * 重载某个插件只把它的代数 +1，它自己的整张模块图以全新 URL 重新求值（嵌套的也换），
 * 其他插件仍解析到原来的模块实例。
 *
 * 代数必须按插件隔离：用全局代数时，重载任意插件都会让所有插件的模块换新 URL，
 * 而只有被重载的那个会重新执行初始化 —— 其他插件运行时 `await import(...)` 会拿到
 * 一份没执行过初始化副作用的空模块（例如注册表变空、协议接口找不到）。
 * 而框架自身、根 node_modules、以及插件自带的 node_modules **不加**这个参数 ——
 * 那些是多个插件共享的依赖，重复求值等于把依赖实例也复制一份（有的包在顶层建连接、
 * 起定时器），既慢又容易出怪问题。
 *
 * 取不到 registerHooks（Node 偏老）时退化成原来的行为：只有入口会重新求值，
 * 并让 loader 打一行提示，别让用户以为改了代码就一定能生效。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';
/** 查询参数名。插件自己带 query 时不会冲突（用独立的键名） */
const STAMP = 'jiuli_reload';
/** plugins 目录的 file:// 前缀（带尾斜杠），只给这个前缀下的文件加参数 */
let prefix = '';
/** plugins 目录的绝对路径，用于把插件 key 还原成模块归属前缀 */
let pluginDirAbs = '';
/** 插件 key → 该插件拥有的模块 URL 前缀；目录插件带尾斜杠，单文件插件是精确 URL */
const roots = new Map();
/** 插件 key → 模块图代数：只有该插件被重载时才 +1 */
const generations = new Map();
/** 去掉 query/hash 的模块 URL → 归属插件 key，避免每次 resolve 都遍历全部插件 */
const ownerCache = new Map();
let registered = false;
/** 同步模块钩子；Node < 22.15 上没有，此时退回老行为 */
const registerHooks = nodeModule.registerHooks;
/** 当前运行环境是否支持「整张模块图重载」 */
export function supportsModuleReload() {
    return typeof registerHooks === 'function';
}
/**
 * 注册解析钩子并记住插件目录前缀。幂等，重复调用只更新前缀。
 * @param pluginDir 插件目录（相对或绝对路径都可以）
 * @returns 是否支持整图重载（false 表示只能重载入口，调用方应记一行提示）
 */
export function enableModuleReload(pluginDir) {
    pluginDirAbs = path.resolve(pluginDir);
    prefix = pathToFileURL(pluginDirAbs).href.replace(/\/+$/, '') + '/';
    if (registered || typeof registerHooks !== 'function')
        return supportsModuleReload();
    registerHooks({
        resolve(specifier, context, nextResolve) {
            return stamp(nextResolve(specifier, context));
        },
    });
    registered = true;
    return true;
}
/**
 * 登记插件 key 对应的模块归属范围（导入插件前调用）。
 * 目录型插件（`foo`）覆盖 `plugins/foo/` 下全部模块；单文件插件（`system/x.js`）只覆盖该文件。
 */
export function registerPluginRoot(key) {
    if (!pluginDirAbs)
        return;
    const url = pathToFileURL(path.resolve(pluginDirAbs, key)).href;
    roots.set(key, key.endsWith('.js') ? url : `${url.replace(/\/+$/, '')}/`);
    ownerCache.clear();
}
/** 模块 URL 归属哪个插件的模块图；未登记的 plugins/ 模块视为共享代码，不加戳 */
function ownerOf(url) {
    const base = url.split(/[?#]/)[0];
    if (ownerCache.has(base))
        return ownerCache.get(base) ?? undefined;
    let owner;
    let length = -1;
    for (const [key, root] of roots) {
        const hit = root.endsWith('/') ? base.startsWith(root) : base === root;
        if (hit && root.length > length) {
            owner = key;
            length = root.length;
        }
    }
    ownerCache.set(base, owner ?? null);
    return owner;
}
/**
 * 给插件模块 URL 打上「它所属插件」的代数。
 * 未被重载的插件代数不变，运行时动态 import 仍命中原来的模块实例。
 */
function stamp(result) {
    const url = result?.url;
    if (!url || !url.startsWith(prefix) || url.includes('/node_modules/'))
        return result;
    const owner = ownerOf(url);
    if (!owner)
        return result;
    const generation = generations.get(owner) ?? 0;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return result;
    }
    if (!generation) {
        if (!parsed.searchParams.has(STAMP))
            return result;
        parsed.searchParams.delete(STAMP);
        return { ...result, url: parsed.href };
    }
    if (parsed.searchParams.get(STAMP) === String(generation))
        return result;
    parsed.searchParams.set(STAMP, String(generation));
    return { ...result, url: parsed.href };
}
// 新 URL 使插件重新求值，但 Node 的 ESM 缓存不会随卸载释放旧模块记录。
// 传 key 只换该插件的模块图；不传表示整目录刷新，所有已登记插件都换新。
// 每次 bump 用全局递增的唯一年代号，重载失败判定才能把「这次重载」和旧模块区分开。
let sequence = 0;
let lastBump = 0;
export function bumpModuleGeneration(key) {
    const stamp = ++sequence;
    lastBump = stamp;
    if (key) {
        generations.set(key, stamp);
        /** 归属缓存只服务当前模块图；重载后旧路径不会再被解析，顺手释放 */
        for (const [base, owner] of ownerCache)
            if (owner === key)
                ownerCache.delete(base);
        return;
    }
    for (const k of roots.keys())
        generations.set(k, stamp);
    ownerCache.clear();
}
/* ==================== 重载求值失败 → 整机重启恢复 ==================== */
/**
 * 为什么需要恢复：
 *
 * `?jiuli_reload=N` 会让整张插件模块图按**新的求值顺序**重来。插件若把「循环 import +
 * 顶层副作用」混在一起（例如 `model/db/BaseModel.js` 顶层就用从 `#index` 来的 `Data`，
 * 而 `#index` 又和 `base.js`、`gsCfg.js` 互成环），新顺序下顶层访问会撞上 TDZ：
 * `ReferenceError: Cannot access 'Data' before initialization`。
 * 冷启动的求值顺序恰好是好的，所以「重启就好、重载就坏」。
 *
 * 这种失败发生在模块求值里，可能被插件自己的 `Promise.allSettled` 吞掉 —— 框架只看到
 * 「一堆 ERROR + 指令全没了」，插件却还在线。此时唯一可靠的恢复是重启：新进程重新求值，
 * 顺序回到冷启动那份。所以这里识别这类错误并触发一次重启，同时用冷却避免真坏时重试风暴。
 */
let reloadDepth = 0;
/** 最近几次重载的年代号：只用于判定错误是否来自本次重载，留最近 200 次足够 */
const MAX_RELOAD_STAMPS = 200;
const reloadGenerations = new Set();
let reloadFailed = false;
let lastCrashAt = 0;
/** 标记重载区间：期间发生的模块求值失败都算「这次重载带来的」 */
export function beginReload() {
    reloadDepth++;
}
export function endReload() {
    if (reloadDepth > 0)
        reloadDepth--;
    /** 本次重载刚生成的年代号；模块 URL 里带它才算「这次重载求值出来的」 */
    if (reloadDepth === 0 && lastBump) {
        reloadGenerations.add(lastBump);
        while (reloadGenerations.size > MAX_RELOAD_STAMPS) {
            const oldest = reloadGenerations.values().next().value;
            reloadGenerations.delete(oldest);
        }
    }
}
export function isReloading() {
    return reloadDepth > 0;
}
/** 这次错误是否发生在某次重载新求值出来的模块里（错误信息里的 URL 会带 ?jiuli_reload=<代数>） */
export function isReloadEvalError(err) {
    const text = `${err?.stack || ''}\n${String(err?.message || err)}`;
    for (const m of text.matchAll(new RegExp(`${STAMP}=(\\d+)`, 'g')))
        if (reloadGenerations.has(Number(m[1])))
            return true;
    return false;
}
/**
 * 模块初始化期错误（TDZ / 导入失败），区别于语法错误、缺依赖这类能直接修的错误。
 * 循环依赖的 TDZ 是 `ReferenceError`；`Cannot access 'x' before initialization`、
 * `Class extends value undefined` 也属于同一族。
 */
export function isModuleInitError(err) {
    const name = String(err?.name || '');
    const msg = String(err?.message || err || '');
    if (/Cannot access '[^']+' before initialization/.test(msg))
        return true;
    if (/Class extends value (undefined|null) is not/.test(msg))
        return true;
    return name === 'ReferenceError' && /before initialization|is not defined/.test(msg);
}
/**
 * 检查一次求值失败要不要走自动重启。
 * @returns 需要重启时返回原因文案，否则返回空串
 */
export function failReload(err) {
    if (!isReloadEvalError(err))
        return '';
    if (!isModuleInitError(err))
        return '';
    reloadFailed = true;
    return String(err?.message || err);
}
/** 取走「是否发生过需要重启的重载失败」，同时清零 */
export function consumeReloadFailure() {
    const hit = reloadFailed;
    reloadFailed = false;
    return hit;
}
/** 崩溃节流：同一进程内短时间内反复失败说明不是重载顺序问题，别一直重启 */
export function noteCrash() {
    const now = Date.now();
    if (now - lastCrashAt > 120000) {
        lastCrashAt = now;
        return true;
    }
    return false;
}
/** 仅供测试：把恢复相关状态清回初始值 */
export function resetReloadState() {
    reloadDepth = 0;
    reloadGenerations.clear();
    reloadFailed = false;
    lastCrashAt = 0;
}
