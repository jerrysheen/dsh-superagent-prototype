/** Read a clicked project document only. No directory enumeration or HTML execution. */
import { open, realpath } from 'node:fs/promises'
import { win32 } from 'node:path'
import { z } from 'zod'

export const PreviewQuery = z.object({ threadId: z.string().uuid(), path: z.string().min(1).max(1500) }).strict()
const extensions = new Set(['.md', '.mdx', '.txt', '.rst', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.htm', '.svg', '.json', '.yaml', '.yml', '.toml', '.xml', '.py', '.ps1', '.sh', '.sql', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h', '.vue', '.svelte', '.log'])
const privatePart = /^(?:\.local|\.git|\.codex|\.ssh|\.aws|\.azure|\.config|node_modules|\.env(?:\..*)?|.*(?:credential|secret|token|password).*|auth\.json|sessions?|.*\.(?:sqlite\d*|db|pem|key|pfx))$/i
const within = (root: string, path: string) => {
  const relative = win32.relative(root, path)
  return relative !== '' && !relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative)
}
const publicPath = (path: string) => !path.split(/[\\/]/).some(part => privatePart.test(part))

export async function readWorkspacePreview(cwd: string, requested: string) {
  if (!/^[a-z]:[\\/]/i.test(cwd) || !publicPath(requested) || /[\u0000-\u001f]/.test(requested)) throw new Error('此路径不支持预览。')
  const root = win32.resolve(cwd), target = win32.resolve(root, requested)
  if (!within(root, target) || !publicPath(target) || !extensions.has(win32.extname(target).toLowerCase()) || target.includes(':', 2)) throw new Error('仅支持预览当前会话项目内的普通文本文件。')
  // Resolve junctions and symbolic links before opening; a link must not escape the project.
  let canonicalRoot: string, canonicalTarget: string
  try { [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]) }
  catch { throw new Error('文件不存在或不可读取。') }
  if (!within(canonicalRoot, canonicalTarget) || !publicPath(canonicalTarget) || !extensions.has(win32.extname(canonicalTarget).toLowerCase())) throw new Error('文件指向项目之外或受保护的路径。')
  const handle = await open(canonicalTarget, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('仅支持 512 KB 以内的普通文本文件。')
    const buffer = Buffer.alloc(512 * 1024 + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 512 * 1024 || buffer.subarray(0, bytesRead).includes(0)) throw new Error('文件过大或不是普通文本。')
    return { path: target, name: win32.basename(target), text: buffer.subarray(0, bytesRead).toString('utf8'), markdown: /\.mdx?$/i.test(target) }
  } finally { await handle.close() }
}
