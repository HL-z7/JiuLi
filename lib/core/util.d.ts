declare class Util {
    /** 截断文本（日志预览用） */
    truncate(str: any, length?: number): string;
    /** 描述消息内容（日志用），输出如 `"你好" + @10001 + 图片(11.5KB)` */
    describeMsg(msg: any): string;
    /** 事件场景描述（日志用），如 `群 测试群(888777666) · 测试用户(10001) · 主人` */
    describeScene(e: any, colored?: boolean): string;
    /** 耗时着色：<300ms 绿、<1s 黄、再慢红 */
    colorCost(ms: number, colored?: boolean): string;
    /** 日志中标记的消息来源（分发时写入，回复时读取） */
    markPlugin(e: any, name: string, key: string): void;
    makeLogID(id: any): any;
    isLogLevelEnabled(level: string): any;
    makeLog(level: string, msg: any, id?: any, force?: boolean): void;
    makeError(msg: string, ...obj: any[]): any;
    /**
     * 堆栈里第一处「业务代码」位置：优先 plugins/ 下的帧，找不到就退回第一处非内核帧
     * （node: 内部 / node_modules / lib/core 都不算），用于把报错落到具体文件行
     */
    errorFrame(error: any, keyword?: string): string;
    /** 统一的插件报错格式：一行原因 + 插件内出错位置 + 可选提示（完整堆栈由调用方按 debug 输出） */
    describeError(error: any, title: string, hint?: string): string;
    fsStat(file: string, opts?: any): Promise<false | import("fs").Stats>;
    mkdir(dir: string, opts?: any): Promise<boolean>;
    rm(file: string, opts?: any): Promise<boolean>;
    glob(pattern: string, opts?: any): Promise<string[]>;
    download(url: string, file?: string, opts?: any): Promise<{
        url: string;
        file: string | undefined;
        buffer: any;
    }>;
    /** 带磁盘持久化的 Map（插件数据存储） */
    makeMap(parent_map: any, parent_key: string, map: Map<any, any>): Map<any, any>;
    setMap(map: any, set: any, key: string, value: any): Promise<any>;
    delMap(map: any, del: any, key: string): Promise<boolean>;
    importMap(dir: string, map: Map<any, any>): Promise<Map<any, any>>;
    getMap(dir: string): Promise<any>;
    StringOrNull(data: any): string;
    StringOrBuffer(data: any, base64?: boolean): any;
    getCircularReplacer(): (this: any, _key: string, value: any) => any;
    String(data: any, opts?: any): any;
    Loging(data: any, opts?: any): any;
    /** 统一取 Buffer / base64:// / http(s) / file:// / 本地路径 */
    Buffer(data: any, opts?: any): Promise<any>;
    fileType(data: any, opts?: any): Promise<any>;
    /**
     * 重启 / 停止命令会被 pm2 的 TreeKill 连带收掉：子进程以 SIGINT 结束，
     * 但 pm2 守护进程早已收到指令，属于预期结果，不能当失败报。
     */
    isExpectedSignal(error: any, opts?: any): boolean;
    exec(cmd: string | string[], opts?: any): Promise<any>;
    cmdPath(cmd: string, opts?: any): Promise<any>;
    cmdStart(cmd: string, args?: string[], opts?: any): import("child_process").ChildProcessWithoutNullStreams;
    /** 在同一终端内启动进程（重启用，不开新窗口） */
    cmdInherit(cmd: string, args?: string[], opts?: any): import("child_process").ChildProcessWithoutNullStreams;
    getTimeDiff(time1?: number, time2?: number): string;
    promiseEvent(event: any, resolve: string, reject?: string, timeout?: number): any;
    sleepTimeout: symbol;
    sleep(time?: number, promise?: Promise<any>): any;
    debounceTime: symbol;
    debounce(func: (...args: any[]) => any, time?: number): (this: any, ...args: any[]) => any;
}
declare const _default: Util;
export default _default;
