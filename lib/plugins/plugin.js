/** 兼容层：云崽插件基类，旧插件从本文件具名导入或直接使用全局 plugin */
import plugin from '../core/plugin.js'
globalThis.plugin ||= plugin
export default plugin
