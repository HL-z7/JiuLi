/**
 * 云崽兼容别名：plugins/other/
 *
 * 云崽（TRSS-Yunzai）把内置插件放在 plugins/other/，JiuLi 并入了 plugins/system/，
 * 于是所有 import '../../other/update.js' 的云崽插件都会找不到模块。
 * 这里按原路径提供转发，插件不用改一个字。
 *
 * 注意：本目录是别名，不是插件源 —— 加载器会跳过它，避免同一个插件被重复加载。
 */
export { default } from '../system/update.js'
export * from '../system/update.js'
