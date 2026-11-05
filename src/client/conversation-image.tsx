import { useEffect, useState } from 'react'
/** Fetch scoped local attachments through the authenticated same-origin management API. */
export function ConversationImage({ src, alt = '消息中的图片' }: { src: string; alt?: string }) {
  const local = src.startsWith('/session-hub/api/codex/media?')
  const [url, setUrl] = useState(local ? '' : src), [error, setError] = useState(false)
  useEffect(() => {
    setError(false)
    if (!local) { setUrl(src); return }
    setUrl(''); const controller = new AbortController(); let objectUrl = ''
    void fetch(src, { headers: { 'x-orchestrator-request': '1' }, signal: controller.signal }).then(async response => {
      if (!response.ok || !/^image\/(png|jpeg|gif|webp)/.test(response.headers.get('content-type') ?? '')) throw Error('Image unavailable')
      const blob = await response.blob()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [src, local])
  if (error) return <span className="cw-image-unavailable">图片不可用，原附件可能已被清理。</span>
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="cw-image-link"><img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setError(true)} /></a>
    : <span className="cw-image-unavailable">图片加载中…</span>
}
