import Puppeteer from './lib/puppeteer.js'

/**
 * puppeteer 渲染后端
 * @param config renderers/puppeteer/config.yaml 的配置内容
 * @returns renderer 渲染器对象
 * @returns renderer.id 渲染器ID，对应 renderer.yaml 中选择的 id
 * @returns renderer.type 渲染类型，保留字段，暂时支持 image
 * @returns renderer.render 渲染入口
 */
export default function (config) {
  return new Puppeteer(config)
}
