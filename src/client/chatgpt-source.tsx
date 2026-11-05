/** Cloud metadata source controls and sidebar, independent of local Codex workspaces and execution. */
import { useEffect, useRef, useState } from 'react'
import type { ChatgptSource, ChatgptRow } from '../app/chatgpt-source.ts'
import { usePoll } from './api.ts'
import { Button, Input, Icon } from './controls.tsx'
import { writeWorkerDrag } from './worker-references.ts'

type Status = ReturnType<ChatgptSource['view']>
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/session-hub/api/context/chatgpt-' + path, { method,
    headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'ChatGPT 来源接口不可用')
  return result as T
}

/** Change the local derivative's date boundary without touching the cloud or task authorization. */
export function ChatgptSourceSettings() {
  const { data, error, reload } = usePoll(() => api<Status>('source'), [])
  const [since, setSince] = useState(''), [enabled, setEnabled] = useState(true), [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  useEffect(() => { if (data && !dirty) { setSince(data.since); setEnabled(data.enabled) } }, [data?.since, data?.enabled, dirty])
  async function save() {
    setBusy(true); setFailure('')
    try { await api('source', 'PUT', { since, enabled }); setDirty(false); await reload() }
    catch (failure) { setFailure(failure instanceof Error ? failure.message : '保存失败') }
    finally { setBusy(false) }
  }
  return <section className="dt-form dt-block" aria-label="ChatGPT 云端来源">
    <h3 className="dt-block-title">ChatGPT · 云端会话</h3>
    <p className="dt-hint">仅同步标题、身份和项目元数据。按北京时间的最近更新时间筛选，不读取聊天内容。</p>
    {data && <><label className="dt-checkbox-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setDirty(true) }} />启用会话目录同步</label>
      <label className="dt-field">同步起始日期（含当天更新）<Input type="date" value={since} disabled={busy}
        onChange={event => { setSince(event.target.value); setDirty(true) }} /></label>
      <p className="dt-hint">已接入 {data.count} 条 · {data.syncing ? '同步中…' : data.lastSyncAt ? '最近同步：' + new Date(data.lastSyncAt).toLocaleString() : '尚未同步'}</p>
      {data.error && <p className="dt-error" role="status">{data.error}</p>}
      <div className="dt-actions"><Button onClick={() => { void save() }} disabled={busy || !dirty || !since}>保存来源范围</Button>
        <Button disabled={busy || data.syncing || !data.enabled || !data.connected} onClick={() => {
          setBusy(true); setFailure(''); void api('sync', 'POST').then(reload).catch(error => setFailure(String(error))).finally(() => setBusy(false))
        }}>立即同步</Button></div></>}
    {(error || failure) && <p className="dt-error" role="alert">{failure || error?.message}</p>}
  </section>
}

/** Distinct cloud section; opening is an explicit link and dragging only adds a reference. */
export function ChatgptSourceSidebar({ onNew }: { onNew?: () => void }) {
  const [offset, setOffset] = useState(0), [collapsed, setCollapsed] = useState(false), [rows, setRows] = useState<ChatgptRow[]>([])
  const scope = useRef('')
  const [syncError, setSyncError] = useState('')
  const { data, error, reload } = usePoll(() => api<{ threads: ChatgptRow[]; total: number; offset: number; nextOffset: number | null; since: string; enabled: boolean }>('threads?limit=30&offset=' + offset), [offset], 15000)
  useEffect(() => {
    if (data?.offset !== offset) return
    const nextScope = data.since + ':' + data.enabled
    if (scope.current && scope.current !== nextScope) {
      setRows([]); setOffset(0); scope.current = nextScope
      if (offset !== 0) return
    }
    scope.current = nextScope
    setRows(previous => offset === 0 ? [...new Map([...previous, ...data.threads].map(row => [row.id, row])).values()].sort((a,b) => b.updatedAt-a.updatedAt) : [...new Map([...previous, ...data.threads].map(row => [row.id, row])).values()])
  }, [data, offset])
  useEffect(() => {
    let active = true, running = false
    const check = async () => {
      if (document.visibilityState === 'hidden' || running) return
      running = true
      try {
        const status = await api<Status>('check', 'POST')
        if (active) setSyncError(status.error)
        if (!active) return
        const head = await api<{ threads: ChatgptRow[] }>('threads?limit=30&offset=0')
        if (active) {
          setRows(previous => [...new Map([...previous, ...head.threads].map(row => [row.id, row])).values()].sort((a,b) => b.updatedAt-a.updatedAt))
          await reload()
        }
      } catch { if (active) setSyncError('同步暂不可用，保留已有目录') }
      finally { running = false }
    }
    void check()
    const timer = setInterval(() => { void check() }, 30000)
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check) }
  }, [collapsed, offset])
  return <section aria-label="ChatGPT 云端会话" className="cw-cloud-source">
    <div className="cw-project-head"><button type="button" className="cw-project" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
      <span>{collapsed ? '›' : '⌄'}</span><span>ChatGPT · 云端</span><small>{data?.total ?? ''}</small></button>
    <button type="button" className="cw-project-action" title="新建云端提问" aria-label="新建云端提问" onClick={onNew}><Icon name="plus" size={16} /></button></div>
    {!collapsed && <div>{(error || syncError) && <p className="cw-hint" role="status">{syncError || 'ChatGPT 目录暂不可用'}</p>}
      {!error && data && !data.threads.length && <p className="cw-hint">当前来源范围内暂无会话，可在设置 → 来源调整日期。</p>}
      {rows.map(row => <div className="cw-session" key={row.id}>
        <a className="cw-session-main" href={'https://chatgpt.com/c/' + row.id} target="_blank" rel="noopener noreferrer"
          title={row.title + ' · 云端会话，可拖入主 Agent 引用'} draggable
          onDragStart={event => writeWorkerDrag(event.dataTransfer, 'chatgpt:' + row.id, row.title)}>
          <span className="cw-session-slot" aria-hidden="true" /><span className="cw-session-title">{row.title || '未命名会话'}</span></a>
        <small className="cw-cloud-date">{new Date(row.updatedAt * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</small>
      </div>)}
      {data?.nextOffset != null && <button type="button" className="cw-more" onClick={() => setOffset(data.nextOffset!)} disabled={data.offset !== offset}>显示更多 · 共 {data.total} 条</button>}
    </div>}
  </section>
}
