/** Control plane for external AI sessions. Routing is real; external sending is not yet automated. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { SessionCard, SessionTask } from '../app/session-hub.ts'
import { nativeSessionLinks, nativeTaskLinks } from './native-ui-links.ts'
import { getHubNavigation, navigateHub, requestTaskDraft, subscribeHubNavigation } from './hub-navigation.ts'

interface Snapshot { sessions: SessionCard[]; tasks: SessionTask[] }
type BotId = 'chatgpt' | 'cursor' | 'codex' | 'grok' | 'dsh' | 'other'
type BoardStage = 'queue' | 'active' | 'review' | 'done'
interface ContextHit {
  uid: string
  nativeThreadId: string
  title: string
  projectName: string
  sourceKind: string
  updatedAt: number
  score: number
}
function isSameProject(a: SessionCard, b: SessionCard): boolean {
  if (a.projectId && b.projectId) return a.projectId === b.projectId
  return !!a.projectName && !!b.projectName && a.projectName.trim().toLowerCase() === b.projectName.trim().toLowerCase()
}

const BOTS: { id: BotId; name: string; role: string; mark: string; tone: string }[] = [
  { id: 'chatgpt', name: 'ChatGPT', role: '研究分析 / Chat & Work', mark: 'C', tone: 'sage' },
  { id: 'cursor', name: 'Cursor', role: 'IDE 开发 / 项目修改', mark: '⌘', tone: 'violet' },
  { id: 'codex', name: 'Codex', role: '编码执行 / 代码审阅', mark: '>', tone: 'blue' },
  { id: 'grok', name: 'Grok bot', role: '代码审阅 / 协作执行', mark: 'G', tone: 'orange' },
  { id: 'dsh', name: 'DSH Worker', role: 'Harness 原生任务', mark: 'D', tone: 'teal' },
]
const STATUS: Record<SessionTask['status'], string> = {
  needs_target: '目标未明确', unavailable: '无法发送', waiting_user: '等待派发', submitted: '已提交', running: '执行中',
  waiting_person: '等待你处理', response_visible: '收到回复', reported_ready: '报告完成', verified_done: '已验收',
  uncertain: '状态待核对', failed: '执行失败',
}
const COLUMNS: { stage: BoardStage; title: string; subtitle: string; statuses: SessionTask['status'][] }[] = [
  { stage: 'queue', title: '待分派', subtitle: '等待目标或实际发送', statuses: ['needs_target', 'unavailable', 'waiting_user'] },
  { stage: 'active', title: '已交办', subtitle: '已提交或正在执行', statuses: ['submitted', 'running'] },
  { stage: 'review', title: '待回收 / 审阅', subtitle: '回复、结果或人工决策', statuses: ['waiting_person', 'response_visible', 'reported_ready', 'uncertain', 'failed'] },
  { stage: 'done', title: '已验收', subtitle: '有人工验收依据', statuses: ['verified_done'] },
]
const REVIEW_STATUSES: { value: SessionTask['status']; label: string }[] = [
  { value: 'submitted', label: '已在原会话发送' }, { value: 'running', label: '确认执行中' },
  { value: 'response_visible', label: '收到回复' }, { value: 'reported_ready', label: '对方报告完成' },
  { value: 'waiting_person', label: '需要人工决策' }, { value: 'uncertain', label: '发送或结果不确定' },
  { value: 'failed', label: '执行失败' }, { value: 'verified_done', label: '我已验收完成' },
]
function botId(card: SessionCard): BotId {
  const source = (card.provider + ' ' + card.surface).toLowerCase()
  if (source.includes('cursor')) return 'cursor'
  if (source.includes('grok')) return 'grok'
  if (card.surface === 'chatgpt' || source.includes('chatgpt')) return 'chatgpt'
  if (source.includes('codex')) return 'codex'
  if (source.includes('dsh') || source.includes('deepseek')) return 'dsh'
  return 'other'
}
function botLabel(card: SessionCard | null): string {
  if (!card) return '未指定'
  return BOTS.find(bot => bot.id === botId(card))?.name ?? card.provider
}
function stageOf(task: SessionTask): BoardStage {
  return COLUMNS.find(column => column.statuses.includes(task.status))?.stage ?? 'queue'
}
function shortTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function isAttention(task: SessionTask): boolean {
  return ['needs_target', 'unavailable', 'waiting_user', 'waiting_person', 'uncertain', 'failed', 'reported_ready', 'response_visible'].includes(task.status)
}
async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch('/session-hub/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(String(result.error ?? '操作失败'))
  return result
}
function AgentMark({ id, size = 'normal' }: { id: BotId | 'router'; size?: 'normal' | 'small' }) {
  const symbol = id === 'router' ? '✦' : BOTS.find(bot => bot.id === id)?.mark ?? '?'
  return <span className={'hub-agent-mark hub-mark-' + id + (size === 'small' ? ' hub-mark-small' : '')} aria-hidden="true">{symbol}</span>
}
function StatusPill({ task }: { task: SessionTask }) {
  return <span className={'hub-status hub-status-' + task.status}><span className="hub-status-dot" />{STATUS[task.status]}</span>
}

export function SessionHubPage() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ sessions: [], tasks: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState('')
  const [targetBot, setTargetBot] = useState<BotId | 'router'>('router')
  const [targetSession, setTargetSession] = useState('')
  const [filterBot, setFilterBot] = useState<BotId | 'all'>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [receiptStatus, setReceiptStatus] = useState<SessionTask['status']>('response_visible')
  const [receiptResult, setReceiptResult] = useState('')
  const [receiptEvidence, setReceiptEvidence] = useState('')
  const navigation = useSyncExternalStore(subscribeHubNavigation, getHubNavigation, getHubNavigation)
  const { view, sessionUid: selectedSessionUid } = navigation
  const [taskStage, setTaskStage] = useState<BoardStage | 'all'>('all')
  const [contextHits, setContextHits] = useState<ContextHit[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const [contextFailed, setContextFailed] = useState(false)
  const dispatchRef = useRef<HTMLTextAreaElement>(null)
  const reload = useCallback(async () => {
    try {
      setSnapshot(await call('snapshot') as Snapshot)
      setUpdated(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
      setError('')
    } catch (err) { setError(String(err)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void reload()
    const timer = setInterval(() => { void reload() }, 5000)
    return () => clearInterval(timer)
  }, [reload])
  const act = async (path: string, data: unknown): Promise<unknown | null> => {
    try {
      const result = await call(path, data)
      await reload()
      return result
    } catch (err) { setError(String(err)); return null }
  }
  const assignedSessions = useMemo(() => snapshot.sessions.filter(card => botId(card) === targetBot), [snapshot.sessions, targetBot])
  const visibleTasks = useMemo(() => snapshot.tasks.filter(task => filterBot === 'all' || (task.target && botId(task.target) === filterBot)), [snapshot.tasks, filterBot])
  const selectedSession = selectedSessionUid === '__new__' ? null
    : snapshot.sessions.find(card => card.uid === selectedSessionUid) ?? snapshot.sessions[0] ?? null
  const relatedSessions = selectedSession ? snapshot.sessions.filter(card => card.uid !== selectedSession.uid && isSameProject(card, selectedSession)).slice(0, 4) : []
  const sessionTasks = selectedSession ? snapshot.tasks.filter(task => task.target?.uid === selectedSession.uid)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : []
  const listedTasks = visibleTasks.filter(task => taskStage === 'all' || stageOf(task) === taskStage)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const matchingContextHits = contextHits.filter(hit => !hit.sourceKind.startsWith('subAgent')
    && hit.uid !== selectedSession?.uid && hit.nativeThreadId !== selectedSession?.threadId).slice(0, 4)
  useEffect(() => {
    let active = true
    setContextHits([])
    setContextFailed(false)
    if (!selectedSession?.title.trim()) { setContextLoading(false); return () => { active = false } }
    setContextLoading(true)
    void call('context/search', { query: selectedSession.title.slice(0, 600), limit: 8 })
      .then(result => {
        if (active) setContextHits((result as { matches: ContextHit[] }).matches ?? [])
      }).catch(() => { if (active) setContextFailed(true) })
      .finally(() => { if (active) setContextLoading(false) })
    return () => { active = false }
  }, [selectedSession?.uid, selectedSession?.title])
  const selectedTask = visibleTasks.find(task => task.id === selectedTaskId) ?? visibleTasks[0]
  const attention = snapshot.tasks.filter(isAttention).slice(0, 4)
  const inFlight = snapshot.tasks.filter(task => stageOf(task) === 'active').length
  const validated = snapshot.tasks.filter(task => task.status === 'verified_done').length
  const selectedNativeLinks = selectedTask?.target ? nativeTaskLinks(selectedTask.target, selectedTask.request.instruction) : []
  useEffect(() => {
    if (!navigation.focusKey || view !== 'workspace') return
    setTargetBot('router')
    setTargetSession('')
    dispatchRef.current?.focus()
  }, [navigation.focusKey, view])

  const submitTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const data = new FormData(form)
    const instruction = String(data.get('instruction') ?? '').trim()
    if (!instruction) return
    let target: { uid?: string } = {}
    if (targetBot !== 'router') {
      const eligible = assignedSessions.filter(card => card.identity !== 'unknown' && card.capabilities.send !== 'unavailable')
      const uid = targetSession || (eligible.length === 1 ? eligible[0]!.uid : '')
      if (!uid || !eligible.some(card => card.uid === uid)) {
        setError('请先为该 Bot 选择唯一的已登记会话；尚未接入的 Bot 不能直接派发。')
        return
      }
      target = { uid }
    }
    setBusy(true)
    try {
      const task = await act('tasks', { requestId: crypto.randomUUID(), instruction, target }) as SessionTask | null
      if (task) {
        setSelectedTaskId(task.id)
        navigateHub({ view: 'tasks' })
        form.reset()
      }
    } finally { setBusy(false) }
  }
  const registerSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const provider = String(data.get('provider') ?? 'chatgpt-desktop')
    const project = String(data.get('project') ?? '').trim()
    const workspace = String(data.get('workspace') ?? '').trim()
    const card = {
      uid: crypto.randomUUID(), provider, surface: provider === 'chatgpt-desktop' ? 'chatgpt' : provider === 'codex' ? 'codex' : 'other',
      mode: data.get('mode'), projectId: project || null, projectName: project || null,
      ...(workspace ? { workspacePath: workspace } : {}),
      threadId: String(data.get('thread') ?? '').trim() || null, title: String(data.get('title') ?? '').trim(),
      summary: String(data.get('summary') ?? '').trim(),
      scope: 'unknown', identity: 'operator_confirmed',
      capabilities: { read: 'import', send: 'user' }, evidence: ['用户手动登记，自动读写未验证'], origin: 'manual',
    }
    if (await act('sessions', card)) form.reset()
  }
  const submitReceipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedTask?.target) { setError('任务尚未确定目标，无法回填结果。'); return }
    if (receiptStatus === 'verified_done' && !receiptEvidence.trim()) {
      setError('人工验收必须填写证据或产物位置。'); return
    }
    if (await act('tasks/' + encodeURIComponent(selectedTask.id) + '/receipts', {
      eventId: crypto.randomUUID(), sessionUid: selectedTask.target.uid, status: receiptStatus,
      result: receiptResult, evidence: receiptEvidence.trim() ? [receiptEvidence.trim()] : [], actor: 'user',
    })) { setReceiptResult(''); setReceiptEvidence('') }
  }
  const focusTask = (id: string, clearFilter = false) => {
    if (clearFilter) setFilterBot('all')
    setSelectedTaskId(id)
    setReceiptStatus('response_visible')
    setReceiptResult('')
    setReceiptEvidence('')
  }


  const inspector = <aside className="hub-inspector" aria-label="任务检查器">
    <section className="hub-inspector-block">
      <div className="hub-small-heading"><h2>需要你处理</h2><span className="hub-count">{snapshot.tasks.filter(isAttention).length}</span></div>
      {attention.length ? <div className="hub-attention-items">{attention.map(task =>
        <button key={task.id} type="button" className="hub-attention-item" onClick={() => { focusTask(task.id, true); navigateHub({ view: 'tasks' }) }}>
          <span className="hub-attention-dot" /><span className="hub-attention-copy"><strong>{task.request.instruction}</strong>
            <small>{botLabel(task.target)} · {STATUS[task.status]}</small></span><span className="hub-attention-arrow">›</span>
        </button>)}</div> : <p className="hub-hint hub-attention-clear">目前没有需要人工处理的任务。</p>}
    </section>
    <section className="hub-inspector-block hub-task-detail" aria-label="当前任务详情">
      <div className="hub-small-heading"><h2>任务检查器</h2>{selectedTask && <StatusPill task={selectedTask} />}</div>
      {selectedTask ? <>
        <h3>{selectedTask.request.instruction}</h3>
        <div className="hub-inspector-facts">
          <div><span>负责人</span><strong>{botLabel(selectedTask.target)}</strong></div>
          <div><span>目标会话</span><strong>{selectedTask.target?.title ?? '尚未确定'}</strong></div>
          <div><span>创建时间</span><strong>{shortTime(selectedTask.createdAt)}</strong></div>
        </div>
        {selectedNativeLinks.length > 0 && <div className="hub-native-actions">
          <strong>继续在原应用处理</strong>
          <div className="hub-native-links">{selectedNativeLinks.map(link =>
            <a className="hub-native-link" key={link.id} href={link.href} rel="noopener noreferrer">{link.label} ↗</a>)}</div>
          {selectedNativeLinks.map(link => <p key={link.id}>{link.notice}</p>)}
          <small>只负责打开应用或预填草稿，不代表自动发送。</small>
        </div>}
        {selectedTask.target && !selectedNativeLinks.length && ['cursor', 'codex'].includes(botId(selectedTask.target)) &&
          <p className="hub-native-unavailable">当前目标没有可验证的原生跳转入口。</p>}
        {selectedTask.routing && <details className="hub-disclosure" open={false}>
          <summary>Router 的选择依据</summary><p>{selectedTask.routing.reason}</p>
          <small>{selectedTask.routing.model?.model ?? '规则判断'} · {selectedTask.routing.intent === 'create_new' ? '建议新建任务 / 会话'
            : selectedTask.routing.intent === 'unrelated' ? '无关联旧会话' : selectedTask.routing.action === 'selected' ? '已推荐接续' : '待确认'}</small>
        </details>}
        <div className="hub-receipts"><div className="hub-small-heading"><h2>执行记录</h2><span className="hub-count">{selectedTask.receipts.length}</span></div>
          {selectedTask.receipts.length ? selectedTask.receipts.map(receipt => <div className="hub-receipt" key={receipt.eventId}>
            <span className="hub-receipt-circle" /><div><b>{STATUS[receipt.status]}</b>
              <small>{receipt.actor === 'user' ? '人工确认' : '连接器上报'}</small>
              {receipt.result && <p>{receipt.result}</p>}{receipt.evidence.map(item =>
                <p className="hub-receipt-evidence" key={item}>{item}</p>)}</div>
          </div>) : <p className="hub-hint">尚无执行回执；准备分派不等于已发送。</p>}
        </div>
        {selectedTask.target && selectedTask.status !== 'verified_done' && <form className="hub-receipt-form" onSubmit={submitReceipt}>
          <strong>补充回执</strong>
          <label>执行状态<select value={receiptStatus} onChange={event => setReceiptStatus(event.target.value as SessionTask['status'])}>
            {REVIEW_STATUSES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label>结果摘要<textarea rows={2} value={receiptResult} maxLength={50000} onChange={event => setReceiptResult(event.target.value)}
            placeholder="已确认的结果、当前阻塞或下一步…" /></label>
          <label>证据 / 产物位置<input placeholder="验收完成时必填" value={receiptEvidence} onChange={event => setReceiptEvidence(event.target.value)} /></label>
          <button type="submit" className="hub-button hub-button-outline">保存回执</button>
        </form>}
      </> : <div className="hub-mini-empty"><span>◎</span><p>选择任务后，可在这里查看路由原因、执行记录并回填结果。</p></div>}
    </section>
  </aside>

  return <div className="dt-page hub-page"><main className="hub-shell">
    <header className="hub-header">
      <div className="hub-header-location">
        <h1>{view === 'workspace' ? selectedSession?.title ?? 'SuperAgent' : view === 'tasks' ? 'SuperAgent · 任务' : 'SuperAgent · 连接'}</h1>
        {view === 'workspace' && <>
          <select className="hub-session-picker" aria-label="切换 SuperAgent 会话" title="当前会话" value={selectedSession?.uid ?? '__new__'}
            onChange={event => navigateHub({ sessionUid: event.target.value })}>
            <option value="__new__">新任务 / 智能推荐</option>
            {snapshot.sessions.map(card => <option key={card.uid} value={card.uid}>{card.title}</option>)}
          </select>
          {selectedSession && <span className="hub-header-mode">{selectedSession.mode === 'unknown' ? '未确认模式' : selectedSession.mode.toUpperCase()}</span>}
        </>}
      </div>
      <div className="hub-header-actions">
        {view === 'workspace' && selectedSession && <div className="hub-session-commands">
          {nativeSessionLinks(selectedSession).map(link =>
            <a key={link.id} href={link.href} rel="noopener noreferrer" className="hub-button hub-button-quiet">{link.label} ↗</a>)}
          {selectedSession.identity !== 'unknown' && selectedSession.capabilities.send !== 'unavailable' &&
            <button type="button" className="hub-button hub-button-quiet" onClick={() => {
              setTargetBot(botId(selectedSession)); setTargetSession(selectedSession.uid); dispatchRef.current?.focus()
            }}>以此会话派发 ↗</button>}
        </div>}
        {updated && <span className="hub-sync"><span className="hub-live-dot" /> {updated} 已同步</span>}
        <button type="button" className="hub-button hub-button-quiet" onClick={() => { void reload() }}>↻ 刷新</button>
        <button type="button" className="hub-button hub-button-primary" onClick={requestTaskDraft}>＋ 新任务</button>
      </div>
    </header>
    <nav className="hub-tabs" aria-label="SuperAgent 页面">
      <button type="button" className={view === 'workspace' ? 'hub-tab-active' : ''} aria-current={view === 'workspace' ? 'page' : undefined}
        onClick={() => navigateHub({ view: 'workspace' })}>会话</button>
      <button type="button" className={view === 'tasks' ? 'hub-tab-active' : ''} aria-current={view === 'tasks' ? 'page' : undefined}
        onClick={() => navigateHub({ view: 'tasks' })}>任务 <span className="hub-tab-number">{snapshot.tasks.length}</span></button>
      <button type="button" className={view === 'connections' ? 'hub-tab-active' : ''} aria-current={view === 'connections' ? 'page' : undefined}
        onClick={() => navigateHub({ view: 'connections' })}>连接</button>
    </nav>
    {error && <div className="hub-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭错误">×</button></div>}

    {view === 'workspace' && <div className="hub-workspace-layout"><div className="hub-center">
      <div className="hub-conversation-scroll">
      {selectedSession ? <section className="hub-conversation-header">
        <div className="hub-conversation-breadcrumb">{selectedSession.projectName ?? '未归类项目'} <span>/</span> {botLabel(selectedSession)}</div>
          <div className="hub-session-tags">
            <span>{selectedSession.identity === 'machine_confirmed' ? '身份已确认' : selectedSession.identity === 'operator_confirmed' ? '人工登记' : '身份待确认'}</span>
            <span>{selectedSession.capabilities.read === 'api' ? '接口可读' : selectedSession.capabilities.read === 'import' ? '元数据 / 摘要' : '尚未接入读取'}</span>
          </div>
      </section> : <section className="hub-conversation-header hub-no-session">
        <p>描述你想推进的工作，SuperAgent 会根据已登记的会话推荐合适的继续位置。</p>
      </section>}

      {attention.length > 0 && <button type="button" className="hub-attention-inline"
        onClick={() => { focusTask(attention[0]!.id, true); navigateHub({ view: 'tasks' }) }}>
        <span className="hub-attention-dot" /><strong>{snapshot.tasks.filter(isAttention).length} 项需要你处理</strong>
        <span>{attention[0]!.request.instruction}</span><span aria-hidden="true">›</span>
      </button>}

      {selectedSession ? <div className="hub-context-content">
        <section className="hub-content-section" aria-labelledby="hub-context-title">
          <div className="hub-content-heading"><h2 id="hub-context-title">会话上下文</h2><span className="hub-subtle-label">已登记摘要 · 非原聊天全文</span></div>
          <div className="hub-context-summary">
            <p>{selectedSession.summary || '这段会话还没有登记进度摘要；完整原会话消息也尚未接入。'}</p>
            <div className="hub-context-meta">
              <span>项目：{selectedSession.projectName ?? '未归类'}</span>
              <span>读取：{selectedSession.capabilities.read === 'api' ? '接口' : selectedSession.capabilities.read === 'import' ? '导入摘要' : '不可用'}</span>
              <span>发送：{selectedSession.capabilities.send === 'api' ? '接口' : selectedSession.capabilities.send === 'user' ? '人工' : '不可用'}</span>
            </div>
          </div>
        </section>
        <section className="hub-content-section" aria-labelledby="hub-related-title">
          <div className="hub-content-heading"><h2 id="hub-related-title">关联会话</h2><span className="hub-subtle-label">同项目 / Codex 索引匹配</span></div>
          {relatedSessions.length > 0 && <div className="hub-related-items">{relatedSessions.map(card =>
            <button type="button" className="hub-related-row" key={card.uid} onClick={() => navigateHub({ sessionUid: card.uid })}>
              <AgentMark id={botId(card)} size="small" /><span><strong>{card.title}</strong><small>同项目 · {botLabel(card)}</small></span><span>↗</span>
            </button>)}</div>}
          {matchingContextHits.length > 0 && <div className="hub-related-items">{matchingContextHits.map(hit =>
            <div className="hub-related-row" key={hit.uid}><AgentMark id="codex" size="small" />
              <span><strong>{hit.title}</strong><small>Codex 索引匹配 · {hit.projectName} · {hit.sourceKind}</small></span>
              {/^[0-9a-f-]{36}$/i.test(hit.nativeThreadId) && <a href={'codex://threads/' + hit.nativeThreadId} rel="noopener noreferrer">打开 ↗</a>}
            </div>)}</div>}
          {!relatedSessions.length && !matchingContextHits.length && <p className="hub-hint hub-related-empty">
            {contextLoading ? '正在检索关联记录…' : contextFailed ? '索引暂不可用，没有其他同项目已登记会话。' : '暂无可验证的同项目或索引匹配会话。'}</p>}
          <p className="hub-source-caption">关联基于项目登记信息与 Codex 标题索引，不代表已读取聊天记录。</p>
        </section>
        <section className="hub-content-section" aria-label="此会话的任务记录">
          <div className="hub-content-heading"><h2>任务记录</h2><button type="button" className="hub-text-link" onClick={() => navigateHub({ view: 'tasks' })}>查看全部 ↗</button></div>
          {sessionTasks.length ? <div className="hub-activity-items">{sessionTasks.slice(0, 6).map(task =>
            <button type="button" className="hub-activity-row" key={task.id} onClick={() => { focusTask(task.id, true); navigateHub({ view: 'tasks' }) }}>
              <span className="hub-activity-line" /><span className="hub-activity-body"><strong>{task.request.instruction}</strong>
                <small>{shortTime(task.updatedAt)} · {task.receipts.length} 条回执</small></span><StatusPill task={task} />
            </button>)}</div> : <p className="hub-hint hub-activity-empty">这段会话尚无任务记录。</p>}
        </section>
      </div> : <div className="hub-new-task-empty"><span>✦</span><p>SuperAgent 可推荐已有会话。路由判断与外部发送是两个独立步骤。</p></div>}
      </div>
      <div className="hub-composer-dock">
      <section className="hub-composer" aria-label="分派任务">
        <form onSubmit={submitTask}>
          <textarea ref={dispatchRef} name="instruction" required maxLength={20000} rows={2}
            aria-label="给 SuperAgent 输入任务" placeholder="向 SuperAgent 描述你的任务…"
            onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.form?.requestSubmit() }} />
          <div className="hub-composer-foot">
            <div className="hub-composer-selection">
              <select aria-label="选择派发方式" value={targetBot} onChange={event => {
                setTargetBot(event.target.value as BotId | 'router'); setTargetSession('')
              }}>
                <option value="router">✦ 智能推荐</option>{BOTS.map(bot => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
              </select>
              {targetBot !== 'router' && <select aria-label="目标原会话" value={targetSession} onChange={event => setTargetSession(event.target.value)}>
                <option value="">选择目标会话</option>
                {assignedSessions.map(card => <option key={card.uid} value={card.uid} disabled={card.identity === 'unknown' || card.capabilities.send === 'unavailable'}>
                  {card.projectName ?? '非项目'} · {card.title}</option>)}
              </select>}
            </div>
            <div className="hub-composer-actions"><span>Ctrl / ⌘ + Enter</span>
              <button type="submit" className="hub-button hub-button-primary hub-submit" disabled={busy}
                aria-label={busy ? '判断中…' : '准备分派'} title={busy ? '判断中…' : '准备分派'}><span aria-hidden="true">{busy ? '…' : '↑'}</span></button>
            </div>
          </div>
        </form>
      </section>
      <p className="hub-composer-caption">仅保存指令与推荐结果，实际发送需要人工或已接入的连接器。</p>
      </div>
    </div></div>}
    {view === 'tasks' && <div className="hub-task-layout">
      <section className="hub-task-list-pane" aria-label="任务列表">
        <div className="hub-view-head"><div><h2>任务</h2><p>按真实回执状态查看任务，选中后在右侧验收或补充记录。</p></div>
          <span className="hub-compact-stat">{inFlight} 项已交办 · {validated} 项已验收</span></div>
        <div className="hub-phase-tabs" role="group" aria-label="筛选任务阶段">
          <button type="button" className={taskStage === 'all' ? 'hub-phase-active' : ''} onClick={() => setTaskStage('all')}>全部 <span>{visibleTasks.length}</span></button>
          {COLUMNS.map(column => <button key={column.stage} type="button" className={taskStage === column.stage ? 'hub-phase-active' : ''}
            onClick={() => setTaskStage(column.stage)}>{column.title} <span>{visibleTasks.filter(task => stageOf(task) === column.stage).length}</span></button>)}
        </div>
        {filterBot !== 'all' && <div className="hub-filter-hint">已按 {BOTS.find(bot => bot.id === filterBot)?.name ?? '其他'} 筛选
          <button type="button" onClick={() => setFilterBot('all')}>清除 ×</button></div>}
        <div className="hub-task-feed">{listedTasks.length ? listedTasks.map(task => <button key={task.id} type="button"
          className={'hub-task-list-row' + (selectedTask?.id === task.id ? ' hub-task-list-row-active' : '')}
          onClick={() => focusTask(task.id)}>
          <span className="hub-task-list-icon">{task.target ? <AgentMark id={botId(task.target)} size="small" /> : <AgentMark id="router" size="small" />}</span>
          <span className="hub-task-list-main"><strong>{task.request.instruction}</strong>
            <small>{botLabel(task.target)} · {task.target?.projectName ?? '未指定项目'} · {shortTime(task.updatedAt)}</small></span>
          <StatusPill task={task} /><span className="hub-task-list-chevron">›</span>
        </button>) : <div className="hub-mini-empty"><span>◎</span><p>当前筛选下暂无任务。可以从会话工作区发起任务。</p></div>}</div>
      </section>
      {inspector}
    </div>}
    {view === 'connections' && <div className="hub-connections-layout">
      <section className="hub-connections-main">
        <div className="hub-view-head"><div><h2>连接管理</h2><p>查看每个执行来源的真实接入能力，登记新会话，维护已有的协作入口。</p></div>
          <span className="hub-compact-stat">{snapshot.sessions.length} 个会话</span></div>
        <div className="hub-connectors">
          {BOTS.map(bot => {
            const sessions = snapshot.sessions.filter(card => botId(card) === bot.id)
            const jobs = snapshot.tasks.filter(task => task.target && botId(task.target) === bot.id)
            const api = sessions.some(card => card.capabilities.send === 'api')
            return <div className="hub-connector-row" key={bot.id}><AgentMark id={bot.id}/>
              <div><strong>{bot.name}</strong><small>{bot.role}</small></div>
              <span className="hub-connector-count">{sessions.length} 会话 / {jobs.length} 任务</span>
              <span className={'hub-connector-state' + (sessions.length ? ' hub-connector-known' : '')}>{sessions.length ? api ? 'API 已登记' : '人工接入' : '未接入'}</span>
              <button type="button" className="hub-button hub-button-quiet" onClick={() => { setFilterBot(bot.id); navigateHub({ sessionUid: null }); navigateHub({ view: 'workspace' }) }}>查看会话 ›</button>
            </div>
          })}
        </div>
        <section className="hub-content-section hub-manage-sessions">
          <div className="hub-content-heading"><h3>已登记会话</h3></div>
          <div className="hub-managed-session-list">{snapshot.sessions.length ? snapshot.sessions.map(card =>
            <div className="hub-managed-session" key={card.uid}><AgentMark id={botId(card)} size="small"/>
              <span><strong>{card.title}</strong><small>{botLabel(card)} · {card.projectName ?? '未归类'} · {card.capabilities.send === 'api' ? '接口发送' : card.capabilities.send === 'user' ? '需人工发送' : '不可发送'}</small></span>
              <button type="button" onClick={() => { setFilterBot('all'); navigateHub({ sessionUid: card.uid }); navigateHub({ view: 'workspace' }) }}>查看 ›</button>
            </div>) : <p className="hub-hint">当前没有已登记的会话。</p>}</div>
        </section>
        <details className="hub-register" open={snapshot.sessions.length === 0}>
          <summary>＋ 添加 / 登记会话 <span>手动接入</span></summary>
          <form onSubmit={registerSession}>
            <div className="hub-form-row"><label>Bot 类型<select name="provider" defaultValue="chatgpt-desktop">
              <option value="chatgpt-desktop">ChatGPT</option><option value="cursor">Cursor</option>
              <option value="codex">Codex</option><option value="grok-bot">Grok bot</option><option value="dsh-headless">DSH Worker</option>
            </select></label><label>会话模式<select name="mode" defaultValue="work"><option value="work">Work</option>
              <option value="chat">Chat</option><option value="unknown">未知（无法自动路由）</option></select></label></div>
            <label>标题<input name="title" required maxLength={500} placeholder="例如：GC Profiler 增量压缩" /></label>
            <label>项目<input name="project" maxLength={200} placeholder="例如：Unity / AI Center" /></label>
            <label>本地目录（可选，仅用于明确的桌面跳转）<input name="workspace" maxLength={500} placeholder="F:\ElexGithub\GIGNew\client" /></label>
            <label>原会话链接或 ID<input name="thread" maxLength={200} placeholder="可留空，之后由连接器补充" /></label>
            <label>摘要<textarea name="summary" maxLength={3000} rows={2} placeholder="当前进度与下一步；Router 将用它判断任务归属" /></label>
            <button className="hub-button hub-button-primary" type="submit">登记会话</button>
          </form>
        </details>
        <details className="hub-dev-tools"><summary>桌面调用测试（开发调试）</summary><div className="hub-dev-links">
          <a href="codex://settings" rel="noopener noreferrer">测试 Codex 唤起 ↗</a>
          <a href="cursor://anysphere.cursor-deeplink/prompt?text=SUPERAGENT_GUI_LINK_TEST" rel="noopener noreferrer">打开 Cursor 草稿 ↗</a>
          <p>测试仅调用外部应用，不会自动发送，也不会代表已定位原会话。</p></div></details>
        {snapshot.sessions.some(card => card.origin === 'test') && <button type="button" className="hub-clean-demo"
          onClick={() => { void act('clear-demo', {}) }}>清理已标记的测试数据</button>}
      </section>
      <aside className="hub-connection-note"><h3>关于连接能力</h3>
        <p>SuperAgent 已支持智能推荐与任务登记。外部 ChatGPT / Cursor / Grok 会话的自动发送尚未全部接入。</p>
        <p>会话摘要来自登记信息；Codex 关联结果来自索引元数据，不能代替完整聊天记录或验收依据。</p>
        <div className="hub-capability-steps"><span>1 · 选择会话或 Router</span><span>2 · 保存指令并准备派发</span><span>3 · 手工发送或连接器执行</span><span>4 · 回收结果并人工验收</span></div>
      </aside>
    </div>}
  </main></div>
}
