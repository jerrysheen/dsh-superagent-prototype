/** Calm master-chat workspace with live Engine Tickets; details load only on expansion. */
import { useCallback, useState, type ReactNode } from 'react'
import { usePoll, type TicketRow } from './api.ts'
import { Button, Dot } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { When } from './widgets.tsx'
import { readableMarkers } from './text.ts'
import { CloudWorkerSection } from './cloud-workers.tsx'
import { ManagedWorkPanel } from './managed-work.tsx'
import { CodexSessionButton } from './codex-session-button.tsx'

function owner(ticket: TicketRow): string {
  if (ticket.nativeThreadId) return 'Codex'
  return ticket.sessionId ? 'DSH Worker' : '待分配'
}

/** Compact inline facts with an explicit route to the existing full Ticket view. */
function WorkDetails({ ticket }: { ticket: TicketRow }) {
  const { call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET tickets/:id', { id: ticket.id }), [ticket.id])
  return <div className="sa-work-details">
    {error && <p className="dt-error" role="alert">详情读取失败：{error.message}</p>}
    {!data && !error && <p className="dt-hint">读取详情…</p>}
    {data && <>
      <dl><dt>工作目录</dt><dd>{data.directory || '未指定'}</dd>
        <dt>执行目的地</dt><dd>{data.executionDestination || owner(ticket)}</dd>
        <dt>执行权限</dt><dd>{data.executionTransport === 'desktop' ? '沿用桌面当前设置，DSH 不覆盖' : data.executionPermission === 'workspace-write' ? '工程读写' : data.executionPermission === 'read-only' ? '只读' : '未提供'}</dd>
        <dt>工单</dt><dd>{ticket.id}</dd>
        <dt>执行会话</dt><dd>{data.nativeThreadId || data.sessionId || '尚未分配'}</dd>
        {data.nativeThreadId && <><dt>桌面项目</dt><dd>{data.desktopError || (data.desktopProject ? data.desktopProject.projectName + '（元数据已关联，列表展示待桌面核验）' : '尚未确认关联')}</dd>
          <dt>会话管理</dt><dd>{data.executionTransport === 'desktop' ? data.desktopTracking === 'detached' ? 'DSH 已停止跟踪；请在桌面管理或停止任务' : '由桌面管理，DSH 不占用；可参与和接续' : data.nativeWriter?.state === 'released' ? '已释放，可在桌面接续' : data.nativeWriter?.state === 'releasing' ? '正在释放'
            : data.nativeWriter?.state === 'held' && data.stage === 'working' ? '正在执行；完成后自动释放，随后可在桌面接续' : '占用状态待确认'}</dd></>}
      </dl>
      {data.nativeThreadId && <CodexSessionButton threadId={data.nativeThreadId} />}
      {data.summary && <p className="sa-work-report">{data.summary}</p>}
      {data.attention && <p className="sa-work-report">{data.attention.question}</p>}
      {!!data.threads.length && <div className="sa-work-threads">{data.threads.map(thread => <span key={thread.key}>{thread.title}</span>)}</div>}
    </>}
    <Button size="sm" variant="ghost" onClick={() => navigate({ page: 'execution', id: ticket.id })}>查看完整记录 →</Button>
  </div>
}

function WorkCard({ ticket }: { ticket: TicketRow }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const mark = ticketMark(t, ticket)
  const progress = ticket.note?.text || ticket.summary || (ticket.stage === 'working' && ticket.action === 'queued' ? '等待执行资源' : '暂无进展报告')
  return <article className="sa-work" data-state={mark.dot}>
    <button type="button" className="sa-work-toggle" aria-expanded={expanded} aria-controls={'sa-work-' + ticket.id}
      onClick={() => setExpanded(value => !value)}>
      <span className="sa-work-title">{readableMarkers(t, ticket.title)}<span aria-hidden="true">{expanded ? '−' : '+'}</span></span>
      <span className="sa-work-meta"><Dot state={mark.dot} /><span>{mark.label}</span><span>·</span><span>{owner(ticket)}</span></span>
      <span className="sa-work-progress">{progress}</span>
      <span className="sa-work-time"><When at={ticket.updatedAt} /></span>
    </button>
    <div id={'sa-work-' + ticket.id} hidden={!expanded}>{expanded && <WorkDetails ticket={ticket} />}</div>
  </article>
}

/** Default overview: conversation owns the main column, current work occupies a quiet rail. */
export function AgentWorkspace({ renderChat }: { renderChat?: (id: string, prepare: () => Promise<{ sessionId: string }>) => ReactNode }) {
  const { call, navigate } = usePanel()
  const { state } = usePanelData()
  const prepare = useCallback(() => call('POST master/open'), [call])
  const [limit, setLimit] = useState(20)
  const { data, error, reload } = usePoll(() => call('GET tickets', { query: { state: 'open', limit } }), [limit])
  const tasks = [...data?.items ?? []].sort((a, b) => Number(b.stage === 'person') - Number(a.stage === 'person') || b.updatedAt.localeCompare(a.updatedAt))
  return <div className="sa-workspace">
    <section className="sa-chat" aria-label="主 Agent 对话">
      <header className="sa-chat-head"><div><h2>SuperAgent</h2><p>一起讨论，持续推进。</p></div>
        {state?.paused && <span className="sa-quiet-state">{state.coordinationMode === 'sessions' ? '本地执行已暂停' : '执行已暂停'}</span>}</header>
      <div className="sa-chat-body">{state?.masterId && renderChat ? renderChat(state.masterId, prepare) : <div className="sa-chat-placeholder">
        <h3>从一件想推进的事开始</h3><p>{state ? '主 Agent 对话暂不可用。' : '正在连接主 Agent…'}</p>
      </div>}</div>
    </section>
    <aside className="sa-work-rail" aria-label="当前任务">
      {state?.coordinationMode === 'sessions' && <ManagedWorkPanel />}
      <header className="sa-work-head"><h2>当前任务 <span>{data ? data.total : '—'}</span></h2>
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution' })}>全部</button></header>
      {error && <div className="sa-work-error" role="alert"><p>任务更新失败{data ? '，当前显示上次结果' : ''}。</p><Button size="sm" onClick={() => { void reload() }}>重试</Button></div>}
      {!data && !error && <p className="sa-rail-empty" role="status">正在读取任务…</p>}
      {data && !tasks.length && <div className="sa-rail-empty"><p>目前没有已登记的进行中任务</p><span>此处仅统计 Engine 工单，不代表原生会话没有工作。</span></div>}
      <div className="sa-work-list">{tasks.map(ticket => <WorkCard key={ticket.id} ticket={ticket} />)}</div>
      {data?.next_offset != null && <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + 20)}>加载更多</Button>}
      {state?.coordinationMode === 'sessions' && <CloudWorkerSection />}
    </aside>
  </div>
}
