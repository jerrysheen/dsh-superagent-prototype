/** Input adapter only; ticket lists and actions remain in the original panel. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from './controls.tsx'

export interface WorkDraft { workspace: string; workId: string; instruction: string; permission: 'read-only' | 'workspace-write'; executor?: 'codex' | 'dsh'; codexThreadId?: string }
export function LocalWorkInput({ enabled, paused, draft }: { enabled: boolean; paused: boolean; draft?: WorkDraft }) {
  const [workspace, setWorkspace] = useState(''), [workId, setWorkId] = useState('')
  const [instruction, setInstruction] = useState(''), [write, setWrite] = useState(false)
  const [executor, setExecutor] = useState<'codex' | 'dsh'>('codex'), [codexThreadId, setCodexThreadId] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const pending = useRef<{ body: string; eventId: string }>()
  useEffect(() => {
    if (!draft) return
    setWorkspace(draft.workspace); setWorkId(draft.workId); setInstruction(draft.instruction)
    setWrite(draft.permission === 'workspace-write'); pending.current = undefined
    setExecutor(draft.executor ?? 'codex'); setCodexThreadId(draft.codexThreadId ?? '')
  }, [draft])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!enabled || busy) return
    const body = { workspace, workId, instruction, executor, ...(executor === 'codex' && codexThreadId ? { codexThreadId } : {}), permission: write ? 'workspace-write' : 'read-only',
      ...(write ? { writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' } : {}) }
    const encoded = JSON.stringify(body)
    if (pending.current?.body !== encoded) pending.current = { body: encoded, eventId: crypto.randomUUID() }
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/session-hub/api/work', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
        body: JSON.stringify({ ...body, eventId: pending.current!.eventId }) })
      const result = await response.json()
      if (!response.ok) throw new Error(String(result.error ?? '提交失败'))
      pending.current = undefined
      setInstruction('')
      setMessage('已交给原版 Engine。请在任务 / 判断页面查看处理状态。')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="dt-card dt-local-work" aria-label="本地工作输入">
    <h2 className="dt-block-title">本地工作 · 原版 Engine</h2>
    <p className="dt-hint">同一工作使用相同工作标识；独立任务使用新的标识。输入由原版策略判断，再交给 DSH Worker。</p>
    {!enabled && <p className="dt-banner" role="status">本地执行尚未启用。需显式配置 sessionExecution、来源工作目录和允许的发送者。</p>}
    {paused && <p className="dt-hint" role="status">当前已暂停，原版 Engine 不会开始执行。</p>}
    <form className="dt-form" onSubmit={submit}>
      <fieldset className="dt-fieldset" disabled={!enabled || busy}>
        <div className="dt-form-row">
          <label className="dt-field">执行器<select value={executor} onChange={event => { setExecutor(event.target.value as 'codex' | 'dsh'); setCodexThreadId('') }}><option value="codex">Codex 原生 session</option><option value="dsh">DSH Worker</option></select></label>
          <label className="dt-field">工作目录<Input required value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="已登记的 Windows 绝对路径" /></label>
          <label className="dt-field">工作标识<Input required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,79}" value={workId} onChange={e => setWorkId(e.target.value)} placeholder="例如 gc-profiler" /></label>
        </div>
        {executor === 'codex' && <label className="dt-field">原生 session ID（留空则新建）<Input value={codexThreadId} onChange={event => setCodexThreadId(event.target.value)} placeholder="已定位的 Codex session UUID" /></label>}
        <label className="dt-field">任务指令<textarea className="dt-textarea" required maxLength={8000} value={instruction} onChange={e => setInstruction(e.target.value)} rows={3} /></label>
        <label className="dt-checkbox-row"><input type="checkbox" checked={write} onChange={e => setWrite(e.target.checked)} />明确授权此工作修改工作区（默认只读；同一工作权限固定）</label>
        <Button variant="primary" type="submit">{busy ? '正在提交…' : '交给原版 Engine'}</Button>
      </fieldset>
    </form>
    {message && <p className="dt-banner" role="status">{message}</p>}
  </section>
}
