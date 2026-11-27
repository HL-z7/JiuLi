/**
 * Runtime（e.runtime）
 *
 * 默认只做轻量挂载：不初始化用户信息，也不 import genshin 生态模块（理由见 loadGenshin）。
 * 第三方通过 Runtime.use() 注册了扩展（eagerUser）时才在分发前初始化。
 */
import type { JiuLiEvent, RenderOptions } from './types.js';
import Handler from './handler.js';
import { logger } from './log.js';
export interface RuntimeProvider {
    name: string;
    /** 是否需要在分发前初始化用户信息 */
    eagerUser?: boolean;
    initUser?: (e: JiuLiEvent, runtime: Runtime) => any;
    getMysInfo?: (e: JiuLiEvent, targetType: string, runtime: Runtime) => any;
    getUid?: (e: JiuLiEvent, runtime: Runtime) => any;
    createMysApi?: (uid: any, ck: any, option: any, isSr: boolean, runtime: Runtime) => any;
}
export default class Runtime {
    static providers: RuntimeProvider[];
    /** 注册扩展（第三方生态接入点） */
    static use(provider: RuntimeProvider): typeof Runtime;
    /**
     * genshin 插件是否已成功加载（由 loader 在导入成功后标记）
     *
     * 只有它为 true 时才允许框架去 import 生态模块：那些模块已经由插件正常求值完，
     * import 是纯缓存命中；插件没加载好时框架一律不碰它的模块图（见 loadGenshin 注释）。
     */
    static ecosystemReady: boolean;
    /**
     * 由 loader 调用：genshin 导入成功
     *
     * 重载后 Runtime 缓存的引用仍指向上一代模块实例，这里换成新代数的。
     * 刷新失败不丢已有引用（见 importGenshin），也不会向外抛：loader 在插件导入的 try 里
     * 调用本方法，reject 会被当成 genshin 插件加载失败并卸载它。
     */
    static markEcosystemReady(): Promise<void>;
    /**
     * 已加载的 genshin 生态模块：`{ gsCfg, MysApi, MysInfo, NoteUser, MysUser, Version }`
     *
     * 未安装 / 未成功加载 genshin 时各项为 undefined。框架自带的兼容层（如云崽 ck 文件导出）
     * 用它读用户 ck，这样第三方插件的数据结构变化只影响这一处。
     */
    static ecosystem(): Promise<Record<string, any>>;
    e: JiuLiEvent;
    handler: {
        has: typeof Handler.has;
        call: typeof Handler.call;
        callAll: typeof Handler.callAll;
    };
    private _mysInfo;
    private _userReady?;
    constructor(e: JiuLiEvent);
    /** 兼容：云崽在分发前调用 Runtime.init(e) */
    static init(e: JiuLiEvent): Promise<Runtime>;
    /** JiuLi：轻量挂载，重活留给首次访问 */
    static attach(e: JiuLiEvent): any;
    /** 用户信息懒初始化，重复调用复用同一 Promise */
    ready(): Promise<any>;
    get uid(): any;
    get hasCk(): any;
    get user(): any;
    get cfg(): {
        config: Record<string, any>;
        watcher: Record<string, any>;
        _package?: Record<string, any>;
        mergedCache: Map<string, any>;
        groupCache: Map<string, any>;
        get userDir(): string;
        initCfg(): void;
        get master(): Record<string, string[]>;
        get masterQQ(): Array<number | string>;
        get uin(): string[];
        get qq(): string[];
        get package(): Record<string, any>;
        get frameworkName(): string;
        get frameworkVersion(): string;
        getCompat(): any;
        getPerf(): any;
        getGroup(bot_id?: string | number, group_id?: string | number): Record<string, any>;
        getOther(): Record<string, any>;
        getdefSet(name: string): any;
        getConfig(name: string): any;
        getAllCfg(name: string): Record<string, any>;
        invalidate(name: string): void;
        getYaml(type: string, name: string): any;
        watch(file: string, name: string, type?: string): void;
        change_bot(): Promise<void>;
    } & Record<string, any>;
    get common(): {
        relpyPrivate: typeof import("./common.js").relpyPrivate;
        sleep: typeof import("./common.js").sleep;
        downFile: typeof import("./common.js").downFile;
        mkdirs: typeof import("./common.js").mkdirs;
        makeForwardMsg: typeof import("./common.js").makeForwardMsg;
    };
    get gsCfg(): any;
    get MysInfo(): any;
    get NoteUser(): any;
    get MysUser(): any;
    /** 包装 NoteUser，自动补上 e.game 参数（云崽行为） */
    initUser(): Promise<void>;
    getMysInfo(targetType?: string): Promise<any>;
    getUid(): Promise<any>;
    getMysApi(targetType?: string, option?: any, isSr?: boolean): Promise<any>;
    createMysApi(uid: any, ck: any, option: any, isSr?: boolean): any;
    /** 渲染并发送图片，兼容云崽 e.runtime.render；cfg 见 RenderOptions */
    render(pluginName: string, path: string, data?: any, cfgIn?: RenderOptions): Promise<any>;
}
export { logger };
