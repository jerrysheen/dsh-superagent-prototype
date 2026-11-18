/** Explicit cloud worker registration, question review and message receipts in the work rail. */
import { useState, type FormEvent } from 'react'
import type { CloudWorkers, CloudMessageReceipt } from '../app/cloud-workers.ts'
import type { ChatgptRow } from '../app/chatgpt-source.ts'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'

type View = ReturnType<CloudWorkers['view']>
async function api<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/session-hub/api/workers/cloud' + path, { method,
    headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '云端 Worker 接口不可用')
  return result as T
}
const labels: Record<CloudMessageReceipt['state'], string> = { prepared: '待确认发送', sending: '发送中', submitted: '已提交 · 待回答',
  uncertain: '发送结果待核对', response_visible: '回答已回填', cancelled: '已取消' }

function WorkerManager({ workers, reload }: { workers: View['workers']; reload(): Promise<void> }) {
  const [query, setQuery] = useState(''), [threadId, setThreadId] = useState(''), [name, setName] = useState('')
  const [purpose, setPurpose] = useState<'qa' | 'general'>('qa'), [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const { data, error } = usePoll(async () => {
    const response = await fetch('/session-hub/api/context/chatgpt-threads?' + new URLSearchParams({ query, limit: '30' }), { headers: { 'x-orchestrator-request': '1' } })
    if (!response.ok) throw new Error('云端会话目录读取失败')
    return await response.json() as { threads: ChatgptRow[]; total: number }
  }, [query], 15000)
  const chosen = data?.threads.find(item => item.id === threadId)
  async function register(event: FormEvent) {
    event.preventDefault(); if (!chosen || busy) return
    setBusy(true); setFailure('')
    try { await api('', 'POST', { threadId, name: name.trim() || chosen.title || '云端问答', purpose, description }); await reload(); setThreadId(''); setName(''); setDescription('') }
    catch (failure) { setFailure(String(failure)) } finally { setBusy(false) }
  }
  return <div className="sa-cloud-form">
    <p className="dt-hint">问答与通用内容，不需要本地项目目录。沿用原会话的模型和思考强度。</p>
    {workers.map(worker => <div className="sa-cloud-worker" key={worker.id}><span>{worker.name}<small>ChatGPT · 云端 · {worker.purpose === 'qa' ? '问答' : '通用内容'}{!worker.available ? ' · 不可用' : ''}</small></span>
      <Button size="sm" disabled={busy} onClick={() => { setBusy(true); setFailure(''); void api('/' + worker.id, 'PUT', { enabled: !worker.enabled }).then(reload).catch(error => setFailure(String(error))).finally(() => setBusy(false)) }}>{worker.enabled ? '停用' : '启用'}</Button></div>)}
    <form onSubmit={event => { void register(event) }} className="sa-cloud-form">
      <label className="dt-field">查找云端会话<Input value={query} onChange={event => { setQuery(event.target.value); setThreadId('') }} placeholder="按标题查找…" /></label>
      <label className="dt-field">目标会话<select required value={threadId} onChange={event => setThreadId(event.target.value)}><option value="">选择已有会话</option>
        {data?.threads.map(row => <option key={row.id} value={row.id}>{row.title} · {row.id.slice(-8)}</option>)}</select></label>
      {data && data.total > data.threads.length && <small className="dt-hint">共 {data.total} 条，请输入标题缩小范围。</small>}
      <label className="dt-field">Worker 名称<Input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder={chosen?.title || '例如：通用问答助手'} /></label>
      <label className="dt-field">用途<select value={purpose} onChange={event => setPurpose(event.target.value as 'qa' | 'general')}><option value="qa">问答与解释</option><option value="general">通用内容整理</option></select></label>
      <label className="dt-field">职责说明<Input value={description} maxLength={1000} onChange={event => setDescription(event.target.value)} placeholder="例如：图形学解释、非项目话题" /></label>
      <Button type="submit" size="sm" disabled={busy || !chosen}>添加云端 Worker</Button>
    </form>
    {(error || failure) && <p role="alert" className="dt-error">{failure || error?.message}</p>}
  </div>
}

/** Expands to the exact outgoing question; successful submission is never shown as a completed answer. */
function MessageReceipt({ item, connected, reload }: { item: CloudMessageReceipt; connected: boolean; reload(): Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [answer, setAnswer] = useState('')
  async function act(operation: 'send' | 'cancel' | 'result') {
    if (busy) return
    setBusy(true); setError('')
    try { await api('/messages/' + item.id + '/' + operation, 'POST', operation === 'result' ? { answer, confirmed: true } : { confirmed: true }); setAnswer(''); await reload() }
    catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }
  return <details className="sa-cloud-receipt"><summary><strong>{item.question.slice(0, 45)}</strong><small>{labels[item.state]} · {item.workerName}</small></summary>
    <div className="sa-cloud-form"><p className="sa-work-report">{item.question}</p>
      <a href={'https://chatgpt.com/c/' + item.threadId} target="_blank" rel="noopener noreferrer">打开目标云端会话 ↗</a>
      {item.error && <p className="dt-error">{item.error}</p>}
      {item.state === 'prepared' && <><p className="dt-hint">仅发送以上问题，沿用目标会话设置。</p><div className="dt-actions">
        <Button size="sm" disabled={busy || !connected} onClick={() => { void act('send') }}>确认发送到云端</Button>
        <Button size="sm" disabled={busy} onClick={() => { void act('cancel') }}>取消草稿</Button></div></>}
      {item.state === 'submitted' && <p className="dt-hint">已取得提交回执。当前接口不自动读取云端回答，可在原会话查看并回填。</p>}
      {item.answer && <><p className="sa-work-report">{item.answer}</p><small className="dt-hint">用户回填 · 尚未独立验收</small></>}
      {['submitted', 'uncertain'].includes(item.state) && <><label className="dt-field">回填本次回答<textarea className="dt-textarea" rows={3} maxLength={32000} value={answer} onChange={event => setAnswer(event.target.value)} /></label>
        <Button size="sm" disabled={busy || !answer.trim()} onClick={() => { void act('result') }}>保存本次回答</Button></>}
      {error && <p className="dt-error" role="alert">{error}</p>}
    </div>
  </details>
}

/** Cloud questions are explicit communication receipts; Engine Tickets retain their existing lifecycle. */
export function CloudWorkerSection() {
  const { data, error, reload } = usePoll(() => api<View>(), [])
  const [manage, setManage] = useState(false), [compose, setCompose] = useState(false)
  const [workerId, setWorkerId] = useState(''), [question, setQuestion] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  // A direct human Submit is already explicit permission for this exact selected ChatGPT thread.
  // Do not ask the same user to confirm a second time. Bot-authored questions still use
  // prepare_cloud_question and the existing independent confirmation card.
  async function prepare(event: FormEvent) {
    event.preventDefault(); if (busy || !workerId || !question.trim()) return
    setBusy(true); setFailure('')
    try {
      const draft = await api<CloudMessageReceipt>('/prepare', 'POST', { workerId, question, requestId: crypto.randomUUID() })
      const receipt = await api<CloudMessageReceipt>('/messages/' + draft.id + '/send', 'POST', { confirmed: true })
      setQuestion(''); setCompose(false)
      if (receipt.state === 'uncertain') setFailure('已发起云端发送，但回执不确定；请在原目标会话核对，系统不会自动重发。')
      await reload()
    } catch (failure) { setFailure(String(failure)); await reload().catch(() => {}) }
    finally { setBusy(false) }
  }
  return <section className="sa-cloud-section" aria-label="云端问答 Worker">
    <header className="sa-work-head"><h2>云端问答</h2><button type="button" className="dt-textlink" onClick={() => setManage(value => !value)} aria-expanded={manage}>管理 Worker</button></header>
    {error && <p className="dt-error" role="status">云端 Worker 读取失败</p>}
    {data && <>
      {!data.connected && <p className="dt-hint">桌面连接器未连接，暂不能发送。</p>}
      {manage && <WorkerManager workers={data.workers} reload={reload} />}
      {!data.workers.length && !manage && <button type="button" className="dt-textlink" onClick={() => setManage(true)}>＋ 添加 ChatGPT 云端 Worker</button>}
      {!!data.workers.length && <Button size="sm" variant="ghost" onClick={() => setCompose(value => !value)}>＋ 发送问题</Button>}
      {compose && <form onSubmit={event => { void prepare(event) }} className="sa-cloud-form">
        <label className="dt-field">交给谁<select required value={workerId} onChange={event => setWorkerId(event.target.value)}><option value="">选择云端 Worker</option>
          {data.workers.map(worker => <option key={worker.id} value={worker.id} disabled={!worker.available}>{worker.name}{!worker.available ? ' · 不可用' : ''}</option>)}</select></label>
        <label className="dt-field">问题<textarea required className="dt-textarea" rows={3} maxLength={8000} value={question} onChange={event => setQuestion(event.target.value)} /></label>
        <p className="dt-hint">你亲自点发送，就只对选定的 ChatGPT 原会话与本条文字授权一次。不会把权限授予 Chief 或其它会话；提交不代表已经得到回答。</p>
        <Button type="submit" size="sm" disabled={busy}>{busy ? '发送中…' : '发送到指定 ChatGPT 会话'}</Button></form>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}
      {[...data.receipts].reverse().filter(item => item.state !== 'cancelled').map(item => <MessageReceipt key={item.id} item={item} connected={data.connected} reload={reload} />)}
    </>}
  </section>
}
