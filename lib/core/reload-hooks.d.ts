/** 当前运行环境是否支持「整张模块图重载」 */
export declare function supportsModuleReload(): boolean;
/**
 * 注册解析钩子并记住插件目录前缀。幂等，重复调用只更新前缀。
 * @param pluginDir 插件目录（相对或绝对路径都可以）
 * @returns 是否支持整图重载（false 表示只能重载入口，调用方应记一行提示）
 */
export declare function enableModuleReload(pluginDir: string): boolean;
export declare function bumpModuleGeneration(): void;
/** 标记重载区间：期间发生的模块求值失败都算「这次重载带来的」 */
export declare function beginReload(): void;
export declare function endReload(): void;
export declare function isReloading(): boolean;
/** 这次错误是否发生在某次重载新求值出来的模块里（错误信息里的 URL 会带 ?jiuli_reload=<代数>） */
export declare function isReloadEvalError(err: any): boolean;
/**
 * 模块初始化期错误（TDZ / 导入失败），区别于语法错误、缺依赖这类能直接修的错误。
 * 循环依赖的 TDZ 是 `ReferenceError`；`Cannot access 'x' before initialization`、
 * `Class extends value undefined` 也属于同一族。
 */
export declare function isModuleInitError(err: any): boolean;
/**
 * 检查一次求值失败要不要走自动重启。
 * @returns 需要重启时返回原因文案，否则返回空串
 */
export declare function failReload(err: any): string;
/** 取走「是否发生过需要重启的重载失败」，同时清零 */
export declare function consumeReloadFailure(): boolean;
/** 崩溃节流：同一进程内短时间内反复失败说明不是重载顺序问题，别一直重启 */
export declare function noteCrash(): boolean;
/** 仅供测试：把恢复相关状态清回初始值 */
export declare function resetReloadState(): void;
