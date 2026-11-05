/** Read-only target discovery; execution is submitted separately through the original input form. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { TargetResolution } from '../app/target-resolver.ts'
import type { TargetCard } from '../app/context-targets.ts'
import { Button, Input } from './controls.tsx'
import { LocalWorkInput, type WorkDraft } from './local-work-input.tsx'
const headers = { 'content-type': 'application/json', 'x-orchestrator-request': '1' }
async function post(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch('/session-hub/api/context/' + path, { method: 'POST', headers, body: JSON.stringify(body), signal })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? '暂时无法定位工作。')
  return value
}
export function TargetFinder({ currentSessionUid }: { currentSessionUid?: string }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [resolution, setResolution] = useState<TargetResolution>(), [draft, setDraft] = useState<WorkDraft>()
  const [execution, setExecution] = useState({ enabled: false, paused: true })
  const pending = useRef<AbortController>()
  const revision = useRef(0), resolvedQuery = useRef('')
  useEffect(() => () => { revision.current++; pending.current?.abort() }, [])
  function editQuery(value: string) {
    revision.current++; pending.current?.abort(); setQuery(value); setResolution(undefined); setDraft(undefined)
    setError(''); setBusy(false); resolvedQuery.current = ''
  }
  async function locate(cwd?: string) {
    const serial = ++revision.current, instruction = query
    pending.current?.abort(); const request = new AbortController(); pending.current = request
    setBusy(true); setError(''); setDraft(undefined); setResolution(undefined)
    try {
      const value = await post('resolve', { query: instruction, ...(cwd ? { cwd } : {}), ...(currentSessionUid ? { currentSessionUid } : {}) }, request.signal)
      if (!request.signal.aborted && serial === revision.current) { resolvedQuery.current = instruction; setResolution(value) }
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : '定位失败') }
    finally { if (pending.current === request) setBusy(false) }
  }
  async function choose(card: TargetCard) {
    const serial = revision.current
    setBusy(true); setError('')
    try {
      const value = await post('select', { uid: card.uid, fingerprint: card.fingerprint })
      if (serial !== revision.current) return
      setResolution(previous => previous && { ...previous, action: 'selected', intent: 'resume_existing', target: value.target, candidates: [] })
    } catch (failure) { if (serial === revision.current) setError(failure instanceof Error ? failure.message : '候选已变更，请重新查找。') }
    finally { if (serial === revision.current) setBusy(false) }
  }
  async function prepare() {
    if (!resolution?.target) return
    const serial = revision.current, instruction = resolvedQuery.current
    setBusy(true); setError('')
    try {
      const response = await fetch('/orchestrator/api/state', { headers })
      if (!response.ok) throw Error('无法确认当前执行状态。')
      const state = await response.json(), target = resolution.target
      if (serial !== revision.current) return
      setExecution({ enabled: state.sessionExecution === true, paused: state.paused })
      if (target.kind === 'new') setDraft({ workspace: target.project.workspace, workId: 'work-' + crypto.randomUUID(), instruction, permission: 'read-only', executor: 'codex' })
      else if (target.binding?.kind === 'engine-ticket') setDraft({ workspace: target.binding.workspace,
        workId: String(target.binding.workId), instruction, permission: target.binding.permission === 'workspace-write' ? 'workspace-write' : 'read-only',
        executor: target.binding.executor, ...('codexThreadId' in target.binding ? { codexThreadId: target.binding.codexThreadId } : {}) })
      else if (target.binding?.kind === 'native-session') setDraft({ workspace: target.binding.workspace,
        workId: 'codex-' + target.binding.threadId, instruction, permission: 'read-only', executor: 'codex', codexThreadId: target.binding.threadId })
    } catch (failure) { if (serial === revision.current) setError(failure instanceof Error ? failure.message : '无法准备工作。') }
    finally { if (serial === revision.current) setBusy(false) }
  }
  function search(event: FormEvent) { event.preventDefault(); if (query.trim()) void locate() }
  const target = resolution?.target
  return <section className="dt-card" aria-label="定位工程与工作">
    <h2 className="dt-block-title">找到要继续的工作，或新开一个</h2>
    <form className="dt-form" onSubmit={search}><label className="dt-field">描述你要做的事
      <Input value={query} onChange={event => editQuery(event.target.value)} placeholder="例如：那个 wasm 代码内存涨好几倍的问题继续" required maxLength={2000} />
    </label><Button type="submit" disabled={busy}>{busy ? '正在定位…' : '定位目标'}</Button></form>
    {error && <p role="alert">{error}</p>}{resolution && <p role="status">{resolution.reason}</p>}
    {target?.kind === 'session' && <div><strong>{target.card.title}</strong><p>{target.card.projectName} · {target.card.workspace}</p>
      {(target.card.kind === 'codex' || target.binding?.kind === 'engine-ticket' && target.binding.executor === 'codex') && <a href={'codex://threads/' + target.card.threadId}>在 Codex 打开此会话 ↗</a>}
      <Button disabled={busy} onClick={() => { void prepare() }}>继续这个工作</Button></div>}
    {target?.kind === 'new' && <div><strong>新工作 · {target.project.name}</strong><p>{target.project.workspace}</p>
      <Button disabled={busy} onClick={() => { void prepare() }}>准备新工作</Button></div>}
    {resolution?.action === 'needs_confirmation' && resolution.candidates.map(card => <div key={card.uid}>
      <Button disabled={busy} onClick={() => { void choose(card) }}>{card.title} · {card.projectName}</Button><p className="dt-hint">{card.summary || card.workspace}</p></div>)}
    {resolution?.action === 'needs_confirmation' && !resolution.candidates.length && resolution.projects.map(project =>
      <Button key={project.id} disabled={busy} onClick={() => { void locate(project.workspace) }}>{project.name} · {project.workspace}</Button>)}
    {draft && <LocalWorkInput enabled={execution.enabled} paused={execution.paused} draft={draft} />}
  </section>
}
