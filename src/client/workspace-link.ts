export type PreviewTarget = { kind: 'file'; path: string; line?: number; anchor?: string } | { kind: 'web'; url: string }

/** Only explicit file links are sent to the read-only preview API. */
export function fileLink(href: string): Extract<PreviewTarget, { kind: 'file' }> | null {
  let path: string
  try {
    path = decodeURIComponent(href)
    if (/^file:\/\//i.test(path)) {
      const url = new URL(href)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = decodeURIComponent(url.pathname + url.hash)
    }
  } catch { return null }
  path = path.replace(/^\/([a-z]:[\\/])/i, '$1')
  const location = /(?:#L?(\d+)(?:C\d+|[-:]L?\d+)?|:(\d+)(?::\d+)?)$/i.exec(path)
  const line = location ? Number(location[1] ?? location[2]) : undefined
  if (location) path = path.slice(0, location.index)
  const hash = path.indexOf('#')
  const anchor = hash >= 0 ? path.slice(hash + 1) : undefined
  if (hash >= 0) path = path.slice(0, hash)
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null
  if (!/\.[a-z\d_-]+$/i.test(path) || path.startsWith('//') || path.startsWith('\\\\') || /[\u0000-\u001f?#]/.test(path)) return null
  return { kind: 'file', path, ...(line && line > 0 ? { line } : {}), ...(anchor ? { anchor } : {}) }
}

export function previewTarget(href: string): PreviewTarget | null {
  const file = fileLink(href)
  if (file) return file
  try {
    const url = new URL(href)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    return { kind: 'web', url: url.href }
  } catch { return null }
}
