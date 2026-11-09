/** 消息元素工厂 segment；lib/modules/oicq 指向本实现，旧插件从 'oicq' 包名导入 */
export interface SegmentFactory {
  [key: string]: (...args: any[]) => any
}

const segment: SegmentFactory = {
  custom(type: string, data: any) {
    return { type, ...data }
  },
  raw(data: any) {
    return { type: 'raw', data }
  },
  button(...data: any[]) {
    return { type: 'button', data }
  },
  markdown(data: any) {
    return { type: 'markdown', data }
  },
  image(file: any, name?: string) {
    return { type: 'image', file, name }
  },
  at(qq: any, name?: string) {
    return { type: 'at', qq, name }
  },
  record(file: any, name?: string) {
    return { type: 'record', file, name }
  },
  video(file: any, name?: string) {
    return { type: 'video', file, name }
  },
  face(id: any) {
    return { type: 'face', id }
  },
  file(file: any, name?: string) {
    return { type: 'file', file, name }
  },
  reply(id: any, text?: string, qq?: any, time?: any, seq?: any) {
    return { type: 'reply', id, text, qq, time, seq }
  },
}

/** 补齐 icqq 专有元素，仅在 ICQQ-Plugin 存在时生效 */
async function extendFromIcqq() {
  try {
    const spec = `file://${process.cwd()}/plugins/ICQQ-Plugin/node_modules/icqq/lib/message/elements.js`
    const mod: any = await import(spec)
    const { deprecate } = await import('node:util')
    for (const i in mod.segment)
      if (!segment[i]) segment[i] = deprecate(mod.segment[i], `segment.${i} 仅在 icqq 上可用`)
  } catch {
    /* ICQQ-Plugin 不存在时忽略 */
  }
}

let extended = false
/** 异步补齐 icqq 元素，启动时调用一次 */
export async function extendSegment() {
  if (extended) return segment
  extended = true
  await extendFromIcqq()
  return segment
}

/** 取全局 segment（兼容层注入的优先）或内核实现 */
export function getSegment(): SegmentFactory {
  return (globalThis as any).segment || segment
}

export default segment
