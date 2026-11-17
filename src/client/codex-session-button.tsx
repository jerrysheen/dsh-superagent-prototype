/** Opens the exact native conversation inside DSH without submitting work or messages. */
import { useEffect, useRef, useState } from 'react'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { CodexThread } from './codex-workspace-store.ts'

export function CodexSessionButton({ threadId }: { threadId: string }) {
  const { openCodex, notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const current = useRef<AbortController>()
  useEffect(() => {
    setBusy(false)
    return () => { current.current?.abort(); current.current = undefined }
  }, [threadId])
  if (!openCodex) return null
  async function open() {
    if (current.current) return
    const request = new AbortController(); current.current = request
    setBusy(true)
    try {
      const response = await fetch('/session-hub/api/context/threads?' + new URLSearchParams({ query: threadId, limit: '5' }), {
        headers: { 'x-orchestrator-request': '1' }, signal: request.signal,
      })
      const value = await response.json() as { threads?: CodexThread[]; error?: string }
      if (!response.ok) throw Error(value.error ?? '会话目录暂时不可用，请稍后重试。')
      const thread = value.threads?.find(item => item.threadId === threadId && item.provider === 'codex'
        && typeof item.cwd === 'string' && typeof item.title === 'string' && typeof item.projectName === 'string'
        && typeof item.updatedAt === 'number')
      if (!thread) throw Error('该会话尚未出现在当前目录中，请稍后刷新；没有打开其他会话。')
      if (!request.signal.aborted) openCodex?.(thread)
    } catch (error) {
      if (!request.signal.aborted) notify(error instanceof Error ? error.message : '无法打开此会话。')
    } finally {
      if (current.current === request) { current.current = undefined; setBusy(false) }
    }
  }
  return <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void open() }}>
    {busy ? '正在打开…' : '在 DSH 中打开会话'}
  </Button>
}
