export declare const chalk: import("chalk").ChalkInstance;
export type LogLevel = 'trace' | 'debug' | 'info' | 'command' | 'mark' | 'warn' | 'error' | 'fatal' | 'off';
export interface LoggerChannel {
    isLevelEnabled(level: string): boolean;
    trace(...args: any[]): void;
    debug(...args: any[]): void;
    info(...args: any[]): void;
    mark(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    fatal(...args: any[]): void;
}
/** 带来源列的写入入口：框架内部（util.makeLog）用它把模块名放进日志左边那列 */
export declare function writeLog(level: string, id: string | false | undefined, args: any[], raw?: boolean): void;
type LevelMethod = (...args: any[]) => void;
type Logger = typeof chalk & {
    trace: LevelMethod;
    debug: LevelMethod;
    info: LevelMethod;
    mark: LevelMethod;
    warn: LevelMethod;
    error: LevelMethod;
    fatal: LevelMethod;
    logger: {
        defaultLogger: LoggerChannel;
        commandLogger: LoggerChannel;
        errorLogger: LoggerChannel;
    } & LoggerChannel;
    setLevel(level: LogLevel): void;
    getLevel(): LogLevel;
    setWriteFile(enable: boolean): void;
};
export declare const logger: Logger;
export declare function setLogDir(dir: string): void;
/** 退出前同步补齐日志（process.exit 不等异步写，见 FileWriter.flushSync） */
export declare function flushLog(): void;
/** 按配置初始化日志等级 */
export declare function setLog(level?: LogLevel): void;
export {};
