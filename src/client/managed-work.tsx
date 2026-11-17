import { useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { ManagedWork } from '../app/managed-work.ts'
import { readableWorkInstruction } from '../app/work-instruction.ts'
import { CodexSessionButton } from './codex-session-button.tsx'

type WorkView = ReturnType<ManagedWork['list']>
type Permission = 'read-only' | 'workspace-write'
const permissionLabel = (permission: Permission) => permission === 'workspace-write' ? '工程读写' : '只读'
const workStateLabel = (state: string) => ({ completed: '已完成', working: '执行中', 'working/queued': '等待执行', 'person/failed': '执行失败',
  'person/blocked': '执行受阻', 'person/answer': '等待答复', 'person/delivery': '派发失败', 'person/review': '等待核验', idle: '空闲', stopped: '已停止', dropped: '已放弃' }[state] ?? state)
function PermissionSelect({ value, onChange, disabled, scope }: { value: Permission; onChange(value: Permission): void; disabled?: boolean; scope?: boolean }) {
  return <label className="dt-field">{scope ? '本次任务范围' : '执行权限'}<select aria-label={scope ? '工作任务范围' : '工作执行权限'} value={value} disabled={disabled} onChange={event => onChange(event.target.value as Permission)}>
    <option value="read-only">只读</option><option value="workspace-write">工程读写</option>
  </select></label>
}
const headers = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
async function request<T>(path: string, body?: unknown, credential?: string): Promise<T> {
  const response = await fetch('/session-hub/api/managed-work' + path, { method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(credential ? { 'x-superagent-bot-token': credential } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw Error(value.error ?? '工作入口暂不可用')
  return value as T
}

export function ManagedWorkButton({ workspace, targetUid, instruction, disabled, onPrepared }: {
  workspace: string; targetUid?: string; instruction: string; disabled?: boolean; onPrepared?(): void
}) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [permission, setPermission] = useState<Permission | ''>('')
  async function prepare() {
    let prepared = false
    setBusy(true); setNotice('')
    try {
      await request('/prepare', { mode: targetUid ? 'continue' : 'new', workspace, targetUid, instruction, executor: 'codex', ...(permission ? { permission } : {}) })
      setNotice('工作卡已生成，请在 SuperAgent 确认；尚未派发。'); prepared = true
    } catch (error) { setNotice(error instanceof Error ? error.message : '准备失败') }
    finally { setBusy(false) }
    if (prepared) onPrepared?.()
  }
  return <span className="sa-managed-action"><select aria-label="登记工作权限" title="本次任务范围；新桌面工作的实际执行权限沿用桌面设置" value={permission} onChange={event => setPermission(event.target.value as Permission | '')}>
    <option value="">{targetUid ? '沿用原工作权限' : '沿用统一权限设置'}</option><option value="read-only">只读</option><option value="workspace-write">工程读写</option>
  </select><Button type="button" disabled={disabled || busy || !instruction.trim()} onClick={() => { void prepare() }}
    title="将文字请求登记为工作卡，确认后由 Engine 执行；不会直接向原会话发送">{busy ? '准备中…' : '登记为工作'}</Button>
    {notice && <small role="status">{notice}</small>}</span>
}

export function ManagedWorkPanel() {
  const { navigate } = usePanel()
  const { data, error, reload } = usePoll(() => request<WorkView>(''), [])
  const [busy, setBusy] = useState(''), [failure, setFailure] = useState(''), [showForm, setShowForm] = useState(false)
  const [credential, setCredential] = useState('')
  const [workspace, setWorkspace] = useState(''), [instruction, setInstruction] = useState('')
  const [permission, setPermission] = useState<Permission | ''>(''), [permissions, setPermissions] = useState<Record<string, Permission>>({})
  async function action(path: string, body: unknown, id: string) {
    setBusy(id); setFailure('')
    try { await request(path, body, credential); if (path === '/prepare') { setInstruction(''); setShowForm(false) }; await reload() }
    catch (error) { setFailure(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy('') }
  }
  function prepare(event: FormEvent) {
    event.preventDefault()
    void action('/prepare', { mode: 'new', workspace: workspace || data?.options.workspaces[0], instruction, executor: 'codex', ...(permission ? { permission } : {}) }, 'new')
  }
  function confirm(proposal: WorkView['proposals'][number]) {
    const selected = proposal.permissionFixed ? proposal.permission : permissions[proposal.id] ?? proposal.permission
    void action('/confirm', { id: proposal.id, token: proposal.token, confirmed: true, startExecution: data?.options.paused === true,
      ...(proposal.transport === 'desktop' ? { desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS' } : {}),
      permission: selected, ...(selected === 'workspace-write' ? { writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' } : {}) }, proposal.id)
  }
  const pending = data?.proposals.filter(proposal => proposal.state === 'draft' || proposal.state === 'submitted'
    && (!proposal.receipt?.tickets.length || proposal.receipt.tickets.some(ticket => !ticket.requestHandled))) ?? []
  const visible = [...pending, ...data?.proposals.filter(proposal => proposal.state === 'submitted' && !pending.some(item => item.id === proposal.id)).slice(0, 3) ?? []]
  return <section className="sa-managed" aria-label="受管工作入口">
    <header><h3>工作受理</h3><Button size="sm" variant="ghost" onClick={() => setShowForm(value => !value)}>新工作</Button></header>
    <label className="dt-field">管理凭据<input type="password" autoComplete="off" aria-label="工作管理凭据" value={credential}
      onChange={event => setCredential(event.target.value)} /></label>
    <small>确认与取消需要本机管理凭据，仅在当前页面内存中保留。也可使用已认证的 Bot 草案卡。</small>
    {error && <p role="alert">工作入口读取失败：{error.message}</p>}
    {failure && <p role="alert" className="dt-error">{failure}</p>}
    {data && !data.options.enabled && <p className="dt-hint">可以准备工作卡，执行端口尚未启用，不会派发。</p>}
    {data?.options.enabled && data.options.paused && <p className="dt-hint">本地执行已暂停。首次确认时可明确启动；存在旧待处理工作时不会自动解除暂停。</p>}
    {showForm && <form onSubmit={prepare}>
      <label className="dt-field">工程目录<select aria-label="工作工程目录" value={workspace || data?.options.workspaces[0] || ''} onChange={event => setWorkspace(event.target.value)}>
        {!data?.options.workspaces.length && <option value="">尚未授权工程</option>}
        {data?.options.workspaces.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <label className="dt-field">原始工作请求<textarea aria-label="新工作请求" value={instruction} maxLength={8000} rows={3} onChange={event => setInstruction(event.target.value)} /></label>
      <PermissionSelect value={permission || data?.options.defaultPermission || 'read-only'} onChange={setPermission} scope />
      <Button type="submit" disabled={!!busy || !instruction.trim() || !data?.options.workspaces.length}>准备工作卡</Button>
    </form>}
    {visible.map(proposal => <article className="sa-managed-card" key={proposal.id}>
      <strong>{proposal.mode === 'new' ? '新开独立工作' : '接续指定工作'}</strong>
      <small>{proposal.workspace}</small><small>{proposal.executor === 'codex' ? 'Codex' : 'DSH Worker'} · {proposal.transport === 'desktop' ? '任务范围：' : ''}{permissionLabel(proposal.permissionFixed ? proposal.permission : permissions[proposal.id] ?? proposal.permission)}{proposal.targetTitle ? ' · ' + proposal.targetTitle : ''}</small>
      <small>{proposal.targetUid ? '接续目标：' + proposal.targetUid : '执行目标：创建新的专属会话'}</small>
      <small>执行位置：{proposal.transport === 'desktop' ? '桌面对应 workspace；可在桌面参与和接续' : proposal.executor === 'codex' ? '后台受限执行（旧入口）' : 'DSH Worker'}</small>
      {proposal.transport === 'desktop' && <small>执行权限沿用桌面当前设置，DSH 不覆盖；可在桌面调整。确认即授权使用该设置执行本次任务。</small>}
      <p className="sa-managed-instruction">{readableWorkInstruction(proposal.instruction).instruction}</p>
      {proposal.state === 'draft' ? <div>
        <PermissionSelect value={proposal.permissionFixed ? proposal.permission : permissions[proposal.id] ?? proposal.permission}
          disabled={!!busy || proposal.permissionFixed} scope={proposal.transport === 'desktop'} onChange={value => setPermissions(current => ({ ...current, [proposal.id]: value }))} />
        {proposal.permissionFixed && <small>已有工作权限固定；改变权限请新建工作。</small>}
        <Button size="sm" variant="primary" disabled={!!busy || !data?.options.enabled} onClick={() => confirm(proposal)}>{busy === proposal.id ? '受理中…'
          : proposal.transport === 'desktop' ? '确认在桌面执行（沿用桌面权限）'
          : (data?.options.paused ? '确认并启动' : '确认提交') + permissionLabel(proposal.permissionFixed ? proposal.permission : permissions[proposal.id] ?? proposal.permission) + '工作'}</Button>
        <Button size="sm" disabled={!!busy} onClick={() => { void action('/cancel', { id: proposal.id }, proposal.id) }}>取消</Button>
      </div> : <small>{proposal.receipt?.tickets.length ? proposal.receipt.tickets.every(ticket => ticket.requestHandled) ? '本轮执行已有报告，请核对结果与验证范围。' : '本轮请求正在处理；旧报告不算本轮完成。' : proposal.receipt?.decision === 'ignore' || proposal.receipt?.reason
        ? 'Engine 未接单或已拒绝，请查看判断记录。'
        : '请求已交给 Engine，工单尚未创建。请查看判断记录；不会冒充已执行。'}</small>}
      {proposal.receipt?.tickets.map(ticket => <div key={ticket.ticket_id}>
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: ticket.ticket_id })}>工单：{ticket.title}</button>
        <small>状态：{workStateLabel(ticket.state)}{ticket.preview ? ' · ' + ticket.preview : ''}</small>
        {ticket.native && <><small>原生会话：{ticket.native.threadId}</small>
          <CodexSessionButton threadId={ticket.native.threadId} />
          <small>桌面项目：{ticket.native.desktopError || (ticket.native.desktop ? ticket.native.desktop.projectName + '（元数据已关联）' : '尚未确认关联')}</small>
          <small>{ticket.native.transport === 'desktop' ? '会话由桌面管理，DSH 不占用；可直接参与和接续。' : '后台占用：' + (ticket.native.writer?.state === 'released' ? '已释放' : ticket.native.writer?.state === 'releasing' ? '正在释放'
            : ticket.native.writer?.state === 'held' && ticket.state === 'working' ? '正在执行；完成后自动释放，随后可在桌面接续' : '占用状态待确认')}</small>
          {ticket.native.tracking === 'detached' && <small>DSH 已停止跟踪；桌面任务可能仍在运行，请在桌面停止。</small>}</>}
      </div>)}
      {proposal.state === 'submitted' && !proposal.receipt?.tickets.length && proposal.receipt?.decision !== 'ignore'
        && <Button size="sm" disabled={!!busy || !data?.options.enabled} onClick={() => confirm(proposal)}>重试受理同一请求</Button>}
    </article>)}
    {data && !pending.length && <p className="dt-hint">明确工作请求会在这里等待确认；普通聊天不自动建单。</p>}
    {!!data?.works.length && <details><summary>工作总账 · 含已结束工作</summary>{data.works.map(work => <article className="sa-managed-card" key={work.ticket_id}>
      <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: work.ticket_id })}>{work.title}</button>
      <small>{String(work.workspace ?? '')} · {work.executor} · {workStateLabel(work.state)}</small>
      <small>工作：{String(work.workId ?? '')}</small>
      {work.nativeThreadId && <CodexSessionButton threadId={work.nativeThreadId} />}{work.preview && <p>{work.preview}</p>}
    </article>)}</details>}
  </section>
}
