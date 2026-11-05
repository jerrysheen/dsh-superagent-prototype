import { useEffect, useRef, useState } from 'react'
import { Button } from './controls.tsx'
import { ConversationMarkdown } from './conversation-markdown.tsx'
import type { PreviewTarget } from './workspace-link.ts'
import { SourceCode } from './syntax-highlight.tsx'

type Document = { path: string; name: string; text: string; markdown: boolean }
export function WorkspacePreview({ target, threadId, onClose, onLink }: {
  target: PreviewTarget; threadId: string; onClose: () => void; onLink: (href: string) => void
}) {
  const [result, setResult] = useState<Document | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [source, setSource] = useState(target.kind === 'file' && !!target.line)
  const body = useRef<HTMLDivElement>(null)
  const identity = target.kind === 'file' ? target.path : target.url
  const line = target.kind === 'file' ? target.line : undefined
  useEffect(() => { if (line) setSource(true) }, [identity, line])
  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setError(''); setSource(target.kind === 'file' && !!target.line)
    if (target.kind !== 'file') return
    setLoading(true)
    void (async () => {
      try {
        const response = await fetch('/session-hub/api/codex/preview?' + new URLSearchParams({ threadId, path: target.path }), {
          headers: { 'x-orchestrator-request': '1' }, signal: controller.signal,
        })
        const data = await response.json() as Document & { error?: string }
        if (!response.ok) throw new Error(data.error ?? '无法预览此文件。')
        if (!controller.signal.aborted) setResult(data)
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '文件预览失败。') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [identity, threadId])
  useEffect(() => {
    if (!result || target.kind !== 'file') return
    if (!source && target.anchor) {
      const heading = [...body.current?.querySelectorAll<HTMLElement>('[data-heading]') ?? []].find(node => node.dataset.heading === target.anchor)
      heading?.scrollIntoView({ block: 'start' })
      return
    }
    const line = Math.min(target.line ?? 1, result.text.split('\n').length)
    body.current?.querySelector<HTMLElement>('[data-line="' + line + '"]')?.scrollIntoView({ block: 'center' })
  }, [result, source, target])
  return <aside className="cw-preview" aria-label="链接预览">
    <header className="cw-preview-head"><strong title={identity}>{result?.name ?? (target.kind === 'file' ? identity.split(/[\\/]/).pop() : new URL(identity).hostname) ?? identity}</strong>
      {target.kind === 'file' && target.line && <span>第 {target.line} 行</span>}
      <Button size="sm" onClick={onClose} aria-label="关闭预览">关闭</Button></header>
    <div className="cw-preview-tools">
      <span title={result?.path ?? identity}>{result?.path ?? identity}</span>
      {result?.markdown && <Button size="sm" onClick={() => setSource(value => !value)}>{source ? '渲染预览' : '查看源码'}</Button>}
      {target.kind === 'web' && <a href={target.url} target="_blank" rel="noopener noreferrer">外部打开 ↗</a>}
    </div>
    {target.kind === 'web' ? <><p className="cw-preview-hint">网页禁止嵌入或显示空白时，请使用“外部打开”。</p>
      <iframe key={target.url} title="网页预览" src={target.url} sandbox="" referrerPolicy="no-referrer" /></> :
      <div className="cw-preview-body" ref={body}>
        {loading && <p role="status">读取文件…</p>}{error && <p role="alert">{error}</p>}
        {result && (result.markdown && !source ? <ConversationMarkdown text={result.text} onLink={onLink} /> :
          <SourceCode text={result.text} path={result.path} selectedLine={target.line} />)}
      </div>}
  </aside>
}
