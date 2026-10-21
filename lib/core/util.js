/**
 * 工具层（兼容云崽 util / Bot.* 工具方法面）
 * Bot 的 Proxy 会将未命中的属性回落到这里，故这些方法同时是 Bot.fsStat / Bot.String 等的实现。
 */
import fs from 'node:fs/promises';
import timers from 'node:timers/promises';
import path from 'node:path';
import nodeUtil from 'node:util';
import { exec, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileTypeFromBuffer } from 'file-type';
import { ulid } from 'ulid';
import cfg from './config/index.js';
import { logger, writeLog } from './log.js';
class Util {
    constructor() {
        this.sleepTimeout = Symbol('timeout');
        this.debounceTime = Symbol('debounceTime');
    }
    /** 截断文本（日志预览用） */
    truncate(str, length = 60) {
        const text = String(str ?? '').replace(/\s+/g, ' ').trim();
        return text.length > length ? `${text.slice(0, length)}…(${text.length}字)` : text;
    }
    /** 描述消息内容（日志用），输出如 `"你好" + @10001 + 图片(11.5KB)` */
    describeMsg(msg) {
        if (msg === undefined || msg === null)
            return '(空)';
        const items = Array.isArray(msg) ? msg : [msg];
        const parts = [];
        for (const item of items) {
            if (typeof item !== 'object' || item === null) {
                parts.push(`"${this.truncate(item)}"`);
                continue;
            }
            switch (item.type) {
                case 'text':
                    parts.push(`"${this.truncate(item.text)}"`);
                    break;
                case 'image': {
                    const size = Buffer.isBuffer(item.file) ? ` ${(item.file.length / 1024).toFixed(1)}KB` : '';
                    parts.push(`图片${size}`);
                    break;
                }
                case 'record':
                    parts.push('语音');
                    break;
                case 'video':
                    parts.push('视频');
                    break;
                case 'file':
                    parts.push(`文件(${item.name || '未命名'})`);
                    break;
                case 'at':
                    parts.push(`@${item.qq}`);
                    break;
                case 'reply':
                    parts.push('引用');
                    break;
                case 'face':
                    parts.push(`表情(${item.id})`);
                    break;
                case 'node':
                    parts.push(`转发(${Array.isArray(item.data) ? item.data.length : 1}节点)`);
                    break;
                case 'button':
                    parts.push('按钮');
                    break;
                case 'markdown':
                    parts.push('markdown');
                    break;
                case 'raw':
                    parts.push('raw');
                    break;
                default:
                    parts.push(item.type ? `${item.type}` : '未知段');
            }
        }
        return parts.join(' + ') || '(空)';
    }
    /** 事件场景描述（日志用），如 `群 测试群(888777666) · 测试用户(10001) · 主人` */
    describeScene(e, colored = false) {
        const paint = (fn, text) => (colored ? fn(String(text)) : String(text));
        const scene = [];
        const tags = [];
        if (e.isGroup || e.group_id) {
            scene.push(`群 ${paint(logger.cyan, e.group_name || '')}(${paint(logger.cyan, e.group_id)})`);
            const who = e.sender?.card || e.sender?.nickname;
            if (who)
                scene.push(`${paint(logger.magenta, who)}(${paint(logger.magenta, e.user_id)})`);
            else if (e.user_id)
                scene.push(paint(logger.magenta, e.user_id));
        }
        else if (e.user_id) {
            const who = e.sender?.nickname || e.sender?.card || '';
            scene.push(`好友 ${paint(logger.magenta, who)}(${paint(logger.magenta, e.user_id)})`);
        }
        else if (e.notice_type || e.request_type) {
            scene.push(paint(logger.cyan, `${e.post_type}.${e.notice_type || e.request_type}`));
        }
        if (e.isMaster)
            tags.push('主人');
        if (e.atBot)
            tags.push('@Bot');
        if (e.hasAlias)
            tags.push('别名');
        if (e.isPrivate)
            tags.push('私聊');
        if (tags.length)
            scene.push(paint(logger.yellow, tags.join('/')));
        return scene.join(' · ') || String(e.self_id ?? '');
    }
    /** 耗时着色：<300ms 绿、<1s 黄、再慢红 */
    colorCost(ms, colored = true) {
        const text = `${ms}ms`;
        if (!colored)
            return text;
        if (ms < 300)
            return logger.green(text);
        if (ms < 1000)
            return logger.yellow(text);
        return logger.red(text);
    }
    /** 日志中标记的消息来源（分发时写入，回复时读取） */
    markPlugin(e, name, key) {
        e.logPlugin = name;
        e.logPluginKey = key;
    }
    makeLogID(id) {
        if (!id)
            return cfg.bot?.log_align || 'JiuLi';
        if (!cfg.bot?.log_align)
            return id;
        if (typeof id !== 'string')
            id = this.String(id);
        const length = (cfg.bot.log_align.length - id.length) / 2;
        if (length > 0)
            id = `${' '.repeat(Math.ceil(length))}${id}${' '.repeat(Math.floor(length))}`;
        else if (length < 0)
            id = `${id.slice(0, cfg.bot.log_align.length - 1)}.`;
        return id;
    }
    isLogLevelEnabled(level) {
        let target;
        switch (level) {
            case 'trace':
            case 'debug':
            case 'info':
                target = logger.logger.defaultLogger;
                break;
            case 'command':
            case 'warn':
            case 'mark':
                target = logger.logger.commandLogger;
                break;
            case 'error':
            case 'fatal':
                target = logger.logger.errorLogger;
                break;
        }
        return target?.isLevelEnabled?.(level) ?? true;
    }
    makeLog(level, msg, id, force) {
        if (!this.isLogLevelEnabled(level))
            return;
        const list = [];
        for (const i of Array.isArray(msg) ? msg : [msg])
            list.push(this.Loging(i));
        writeLog(level, id === false ? false : id, list, !!force);
    }
    makeError(msg, ...obj) {
        return Object.assign(Error(msg), ...obj);
    }
    /**
     * 堆栈里第一处「业务代码」位置：优先 plugins/ 下的帧，找不到就退回第一处非内核帧
     * （node: 内部 / node_modules / lib/core 都不算），用于把报错落到具体文件行
     */
    errorFrame(error, keyword = 'plugins/') {
        const stack = String(error?.stack || '');
        const root = `${process.cwd().replace(/\\/g, '/')}/`;
        const frames = [];
        for (const line of stack.split('\n')) {
            /**
             * 模块 URL 上可能带查询串（插件热重载会给 plugins/ 下的模块加 `?jiuli_reload=N`），
             * 所以 `.js` 与 `:行:列` 之间要允许一段 `?xxx`；不给这个口子整条帧都匹配不上，
             * 报错里就只剩原因、没有位置了。
             */
            const m = line.match(/\(?((?:file:\/\/)?[^()\s]+?\.(?:js|mjs|cjs|ts))(?:\?[^()\s]*)?:(\d+):(\d+)\)?/);
            if (!m)
                continue;
            /** Node 的堆栈会把中文/空格路径 percent-encode，先还原再展示 */
            let file = m[1].replace(/^file:\/\//, '');
            try {
                file = decodeURIComponent(file);
            }
            catch {
                /* 非法转义序列：保持原样 */
            }
            frames.push(`${file.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1')}:${m[2]}:${m[3]}`);
        }
        const pick = frames.find(f => f.includes(keyword)) ||
            frames.find(f => !/^node:|node_modules\/|\/lib\/core\//.test(f));
        return pick ? pick.replace(root, '') : '';
    }
    /** 统一的插件报错格式：一行原因 + 插件内出错位置 + 可选提示（完整堆栈由调用方按 debug 输出） */
    describeError(error, title, hint = '') {
        let text = `${title} · ${logger.red(String(error?.message || error))}`;
        const frame = this.errorFrame(error);
        if (frame)
            text += `\n        ${logger.gray(frame)}`;
        if (hint)
            text += `\n        ${logger.gray(hint)}`;
        return text;
    }
    async fsStat(file, opts) {
        try {
            return await fs.stat(file, opts);
        }
        catch (err) {
            this.makeLog('trace', ['获取', file, '状态错误', err]);
            return false;
        }
    }
    async mkdir(dir, opts) {
        try {
            await fs.mkdir(dir, { recursive: true, ...opts });
            return true;
        }
        catch (err) {
            this.makeLog('error', ['创建', dir, '错误', err]);
            return false;
        }
    }
    async rm(file, opts) {
        try {
            await fs.rm(file, { force: true, recursive: true, ...opts });
            return true;
        }
        catch (err) {
            this.makeLog('error', ['删除', file, '错误', err]);
            return false;
        }
    }
    async glob(pattern, opts = {}) {
        if (!opts.force && (await this.fsStat(pattern)))
            return [pattern];
        if (!fs.glob)
            return [];
        const array = [];
        try {
            for await (const i of fs.glob(pattern, opts))
                array.push(i);
        }
        catch (err) {
            this.makeLog('error', ['匹配', pattern, '错误', err]);
        }
        return array;
    }
    async download(url, file, opts) {
        let buffer;
        let target = file;
        if (!target || (await this.fsStat(target))?.isDirectory?.()) {
            const type = await this.fileType({ file: url }, opts);
            target = target ? path.join(target, type.name) : type.name;
            buffer = type.buffer;
        }
        else {
            await this.mkdir(path.dirname(target));
            buffer = await this.Buffer(url, opts);
        }
        await fs.writeFile(target, buffer);
        return { url, file: target, buffer };
    }
    /** 带磁盘持久化的 Map（插件数据存储） */
    makeMap(parent_map, parent_key, map) {
        const save = async () => {
            try {
                await parent_map.db.put(parent_key, { map_array: Array.from(map) });
            }
            catch (err) {
                this.makeLog('error', ['写入', parent_map.db.location, parent_key, '错误', map, err]);
            }
        };
        const set = map.set.bind(map);
        Object.defineProperty(map, 'set', {
            value: async (key, value) => {
                if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
                    set(key, value);
                    await save();
                }
                return map;
            },
        });
        const del = map.delete.bind(map);
        Object.defineProperty(map, 'delete', {
            value: async (key) => {
                if (!del(key))
                    return false;
                await save();
                return true;
            },
        });
        return map;
    }
    async setMap(map, set, key, value) {
        try {
            if (value instanceof Map) {
                set(key, this.makeMap(map, key, value));
                await map.db.put(key, { map_array: Array.from(value) });
            }
            else if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
                set(key, value);
                await map.db.put(key, value);
            }
        }
        catch (err) {
            this.makeLog('error', ['写入', map.db.location, key, '错误', value, err]);
        }
        return map;
    }
    async delMap(map, del, key) {
        if (!del(key))
            return false;
        try {
            await map.db.del(key);
        }
        catch (err) {
            this.makeLog('error', ['删除', map.db.location, key, '错误', err]);
        }
        return true;
    }
    async importMap(dir, map) {
        for (const i of await fs.readdir(dir)) {
            const file = path.join(dir, i);
            try {
                await map.set(i, (await this.fsStat(file))?.isDirectory?.()
                    ? await this.importMap(file, new Map())
                    : JSON.parse(await fs.readFile(file, 'utf8')));
            }
            catch (err) {
                this.makeLog('error', ['读取', file, '错误', err]);
            }
            await this.rm(file);
        }
        await this.rm(dir);
        return map;
    }
    async getMap(dir) {
        const map = new Map();
        const db = new (await import('level')).Level(`${dir}-leveldb`, { valueEncoding: 'json' });
        try {
            await db.open();
            for await (let [key, value] of db.iterator()) {
                if (typeof value === 'object' && value.map_array)
                    value = this.makeMap(map, key, new Map(value.map_array));
                map.set(key, value);
            }
        }
        catch (err) {
            this.makeLog('error', ['打开', dir, '数据库错误', err]);
            return map;
        }
        Object.defineProperty(map, 'db', { value: db });
        const set = map.set.bind(map);
        Object.defineProperty(map, 'set', { value: (key, value) => this.setMap(map, set, key, value) });
        const del = map.delete.bind(map);
        Object.defineProperty(map, 'delete', { value: (key) => this.delMap(map, del, key) });
        if (await this.fsStat(dir))
            await this.importMap(dir, map);
        return map;
    }
    StringOrNull(data) {
        if (typeof data === 'object' && typeof data.toString !== 'function')
            return '[object null]';
        return String(data);
    }
    StringOrBuffer(data, base64) {
        const string = String(data);
        return string.includes('\ufffd') || string.includes('\u0000')
            ? base64
                ? `base64://${Buffer.from(data).toString('base64')}`
                : data
            : string;
    }
    getCircularReplacer() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this_ = this;
        const ancestors = [];
        return function (_key, value) {
            switch (typeof value) {
                case 'function':
                case 'bigint':
                    return String(value);
                case 'object':
                    if (value === null)
                        return null;
                    if (value instanceof Map || value instanceof Set)
                        return Array.from(value);
                    if (value instanceof Error)
                        return value.stack;
                    if (value.type === 'Buffer' && Array.isArray(value.data))
                        try {
                            return _this_.StringOrBuffer(Buffer.from(value), true);
                        }
                        catch { }
                    break;
                default:
                    return value;
            }
            while (ancestors.length > 0 && ancestors.at(-1) !== this)
                ancestors.pop();
            if (ancestors.includes(value))
                return `[Circular ${_this_.StringOrNull(value)}]`;
            ancestors.push(value);
            return value;
        };
    }
    String(data, opts) {
        switch (typeof data) {
            case 'string':
                return data;
            case 'function':
                return String(data);
            case 'object':
                if (data instanceof Error)
                    return data.stack;
                if (Buffer.isBuffer(data))
                    return this.StringOrBuffer(data, true);
                if (data instanceof URL)
                    return String(data);
        }
        try {
            return JSON.stringify(data, this.getCircularReplacer(), opts) || this.StringOrNull(data);
        }
        catch {
            return this.StringOrNull(data);
        }
    }
    Loging(data, opts = cfg.bot?.log_object) {
        if (typeof data === 'string') {
            /* 保持原样 */
        }
        else if (data instanceof Error) {
            /** 错误对象不截断，保证调用栈完整 */
            data = nodeUtil.inspect(data, {
                depth: 10,
                colors: true,
                showHidden: true,
                breakLength: 120,
                maxArrayLength: 100,
                maxStringLength: Infinity,
            });
        }
        else if (!opts)
            data = this.StringOrNull(data);
        else
            data = nodeUtil.inspect(data, {
                depth: 10,
                colors: true,
                showHidden: true,
                showProxy: true,
                getters: true,
                breakLength: 100,
                maxArrayLength: 100,
                maxStringLength: 1000,
                ...opts,
            });
        const length = opts?.length || cfg.bot?.log_length || 10000;
        if (data.length > length)
            data = `${data.slice(0, length)}${logger.gray(`... ${data.length - length} more characters`)}`;
        return data;
    }
    /** 统一取 Buffer / base64:// / http(s) / file:// / 本地路径 */
    async Buffer(data, opts = {}) {
        if (!Buffer.isBuffer(data)) {
            data = this.String(data);
            if (data.startsWith('base64://')) {
                data = Buffer.from(data.replace('base64://', ''), 'base64');
            }
            else if (data.match(/^https?:\/\//)) {
                if (opts.http)
                    return data;
                data = Buffer.from(await (await fetch(data, opts)).arrayBuffer());
            }
            else {
                const file = data.replace(/^file:\/\//, '');
                if (await this.fsStat(file)) {
                    if (opts.file)
                        return `file://${path.resolve(file)}`;
                    const buffer = await fs.readFile(file);
                    if (typeof opts.size === 'number' && buffer.length > opts.size)
                        return `file://${path.resolve(file)}`;
                    return buffer;
                }
            }
        }
        if (typeof opts.size === 'number' && data.length > opts.size) {
            const file = path.join('temp', ulid());
            await this.mkdir('temp');
            await fs.writeFile(file, data);
            setTimeout(this.rm.bind(this, file, {}), 60000);
            data = `file://${path.resolve(file)}`;
        }
        return data;
    }
    async fileType(data, opts = {}) {
        const file = { name: data.name };
        try {
            if (Buffer.isBuffer(data.file)) {
                file.url = data.name || 'Buffer';
                file.buffer = data.file;
            }
            else {
                file.url = this.String(data.file).replace(/^base64:\/\/.*/, 'base64://...');
                file.buffer = await this.Buffer(data.file, { ...opts, size: undefined });
            }
            if (Buffer.isBuffer(file.buffer)) {
                file.type = (await fileTypeFromBuffer(file.buffer)) || {};
                file.md5 = createHash('md5').update(file.buffer).digest('hex');
                file.name ??= `${Date.now().toString(36)}.${file.md5.slice(0, 8)}.${file.type.ext}`;
                if (typeof opts.size === 'number' && file.buffer.length > opts.size)
                    file.buffer = await this.Buffer(data.file, opts);
            }
        }
        catch (err) {
            this.makeLog('error', ['文件类型检测错误', file, err]);
        }
        file.name ??= `${Date.now().toString(36)}-${path.basename(file.url)}`;
        return file;
    }
    async exec(cmd, opts = {}) {
        const { promise, resolve } = Promise.withResolvers();
        const raw = this.String(cmd);
        /** 命令可能很长（如 base64 编码的脚本），日志里截断显示 */
        const name = logger.cyan(raw.length > 160 ? `${raw.slice(0, 160)}…（共 ${raw.length} 字）` : raw);
        this.makeLog(opts.quiet ? 'debug' : 'mark', name, 'Command');
        opts.encoding ??= 'buffer';
        const start_time = Date.now();
        const callback = (error, stdout, stderr) => {
            const raw = { stdout, stderr };
            stdout = String(stdout).trim();
            stderr = String(stderr).trim();
            resolve({ error, stdout, stderr, raw });
            this.makeLog(opts.quiet ? 'debug' : 'mark', `${name} ${logger.green(`[完成${this.getTimeDiff(start_time)}]`)} ${stdout ? `\n${stdout}` : ''}${stderr ? logger.red(`\n${stderr}`) : ''}`, 'Command');
            if (error)
                this.makeLog(opts.quiet ? 'debug' : 'error', error, 'Command');
        };
        if (Array.isArray(cmd))
            execFile(cmd.shift(), cmd, opts, callback);
        else
            exec(cmd, opts, callback);
        return promise;
    }
    async cmdPath(cmd, opts = {}) {
        const ret = await this.exec(`${process.platform === 'win32' ? 'where' : 'command -v'} "${cmd}"`, {
            quiet: true,
            ...opts,
        });
        return ret.error ? false : ret.stdout;
    }
    cmdStart(cmd, args = [], opts = {}) {
        if (process.platform === 'win32') {
            args = ['/c', 'start', '', cmd, ...args];
            cmd = 'cmd';
        }
        this.makeLog(opts.quiet ? 'debug' : 'mark', [logger.cyan(cmd), logger.green(args.join(' '))], 'CMDStart');
        return spawn(cmd, args, { stdio: 'inherit', detached: true, ...opts });
    }
    /** 在同一终端内启动进程（重启用，不开新窗口） */
    cmdInherit(cmd, args = [], opts = {}) {
        this.makeLog('debug', [logger.cyan(cmd), logger.green(args.join(' '))], 'CMDInherit');
        return spawn(cmd, args, { stdio: 'inherit', detached: false, ...opts });
    }
    getTimeDiff(time1 = globalThis.Bot?.stat?.start_time * 1000, time2 = Date.now()) {
        let time = time2 - (time1 || Date.now());
        const ms = time % 1000;
        time = Math.floor(time / 1000);
        const sec = time % 60;
        time = Math.floor(time / 60);
        const min = time % 60;
        time = Math.floor(time / 60);
        const hour = time % 24;
        time = Math.floor(time / 24);
        let ret = '';
        if (time)
            ret += `${time}天`;
        if (hour)
            ret += `${hour}时`;
        if (min)
            ret += `${min}分`;
        if (sec)
            ret += `${sec}秒`;
        if (ms)
            ret += ms;
        return ret || '0秒';
    }
    promiseEvent(event, resolve, reject, timeout) {
        const listener = Promise.withResolvers();
        event.once(resolve, listener.resolve);
        if (reject)
            event.once(reject, listener.reject);
        if (timeout)
            listener.timeout = setTimeout(() => listener.reject(Object.assign(Error('等待事件超时'), { event, resolve, reject, timeout })), timeout);
        return listener.promise.finally(() => {
            event.off(resolve, listener.resolve);
            if (reject)
                event.off(reject, listener.reject);
            if (timeout)
                clearTimeout(listener.timeout);
        });
    }
    sleep(time, promise) {
        if (promise)
            return Promise.race([promise, this.sleep(time)]);
        return timers.setTimeout(time ?? 0, this.sleepTimeout);
    }
    debounce(func, time = 5000) {
        const debounceTime = this.debounceTime;
        let promise = false;
        function ret(...args) {
            if (promise) {
                if (promise.start)
                    return (async () => {
                        try {
                            await promise.promise;
                        }
                        finally {
                            return ret.apply(Object.assign({ [debounceTime]: time }, this), args);
                        }
                    })();
                else
                    clearTimeout(promise.timeout);
            }
            else {
                promise = Promise.withResolvers();
            }
            promise.timeout = setTimeout(async () => {
                try {
                    promise.start = true;
                    promise.resolve(await func.apply(this, args));
                }
                catch (err) {
                    promise.reject(err);
                }
                finally {
                    promise = false;
                }
            }, this?.[debounceTime] ?? 0);
            return promise.promise;
        }
        return ret;
    }
}
export default new Util();
