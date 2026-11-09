/**
 * 兼容层：云崽的 lib/puppeteer/puppeteer.js
 *
 * 截图相关接口走框架的多后端调度（screenshot / screenshots / render / browserInit …），
 * 其余渲染器接口（getMac、createBrowser 等）转发给当前后端，
 * 免得插件报 `puppeteer.xxx is not a function`。
 */
import renderService from '../core/render/index.js'

export default new Proxy(renderService, {
  get(target, prop) {
    if (prop in target) return Reflect.get(target, prop)
    const backend = target.backend
    const value = backend?.[prop]
    return typeof value === 'function' ? value.bind(backend) : value
  },
})
