/** Read-only historical context; never creates a task or resumes a native session. */
import { useState, type FormEvent } from 'react'
import type { SessionCard, SessionTask } from '../app/session-hub.ts'
import { Button, Input } from './controls.tsx'

export function LocalWorkHistory() {
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [matches, setMatches] = useState<{ uid: string; title: string; projectName: string }[]>([])
  const [archive, setArchive] = useState<{ sessions: SessionCard[]; tasks: SessionTask[] }>()
  async function read(path: string, body?: unknown) {
    const response = await fetch('/session-hub/api/' + path, { method: body ? 'POST' : 'GET',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) throw new Error(String(value.error ?? '读取失败'))
    return value
  }
  async function search(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { setMatches((await read('context/search', { query, limit: 12 })).matches) }
    catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  return <section className="dt-card dt-local-history" aria-label="历史上下文">
    <h2 className="dt-block-title">历史上下文</h2>
    <p className="dt-hint">按需查找历史会话线索。检索不会发送消息或执行任务。</p>
    <form className="dt-form" onSubmit={search}><label className="dt-field">历史主题<Input required maxLength={600} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <Button disabled={busy} type="submit">查找</Button></form>
    <ul className="dt-plain-list">{matches.map(item => <li key={item.uid}>{item.projectName} · {item.title}</li>)}</ul>
    <details className="dt-details" onToggle={event => {
      if (event.currentTarget.open && !archive) void read('snapshot').then(setArchive).catch(failure => setError(String(failure)))
    }}><summary>旧会话登记与任务记录（只读）</summary>
      {archive && <>
        <ul className="dt-plain-list">{archive.sessions.map(card => <li key={card.uid}>{card.projectName} · {card.title}</li>)}</ul>
        {archive.tasks.map(task => <details className="dt-details" key={task.id}><summary>{task.request.instruction} · {task.status}</summary>
          <p className="dt-hint">{task.reason}</p>{task.receipts.map(receipt => <p className="dt-hint" key={receipt.eventId}>{receipt.status} · {receipt.result}</p>)}
        </details>)}
      </>}
    </details>
    {error && <p className="dt-error" role="alert">{error}</p>}
  </section>
}
