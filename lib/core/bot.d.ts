import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { JiuLiEvent } from './types.js';
export default class JiuLiBot extends EventEmitter {
    stat: {
        start_time: number;
        online: number;
    };
    bot: this;
    bots: Record<string, any>;
    /** 机器人账号列表（特化数组） */
    uin: any;
    /** 适配器列表（按 path 去重） */
    adapter: any;
    express: any;
    server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
    httpsServer: any;
    url: string;
    wss: import("ws").Server<typeof import("ws").default, typeof http.IncomingMessage>;
    wsf: Record<string, any[]>;
    fs: Record<string, any>;
    fileTimers: Map<string, NodeJS.Timeout>;
    constructor();
    private pluginLayers;
    private pluginWs;
    /** 插件在加载期挂的事件监听：key → [{ event, listener }] */
    private pluginListeners;
    /** run() 末尾注册的兜底重定向 / 错误处理层；插件热重载追加路由后要把它们挪回末尾 */
    private fallbackLayers;
    /**
     * 当前正在加载的插件 key（由 loader 在 import 前后设置）。
     * 读的是 AsyncLocalStorage 里的上下文，不是全局变量 —— 插件并行导入时全局量会被
     * 别的插件改掉，导致路由被记到别人名下（见 lib/core/loading.ts 的说明）。
     */
    private get loadingKey();
    /** 包装 express 路由方法，记录每个插件注册的层；重载时先清理旧层，避免路由重复注册 */
    private wrapExpress;
    /**
     * 包装事件订阅方法，记录「哪个插件在加载期挂了哪些监听」，卸载 / 重载时移除。
     *
     * express 路由与 WS 路径一直是这么管的，事件监听漏了：插件在**模块顶层** `Bot.on(...)` 是
     * 生态插件很常见的写法（xiaofei 的 `guild.message`、yenai 的 `message.group` 点赞），
     * 而热重载会重新求值整张模块图 —— 旧那份监听留在 EventEmitter 上，每重载一次多一份，
     * 一条消息被处理 N 次（实测重载三次：监听数 2→5，一条消息命中 4 次）。
     *
     * 只记录**加载上下文里**的调用：插件在运行期（指令、定时任务里）动态挂的监听不算「插件资源」，
     * 不参与清理，免得把用户运行时才建的东西删掉。
     */
    private wrapEventMethods;
    /**
     * 把兜底重定向 / 错误处理层挪到 express 栈末尾。
     *
     * express 先注册先匹配，兜底必须在最后。启动时它们确实最后注册，但热重载的插件会重新
     * app.use()，新 layer 追加到末尾就把兜底顶到了前面 —— 正常启动后一直好好的，一改插件
     * 文件（不重启）面板就变 302 空白页，根因就在这里。
     */
    private ensureFallbackLast;
    /** 插件卸载/重载前清理它注册的路由与 WS 路径 */
    cleanupPluginResources(key: string): {
        routes: number;
        ws: number;
        listeners: number;
    };
    /** 鉴权失败计数（仅公网来源），用于阻断暴力尝试 */
    private authFails;
    /** 未就绪时挂起的请求上限：超出直接 503，避免启动窗口被刷出无界监听、把 req/socket 全留下来 */
    private static MAX_ONLINE_WAITERS;
    private onlineWaiters;
    /** 日志里的 URL 上限：请求行最长可达 16KB，原样落盘会让单条日志放大几个数量级 */
    private static MAX_LOG_URL;
    /** 入站连接上限：留出 FD 给 QQ 适配器与日志文件，公网刷连接时先把框架核心保住 */
    private static MAX_CONNECTIONS;
    private urlForLog;
    /** 回环地址（含 IPv4 映射形态） */
    isLoopback(addr: any): boolean;
    /**
     * 内网地址：10/8、172.16/12、192.168/16、IPv6 ULA 与链路本地。
     * 协议端（OneBot / Docker 容器 / 同网段机器）都从这里连进来，不能当公网拒掉；
     * 169.254 不开，云厂商元数据服务和链路本地探测都在那。
     */
    isPrivateAddress(addr: any): boolean;
    /**
     * 是否直连来源（本机或内网）。
     * 反向代理会把公网请求变成 127.0.0.1 或内网地址，所以带转发头的一律按外部处理，
     * 否则在 nginx 后面挂一层就等于没鉴权。转发头被伪造只会让自己被拒，不会放行。
     * 内网信任可用 server.yaml 的 trust_local_network: false 关掉。
     */
    private isLocalRequest;
    /**
     * 服务还没就绪（插件尚未加载完）时挂起请求。
     * 以前用 `once('online', ...)` 无上限地存，公网可以在启动窗口刷几万个请求，
     * 每个监听都攥着 req / socket，等于一条无鉴权的内存放大通道。
     */
    private whenOnline;
    /** 未就绪或排队过多：HTTP 回 503，WebSocket 握手写 503 后断开 */
    private rejectBusy;
    /** 常数时间比较：先摘要再比较，长度不同也不提前返回 */
    private safeEqual;
    /**
     * 校验 server.auth。携带方式：同名请求头、`Authorization: Bearer <token>`、query 参数，
     * 任一配置项命中即放行（沿用旧语义）。
     */
    private checkAuth;
    /**
     * server.public：不需要 token 的路径前缀。
     * 面板自带登录（会话 / JWT），`/File` 是带 ULID 的一次性文件地址（要发给 QQ 客户端取图），
     * 这两类没有 token 也必须能访问。其余路径一律走鉴权。
     */
    private isPublicPath;
    /** 公网鉴权失败限流：同一 IP 10 分钟内失败超过 20 次直接 429 */
    private hitAuthFail;
    /** 拒绝请求：express 请求回状态码，WebSocket 握手由 wsConnect 自己写 401 */
    private denyAuth;
    /** 基础安全响应头：面板都是同源 iframe，SAMEORIGIN 足够 */
    serverSecurity(req: any, res: any, next: any): void;
    serverAuth(req: any): any;
    serverStatus(req: any): void;
    serverHandle(req: any): void;
    serverExit(req: any): Promise<void>;
    wsConnect(req: any, socket: any, head: any): any;
    serverEADDRINUSE(err: any, https?: boolean): Promise<void>;
    serverError(err: any, req: any, res: any, _next?: any): any;
    serverLoad(https?: boolean): Promise<void>;
    httpsLoad(): Promise<void>;
    run(): Promise<void>;
    fileToUrl(file: any, opts?: any): Promise<any>;
    setFileTimeout(name: string, file: any, time?: number): void;
    expireFile(name: string, file: any): void;
    cleanupBotConnection(ws: any): void;
    fileSend(req: any): void;
    prepareEvent(data: JiuLiEvent): void;
    /** 逐级 emit：message.group.normal → message.group → message */
    em(name?: string, data?: JiuLiEvent): void;
    getFriendArray(): any[];
    getFriendList(): any[];
    getFriendMap(): Map<any, any>;
    get fl(): Map<any, any>;
    getGroupArray(): any[];
    getGroupList(): any[];
    getGroupMap(): Map<any, any>;
    get gl(): Map<any, any>;
    get gml(): Map<any, any>;
    pickFriend(user_id: any, strict?: boolean): any;
    get pickUser(): (user_id: any, strict?: boolean) => any;
    pickGroup(group_id: any, strict?: boolean): any;
    pickMember(group_id: any, user_id: any): any;
    sendFriendMsg(bot_id: any, user_id: any, ...args: any[]): any;
    sendGroupMsg(bot_id: any, group_id: any, ...args: any[]): any;
    /** 等待下一条符合条件的文本消息 */
    getTextMsg(fnc?: any): Promise<string>;
    /** 等待主人消息 */
    getMasterMsg(): Promise<string>;
    /** 给全部主人发送消息 */
    sendMasterMsg(msg: any, bot_array?: any, sleep?: number): Promise<any>;
    makeForwardMsg(msg: any): {
        type: string;
        data: any;
    };
    makeForwardArray(msg?: any, node?: any): {
        type: string;
        data: any;
    };
    sendForwardMsg(send: any, msg: any): Promise<any[]>;
    redisExit(): Promise<any>;
    exit(code?: number): Promise<any>;
    restart(): Promise<void>;
}
