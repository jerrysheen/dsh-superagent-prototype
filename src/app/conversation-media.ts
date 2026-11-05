/** Selected-message image capabilities. No arbitrary filesystem URL or directory browsing. */
import { randomUUID } from 'node:crypto'
import { open, realpath, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'

const inside = (root: string, path: string) => { const p = win32.relative(root, path); return !!p && !p.startsWith('..\\') && p !== '..' && !win32.isAbsolute(p) }
const privatePart = /^(?:\.local|\.git|\.codex|\.ssh|\.aws|\.azure|\.env(?:\..*)?|node_modules|.*(?:credential|secret|password).*|sessions?)$/i
export function rasterType(bytes: Buffer) {
  return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(bytes.subarray(0,6).toString()) ? 'image/gif'
        : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : undefined
}
/** Keeps local image paths server-side and only serves raster bytes referenced by a selected message. */
export class ConversationMedia {
  private entries = new Map<string, { threadId: string; path: string; workspace: string; uploaded?: boolean }>()
  async upload(threadId: string, dataUrl: string, workspace: string) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+={0,2})$/i.exec(dataUrl)
    if (!match || dataUrl.length > 14 * 1024 * 1024) throw Error('请选择 10 MB 以内的 PNG、JPEG、GIF 或 WebP 图片。')
    const bytes = Buffer.from(match[2]!, 'base64'), type = rasterType(bytes)
    if (bytes.length > 10 * 1024 * 1024 || type !== match[1]!.toLowerCase()) throw Error('图片格式或大小不正确。')
    const id = randomUUID(), path = win32.join(tmpdir(), 'codex-clipboard-' + id + '.' + type.slice(6).replace('jpeg', 'jpg'))
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    this.entries.set(id, { threadId, path, workspace, uploaded: true })
    return { id, src: '/session-hub/api/codex/media?threadId=' + encodeURIComponent(threadId) + '&id=' + id }
  }
  uploads(threadId: string, ids: string[]) {
    return ids.map(id => { const entry = this.entries.get(id); if (!entry?.uploaded || entry.threadId !== threadId) throw Error('图片不属于当前会话或已过期，请重新添加。'); return entry.path })
  }
  async releaseUploads(threadId: string, ids: string[]) {
    const paths = this.uploads(threadId, ids)
    for (const [index, path] of paths.entries()) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      this.entries.delete(ids[index]!)
    }
  }
  register(threadId: string, source: string, workspace: string): string | undefined {
    if (/^https?:\/\//i.test(source)) return /^https:\/\//i.test(source) ? source : undefined
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(source) && source.length < 14 * 1024 * 1024) return source
    let path = source
    if (path.startsWith('file:')) { try { path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-z]:)/i, '$1') } catch { return } }
    if (!/^[a-z]:[\\/]/i.test(path)) path = win32.resolve(workspace, path)
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path) || path.includes(':', 2) || /[\u0000-\u001f]/.test(path)) return
    const token = randomUUID(); this.entries.set(token, { threadId, path, workspace })
    if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!)
    return '/session-hub/api/codex/media?threadId=' + encodeURIComponent(threadId) + '&id=' + token
  }
  async read(threadId: string, id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.threadId !== threadId) throw Error('图片不属于当前会话，请刷新会话内容。')
    const path = await realpath(entry.path), root = await realpath(entry.workspace), temporary = await realpath(tmpdir())
    const clipboard = win32.dirname(path).toLowerCase() === temporary.toLowerCase() && /^codex-clipboard-[a-f\d-]+\.(png|jpe?g|gif|webp)$/i.test(win32.basename(path))
    const projectImage = inside(root, path) && !path.split(/[\\/]/).some(part => privatePart.test(part))
    if (!clipboard && !projectImage) throw Error('这张图片不在可展示的消息附件或工程范围内。')
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw Error('图片超过展示大小限制。')
      const bytes = Buffer.alloc(stat.size); await file.read(bytes, 0, bytes.length, 0)
      const type = rasterType(bytes)
      if (!type) throw Error('文件不是支持的图片格式。')
      return { bytes, type }
    } finally { await file.close() }
  }
}
