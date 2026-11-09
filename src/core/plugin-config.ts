/** 插件配置文件生成（兼容云崽 makeConfig） */
import fs from 'node:fs/promises'
import YAML from 'yaml'
import chokidar from 'chokidar'
import cfg from './config/index.js'
import util from './util.js'
import { logger } from './log.js'

const map = new Map<string, any>()

/** 深度合并；数组按下标合并，与 lodash.merge 行为一致 */
function merge(target: any, source: any): any {
  if (source === undefined) return target
  if (Array.isArray(target) && Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) target[i] = merge(target[i], source[i])
    return target
  }
  if (target && typeof target === 'object' && source && typeof source === 'object' && !Array.isArray(source)) {
    for (const key of Object.keys(source)) target[key] = merge(target[key], source[key])
    return target
  }
  return source
}

/** 监听配置文件变化，需绑定 { config, configFile } 作为 this */
export async function watcher(this: any) {
  try {
    util.makeLog('debug', ['配置文件', this.configFile, '发生变化'], 'Config')
    const configData = YAML.parse(await fs.readFile(this.configFile, 'utf8'))
    merge(this.config, configData)
  } catch (err) {
    util.makeLog('error', ['配置文件', this.configFile, '读取失败', err], 'Config')
  }
}

export default async function makeConfig(name: string, config: any = {}, keep: any = {}, opts: any = {}) {
  if (map.has(name)) return map.get(name)

  const configFile = `config/${name}.yaml`
  const configSave = util.debounce(
    typeof opts.replacer === 'function'
      ? async () => fs.writeFile(configFile, await opts.replacer(YAML.stringify(config)), 'utf8')
      : () => fs.writeFile(configFile, YAML.stringify(config), 'utf8'),
  )

  const ret: any = { config, configSave, configFile }
  map.set(name, ret)

  let configData
  try {
    configData = YAML.parse(await fs.readFile(configFile, 'utf8'))
    merge(config, configData)
  } catch (err) {
    util.makeLog('debug', ['配置文件', configFile, '读取失败', err], 'Config')
  }
  merge(config, keep)

  if (YAML.stringify(config) != YAML.stringify(configData)) await configSave()

  if (typeof opts.watch === 'boolean' ? opts.watch : cfg.bot.file_watch)
    ret.watcher = chokidar.watch(configFile).on('change', util.debounce(watcher.bind(ret), 5000))

  return ret
}
