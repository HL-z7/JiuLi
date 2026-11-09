/** 兼容包：node-fetch，转发到 Node 内置 fetch */
export const { Blob, File, FormData, Headers, Request, Response } = globalThis
export default globalThis.fetch
