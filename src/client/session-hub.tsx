/** Session coordination UI: explicit identities, prepared dispatches and user-recorded results. */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { SessionCard, SessionTask } from '../app/session-hub.ts'

const statusText: Record<SessionTask['status'], string> = {
  needs_target: '需要明确目标', unavailable: '当前不可发送', waiting_user: '待在原会话发送', submitted: '已提交', running: '执行中',
  waiting_person: '需要你处理', response_visible: '已收到回复', reported_ready: '对方报告完成', verified_done: '已验收', uncertain: '发送结果待核对', failed: '失败',
}
interface Snapshot { sessions: SessionCard[]; tasks: SessionTask[] }
async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/session-hub/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(String(result.error ?? '操作失败'))
  return result
}
/** The UI records only user-supplied metadata and receipts; it does not control another app. */
export function SessionHubPage() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ sessions: [], tasks: [] })
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try { setSnapshot(await call('snapshot') as Snapshot); setError('') } catch (error) { setError(String(error)) }
  }, [])
  useEffect(() => { void reload(); const timer = setInterval(() => { void reload() }, 5000); return () => clearInterval(timer) }, [reload])
  const act = async (path: string, data: unknown) => {
    try { await call(path, data); await reload(); return true } catch (error) { setError(String(error)); return false }
  }
  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form)
    const project = String(data.get('project') ?? '').trim()
    if (await act('sessions', { uid: crypto.randomUUID(), provider: 'chatgpt-desktop', surface: 'chatgpt', mode: data.get('mode'),
      projectId: project || null, projectName: project || null, threadId: String(data.get('thread') ?? '') || null,
      title: data.get('title'), scope: 'unknown', identity: 'operator_confirmed', capabilities: { read: 'import', send: 'user' },
      evidence: ['用户在登记表中确认；尚无自动识别证据'], origin: 'manual' })) form.reset()
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form)
    const uid = String(data.get('uid') ?? ''), projectId = String(data.get('project') ?? '').trim(), mode = String(data.get('mode') ?? '')
    if (await act('tasks', { requestId: crypto.randomUUID(), instruction: data.get('instruction'),
      target: { ...(uid ? { uid } : {}), ...(projectId ? { projectId } : {}), ...(mode ? { mode } : {}) } })) form.reset()
  }
  const receipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form)
    const task = snapshot.tasks.find(task => task.id === data.get('task'))
    if (!task?.target) { setError('请先选择目标已明确的任务'); return }
    const evidence = String(data.get('evidence') ?? '').trim()
    if (await act(`tasks/${encodeURIComponent(task.id)}/receipts`, { eventId: crypto.randomUUID(), sessionUid: task.target.uid,
      status: data.get('status'), result: data.get('result'), evidence: evidence ? [evidence] : [], actor: 'user' })) form.reset()
  }
  return <div className="dt-page"><main className="dt-column dt-session-hub">
    <header><h1>AI 会话总控</h1><p>按项目、Chat / Work 和会话身份分派任务，集中回收结果。</p>
      <p className="dt-hint">当前为手工接入：这里不会操作桌面或自动向 ChatGPT 发消息。真实会话尚未连接。</p></header>
    {error && <p className="dt-error" role="alert">{error}</p>}
    <div className="dt-hub-forms">
      <section><h2>登记会话</h2><form onSubmit={register}>
        <label>会话名称<input name="title" required maxLength={500} /></label>
        <label>所属项目<input name="project" placeholder="非项目会话可留空" maxLength={200} /></label>
        <label>模式<select name="mode"><option value="chat">Chat</option><option value="work">Work</option></select></label>
        <label>原会话链接或 ID<input name="thread" maxLength={200} /></label><button type="submit">确认登记</button>
      </form></section>
      <section><h2>分派任务</h2><form onSubmit={submit}>
        <label>任务<textarea name="instruction" required maxLength={20000} /></label>
        <label>目标会话<select name="uid"><option value="">按项目和模式匹配唯一会话</option>{snapshot.sessions.map(card =>
          <option key={card.uid} value={card.uid}>{card.projectName ?? '非项目'} · {card.mode} · {card.title}</option>)}</select></label>
        <label>项目筛选<input name="project" /></label><label>模式筛选<select name="mode"><option value="">不限</option><option value="chat">Chat</option><option value="work">Work</option></select></label>
        <button type="submit">准备派发</button>
      </form></section>
      <section><h2>回收结果</h2><form onSubmit={receipt}>
        <label>任务<select name="task" required><option value="">请选择</option>{snapshot.tasks.filter(task => task.target && task.status !== 'needs_target' && task.status !== 'unavailable').map(task =>
          <option key={task.id} value={task.id}>{task.request.instruction.slice(0, 50)}</option>)}</select></label>
        <label>状态<select name="status"><option value="submitted">用户确认已在原会话发送</option><option value="response_visible">已收到回复</option><option value="reported_ready">对方报告完成</option><option value="verified_done">用户确认验收通过</option><option value="uncertain">发送结果不确定</option></select></label>
        <label>结果<textarea name="result" maxLength={50000} /></label><label>证据或产物位置<input name="evidence" placeholder="验收通过时必填" /></label><button type="submit">保存回执</button>
      </form></section>
    </div>
    <section><h2>已登记会话（{snapshot.sessions.length}）</h2><ul className="dt-list">{snapshot.sessions.map(card => <li key={card.uid} className="dt-row">
      <strong>{card.title}</strong><span>{card.projectName ?? '非项目'} · {card.mode} · {card.origin === 'test' ? '测试数据' : '用户确认'} · 发送需用户操作</span>
    </li>)}</ul>{!snapshot.sessions.length && <p>先登记一个测试会话。登记信息不会被当作自动识别结果。</p>}</section>
    <section><h2>任务与结果（{snapshot.tasks.length}）</h2><ul className="dt-list">{snapshot.tasks.map(task => <li key={task.id} className="dt-row dt-hub-task">
      <strong>{task.request.instruction}</strong><span>{statusText[task.status]} · {task.target ? `${task.target.projectName ?? '非项目'} / ${task.target.mode} / ${task.target.title}` : '未选定会话'}</span>
      {task.status === 'waiting_user' && <p>用户执行：打开以上原会话，核对项目和模式后发送任务，再回填发送结果。</p>}
      {task.status === 'needs_target' && <p>匹配结果不唯一或身份未确认；请明确目标后重新准备任务。</p>}
      {task.receipts.map(item => <div key={item.eventId}><strong>{statusText[item.status]}</strong><p>{item.result}</p>{item.evidence.map(value => <p key={value}>{value}</p>)}</div>)}
    </li>)}</ul></section>
    {snapshot.sessions.some(card => card.origin === 'test') && <button type="button" onClick={() => { void act('clear-demo', {}) }}>清除演示数据</button>}
  </main></div>
}
