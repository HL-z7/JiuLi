/** ============ 内存降级实现 ============ */
type Entry = {
    type: 'string' | 'hash' | 'set' | 'zset' | 'list';
    value: any;
    expireAt?: number;
};
declare class MemoryRedis {
    store: Map<string, Entry>;
    warned: Set<string>;
    isOpen: boolean;
    isReady: boolean;
    process: any;
    private expiryCursor?;
    private expiryTimer;
    constructor();
    private sweepExpired;
    private alive;
    private entry;
    private empty;
    private unsupported;
    get(key: string): Promise<any>;
    set(key: string, value: any, opts?: any): Promise<string>;
    setEx(key: string, seconds: number, value: any): Promise<string>;
    del(keys: string | string[]): Promise<number>;
    exists(keys: string | string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<0 | 1>;
    ttl(key: string): Promise<number>;
    incr(key: string): Promise<number>;
    incrBy(key: string, value: number): Promise<number>;
    decr(key: string): Promise<number>;
    decrBy(key: string, value: number): Promise<number>;
    mGet(keys: string[]): Promise<any[]>;
    mSet(pairs: any): Promise<string>;
    keys(pattern: string): Promise<string[]>;
    scan(cursor: string | number, opts?: any): Promise<{
        cursor: string;
        keys: string[];
    }>;
    private patternToReg;
    hGet(key: string, field: string): Promise<any>;
    hSet(key: string, field: any, value?: any): Promise<number>;
    hGetAll(key: string): Promise<{
        [k: string]: any;
    }>;
    hDel(key: string, fields: string | string[]): Promise<number>;
    hKeys(key: string): Promise<any[]>;
    hVals(key: string): Promise<any[]>;
    hIncrBy(key: string, field: string, value: number): Promise<number>;
    sAdd(key: string, members: string | string[]): Promise<number>;
    sMembers(key: string): Promise<any[]>;
    sRem(key: string, members: string | string[]): Promise<number>;
    sIsMember(key: string, member: string): Promise<any>;
    sCard(key: string): Promise<any>;
    zAdd(key: string, members: any): Promise<number>;
    zRange(key: string, start: number, stop: number, opts?: any): Promise<any[]>;
    zRangeWithScores(key: string, start: number, stop: number): Promise<{
        value: any;
        score: any;
    }[]>;
    zRem(key: string, members: string | string[]): Promise<number>;
    zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>;
    zCard(key: string): Promise<any>;
    /** zset 快照：按 score 升序，同分按成员字典序；键不存在或类型不符返回空数组 */
    private zsetEntries;
    private scoreBounds;
    zCount(key: string, min: number | string, max: number | string): Promise<number>;
    /** opts 与 node-redis v4 一致：{ LIMIT: { offset, count } } */
    zRangeByScoreWithScores(key: string, min: number | string, max: number | string, opts?: any): Promise<{
        value: string;
        score: number;
    }[]>;
    zRangeByScore(key: string, min: number | string, max: number | string, opts?: any): Promise<string[]>;
    zScore(key: string, member: string): Promise<any>;
    zRank(key: string, member: string): Promise<number | null>;
    zRevRank(key: string, member: string): Promise<number | null>;
    lPush(key: string, values: any): Promise<any>;
    rPush(key: string, values: any): Promise<any>;
    lRange(key: string, start: number, stop: number): Promise<any>;
    lPop(key: string): Promise<any>;
    rPop(key: string): Promise<any>;
    lLen(key: string): Promise<any>;
    ping(id?: string): Promise<string>;
    info(): Promise<string>;
    flushAll(): Promise<string>;
    sendCommand(args: any[]): Promise<any>;
    multi(): any;
    duplicate(): this;
    on(): this;
    once(): this;
    off(): this;
    quit(): Promise<string>;
    disconnect(): Promise<undefined>;
}
/**
 * 插件大多直接调 redis.xxx()，缺方法时抛 TypeError 会中断整条业务链路；
 * 这里用 Proxy 兜住所有未实现的命令，交给 unsupported() 返回 null 并只告警一次。
 */
export declare function memoryRedis(): any;
/** ============ 真实客户端封装（兼容 TRSS 的 Redis 类行为） ============ */
export declare class Redis {
    opts: any;
    redis: any;
    err: any;
    lock: boolean;
    exit?: boolean;
    private hasConnected;
    private errAt;
    constructor(opts: any, exit?: boolean);
    connect(force?: boolean): Promise<any>;
    /**
     * 本机没有 Redis 时尝试自动安装（仅 root + 已知包管理器，装不上就按 redis_fallback 降级）
     * 首次部署最常见的缺件就是它，与其让日志报一堆 ECONNREFUSED 不如直接补齐
     */
    private installLocal;
    start(): Promise<any>;
    onerror: (err: any) => void;
}
/** 注入全局 redis */
export declare function redisInit(): Promise<any>;
export { MemoryRedis };
export default redisInit;
