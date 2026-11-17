/** Native-density external workspace. An external thread is never passed to DSH's Session Controller. */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, Icon } from './controls.tsx'
import { ConversationMarkdown } from './conversation-markdown.tsx'
import { ConversationImage } from './conversation-image.tsx'
import { ReferenceTextarea } from './reference-textarea.tsx'
import { ManagedWorkButton } from './managed-work.tsx'
import { WorkspacePreview } from './workspace-preview.tsx'
import { ConversationIndex } from './conversation-index.tsx'
import { previewTarget, type PreviewTarget } from './workspace-link.ts'
import type { CodexThread, CodexWorkspaceStore } from './codex-workspace-store.ts'
import type { SessionActivity } from '../app/session-activity.ts'
import { TargetFinder } from './target-finder.tsx'
import { writeWorkerDrag } from './worker-references.ts'
import { ChatgptSourceSidebar } from './chatgpt-source.tsx'
import { attachSharedWorkspaceScroll, type SharedWorkspaceScroll } from './shared-workspace-scroll.ts'
import STYLES from './client.css?raw'
import NATIVE from './native-controls.css?raw'
import WORKSPACE from './codex-workspace.css?raw'
import SYNTAX from './syntax-highlight.css?raw'

const styles = <style>{STYLES}{NATIVE}{WORKSPACE}{SYNTAX}</style>
function ActivityBadge({ value }: { value?: SessionActivity }) {
  const stale = value?.stale || !!value && Date.now() - Date.parse(value.observedAt) > 60000
  const state = value?.state ?? 'unknown'
  const label = ({ running: '进行中', idle: '空闲', waiting_user: '等待你的操作', failed: '执行异常', unknown: '正在读取状态' })[state]
  const time = value ? new Date(value.observedAt).toLocaleTimeString() : ''
  const detail = time ? (stale ? '连接暂不可用，保留上次观测：' : '状态观测时间：') + time : '正在同步运行状态'
  return <span className="cw-activity" data-state={state} role="status" aria-label={label} title={label + ' · ' + detail}>
    {state === 'running' ? <span className="cw-activity-spinner" aria-hidden="true" /> : null}
  </span>
}
function Folder() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3zM3 10h18" /></svg> }
export function CodexWorkspaceSidebar({ wide, store, open, onNew }: { wide: boolean; store: CodexWorkspaceStore; open: (thread: CodexThread) => void; onNew?: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [recentClosed, setRecentClosed] = useState(false)
  const [codexCollapsed, setCodexCollapsed] = useState(false), [nativeCollapsed, setNativeCollapsed] = useState(true)
  const [layout, setLayout] = useState<SharedWorkspaceScroll | null>(null)
  const anchor = useRef<HTMLElement>(null), sectionId = useId()
  useEffect(() => {
    if (!wide || !anchor.current) return
    const element = anchor.current
    let attached: SharedWorkspaceScroll | null = null
    const attempt = () => {
      if (attached || !element.isConnected) return
      attached = attachSharedWorkspaceScroll(element, sectionId + '-native')
      if (attached) { attached.setNativeCollapsed(nativeCollapsed); setLayout(attached); observer.disconnect() }
    }
    // The native workspace supplier can mount after the additive footer entry.
    const observer = new MutationObserver(attempt)
    let boundary: HTMLElement | null = element.parentElement
    while (boundary && ![...boundary.classList].some(value => value.endsWith('_footerActions'))) boundary = boundary.parentElement
    observer.observe(boundary?.parentElement?.parentElement ?? element.parentElement!, { childList: true, subtree: true })
    attempt()
    return () => { observer.disconnect(); attached?.dispose(); setLayout(null) }
  }, [wide, sectionId])
  useEffect(() => { layout?.setNativeCollapsed(nativeCollapsed) }, [layout, nativeCollapsed])
  useEffect(() => wide ? store.start() : undefined, [wide, store])
  if (!wide) return null
  const groups = new Map<string, CodexThread[]>()
  for (const item of state.threads) { const key = item.cwd.replaceAll('/', '\\').toLowerCase(); groups.set(key, [...groups.get(key) ?? [], item]) }
  const recent = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId)).slice(0, 12)
  const sessionRow = (thread: CodexThread) => <div className="cw-session" key={thread.threadId} data-selected={state.selected?.threadId === thread.threadId || undefined}>
    <button type="button" className="cw-session-main" aria-current={state.selected?.threadId === thread.threadId ? 'page' : undefined}
      title={thread.title + ' · 可拖入主 Agent 引用'} draggable onDragStart={event => writeWorkerDrag(event.dataTransfer, 'codex:' + thread.threadId, thread.title)}
      onClick={() => open(thread)}><span className="cw-session-slot" aria-hidden="true" /><span className="cw-session-title">{thread.title}</span></button>
    <ActivityBadge value={state.activities[thread.threadId]} />
    <span className="cw-session-trailing"><small>{new Date(thread.updatedAt * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</small>
      <a className="cw-session-open" href={'codex://threads/' + thread.threadId} title={'在 Codex 打开：' + thread.title} aria-label={'在 Codex 打开：' + thread.title}><Icon name="external" size={14} /></a>
    </span>
  </div>
  return <section ref={anchor} className="cw-sidebar" data-shared-scroll={!!layout || undefined} aria-label="Codex 工作区">{styles}
    {layout && createPortal(<button type="button" className="cw-group-toggle" aria-label={(nativeCollapsed ? '展开' : '收拢') + layout.nativeLabel}
      aria-expanded={!nativeCollapsed} aria-controls={sectionId + '-native'} onClick={() => setNativeCollapsed(value => !value)}>
      <Icon name={nativeCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
    </button>, layout.toggleMount)}
    <div className="cw-section-head"><button type="button" className="cw-section-toggle" aria-expanded={!codexCollapsed}
      aria-controls={sectionId + '-codex'} onClick={() => setCodexCollapsed(value => !value)}><span>Codex 工作区</span><Icon name={codexCollapsed ? 'chevron-right' : 'chevron-down'} size={14} /></button>
      <button type="button" aria-label="新建提问" title="新建会话" onClick={() => { const target = state.threads[0]; store.newConversation(target?.cwd ?? '', target?.projectName ?? ''); onNew?.() }}><Icon name="plus" size={16} /></button>
      <button type="button" aria-label="刷新 Codex 会话" onClick={() => { void store.refresh() }}><Icon name="refresh" size={16} /></button></div>
    <div className="cw-tree" id={sectionId + '-codex'} hidden={codexCollapsed}>
      {state.error && <p className="cw-hint" role="status">{state.error}</p>}
      {!state.threads.length && !state.error && <p className="cw-hint">{state.loading ? '读取会话…' : '暂无会话，请先同步 Codex 元数据。'}</p>}
      {!!recent.length && <div className="cw-recent" aria-label="最近会话">
        <button type="button" className="cw-project" aria-expanded={!recentClosed} aria-controls={sectionId + '-recent'} onClick={() => setRecentClosed(value => !value)}>
          <Icon name="clock" size={16} /><span>最近</span><Icon name={recentClosed ? 'chevron-right' : 'chevron-down'} size={14} />
        </button>
        <div id={sectionId + '-recent'} hidden={recentClosed}>{recent.map(sessionRow)}</div>
      </div>}
      {[...groups].map(([key, threads]) => <div key={key}>
        <div className="cw-project-head"><button type="button" className="cw-project" title={threads[0]!.cwd} aria-expanded={!closed.has(key)} onClick={() => setClosed(previous => {
          const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next
        })}><Folder /><span>{threads[0]!.projectName}</span></button>
        <button type="button" className="cw-project-action" title="新建提问" aria-label={'在 ' + threads[0]!.projectName + ' 新建提问'} onClick={() => { store.newConversation(threads[0]!.cwd, threads[0]!.projectName); onNew?.() }}><Icon name="plus" size={16} /></button></div>
        {!closed.has(key) && threads.map(sessionRow)}
      </div>)}
      {state.nextOffset !== null && <button type="button" className="cw-more" disabled={state.loading} onClick={() => { void store.refresh(state.query, true) }}>加载更多 · 共 {state.total} 条</button>}
    </div>
    <ChatgptSourceSidebar onNew={() => { store.newConversation('chatgpt', 'ChatGPT · 云端'); onNew?.() }} />
  </section>
}

export function CodexWorkspacePage({ store, openManagedWork }: { store: CodexWorkspaceStore; openManagedWork?(): void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => store.start(), [store])
  const [images, setImages] = useState<{ id: string; src: string; name: string }[]>([]), [uploading, setUploading] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null), uploadGeneration = useRef(0)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const openLink = useCallback((href: string) => { const target = previewTarget(href); if (target) setPreview(target) }, [])
  const selected = state.selected, enabled = selected && state.allowedThreadIds.includes(selected.threadId)
  const draft = selected ? state.drafts[selected.threadId] : undefined
  const question = draft?.text ?? '', error = draft?.error ?? ''
  const setQuestion = (text: string) => { if (selected) store.updateDraft(selected.threadId, { text }) }
  const setError = (error: string) => { if (selected) store.updateDraft(selected.threadId, { error }) }
  const followTail = useRef(true)
  const busy = state.exchanges.some(item => item.threadId === selected?.threadId && item.status === 'pending')
  const history = selected ? state.transcripts[selected.threadId] : undefined
  useEffect(() => { setPreview(null); setImages([]); setUploading(false); uploadGeneration.current++; followTail.current = true; if (content.current) content.current.scrollTop = 0 }, [selected?.threadId])
  useEffect(() => () => { uploadGeneration.current++ }, [])
  useEffect(() => selected ? store.watchTranscript(selected.threadId) : undefined, [selected?.threadId, store])
  const latestExchange = state.exchanges.filter(item => item.threadId === selected?.threadId).at(-1)
  useEffect(() => {
    if (followTail.current && content.current) content.current.scrollTop = content.current.scrollHeight
  }, [selected?.threadId, history?.lastSyncedAt, latestExchange?.requestId, latestExchange?.status])
  const turns = [...history?.turns ?? []]
  const seenTurns = new Set(turns.map(turn => turn.id))
  for (const exchange of state.exchanges.filter(item => item.threadId === selected?.threadId)) {
    const id = exchange.turnId ?? exchange.requestId
    if (seenTurns.has(id)) continue
    turns.push({ id, startedAt: exchange.startedAt ?? 0, status: exchange.status ?? 'completed', messages: [
      { id: exchange.requestId + '-user', role: 'user', text: exchange.question, truncated: false, ...(exchange.images?.length ? { images: exchange.images } : {}) },
      { id: exchange.requestId + '-assistant', role: 'assistant', text: exchange.status === 'pending' ? exchange.delivery ? exchange.delivery.transport === 'desktop_app' ? '已送达原会话，等待处理…' : '已入队，等待原会话处理…' : exchange.submitted ? '请求已受理，正在等待投递回执…' : '正在提交到这条 Codex 会话…' : exchange.status === 'uncertain' ? exchange.error ?? '结果未确认，请检查原会话，避免重复发送。' : exchange.text, truncated: false },
    ] })
  }
  turns.sort((a, b) => a.startedAt - b.startedAt)
  async function attach(files: File[]) {
    if (!selected || !enabled || busy || uploading || !files.length) return
    if (images.length + files.length > 4) { setError('每条消息最多添加 4 张图片。'); return }
    const target = selected.threadId, generation = uploadGeneration.current
    setUploading(true); setError('')
    try {
      for (const file of files) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) throw Error('请选择 10 MB 以内的 PNG、JPEG、GIF 或 WebP 图片。')
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(Error('图片读取失败。')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file) })
        if (generation !== uploadGeneration.current) return
        const response = await fetch('/session-hub/api/codex/upload', { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ threadId: target, dataUrl }) })
        const image = await response.json() as { id: string; src: string; error?: string }
        if (!response.ok) throw Error(image.error ?? '添加图片失败。')
        if (generation !== uploadGeneration.current) return
        setImages(previous => [...previous, { id: image.id, src: image.src, name: file.name }])
      }
    } catch (failure) { if (generation === uploadGeneration.current) setError(failure instanceof Error ? failure.message : '图片上传失败。') }
    finally { if (generation === uploadGeneration.current) setUploading(false) }
  }
  async function ask(event: FormEvent) {
    event.preventDefault(); if (!selected || !enabled || busy || uploading || !question.trim() && !images.length) return
    const attached = images, target = selected.threadId, text = question.trim(), body = JSON.stringify({ threadId: target, question: text, confirmed: true, ...(attached.length ? { images: attached.map(image => image.id) } : {}) })
    const previousRequest = store.getSnapshot().drafts[target]?.request
    const sending = previousRequest?.body === body ? previousRequest : { body, requestId: crypto.randomUUID() }
    store.updateDraft(target, { request: sending })
    const requestId = sending.requestId
    const exchange = { requestId, threadId: target, question: text, text: '', ...(attached.length ? { images: attached.map(image => ({ src: image.src, alt: image.name })) } : {}) }
    store.addExchange({ ...exchange, status: 'pending', submitted: false })
    setQuestion(''); setImages([])
    setError('')
    try {
      const response = await fetch('/session-hub/api/codex/submit', { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(body), requestId }) })
      const reply = await response.json() as { error?: string; requestId?: string; threadId?: string; status?: string }
      if (!response.ok) throw new Error(reply.error ?? '续聊未完成。')
      if (reply.requestId !== requestId || reply.threadId !== target || reply.status !== 'pending') throw new Error('受理回执与发送的请求或会话不匹配。')
      if (store.getSnapshot().exchanges.find(item => item.requestId === requestId)?.status === 'pending') {
        store.addExchange({ ...exchange, status: 'pending', submitted: true }); void store.refreshRequests()
      }
      store.clearDraftRequest(target, requestId)
    } catch (failure) {
      const error = (failure instanceof Error ? failure.message : '连接中断，结果未知。') + ' 请检查原会话，避免重复发送。'
      store.addExchange({ ...exchange, status: 'uncertain', error })
      store.updateDraft(target, { error })
    }
  }
  if (state.newTarget) return <NewCodexConversation key={state.newTarget.cwd} store={store} openManagedWork={openManagedWork} />
  return <main className="cw-page">{styles}
    <header className="cw-page-head"><h1>{selected?.title ?? 'Codex 工作区'}</h1>
      {selected && <ActivityBadge value={state.activities[selected.threadId]} />}
      {selected && <a className="dt-btn dt-btn-outline dt-btn-sm" href={'codex://threads/' + selected.threadId}>在 Codex 打开 ↗</a>}
    </header>
    <div className="cw-main-area"><div className="cw-chat">
    <ConversationIndex container={content} items={turns.map((turn, index) => ({ id: turn.id,
      label: (turn.messages.find(message => message.role === 'user')?.text ?? turn.messages[0]?.text ?? '第 ' + (index + 1) + ' 轮').slice(0, 120) }))} />
    <div className="cw-content" ref={content} onScroll={() => { const node = content.current; if (node) followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
      {!selected && <TargetFinder />}
      {state.error && <p className="dt-error" role="alert">{state.error}</p>}
      {selected ? <><p className="dt-hint">Codex · {selected.projectName} · {selected.cwd}</p>
        <div className="cw-history-tools">
          <Button size="sm" disabled={history?.loading} onClick={() => { void store.loadTranscript(selected.threadId, false, true) }}>刷新会话内容</Button>
          {history?.nextCursor && <Button size="sm" disabled={history.loading} onClick={() => { void store.loadTranscript(selected.threadId, true) }}>加载更早消息</Button>}
          <span className="dt-hint" role="status">{history?.syncPaused ? '后台已暂停内容刷新' : history?.loading ? history.loaded ? '正在更新消息…' : '正在读取会话内容…' : history?.error ? '连接暂不可用，保留上次消息' : history?.lastSyncedAt ? '消息已同步 · ' + new Date(history.lastSyncedAt).toLocaleTimeString() : '等待同步消息'}</span>
        </div>
        {history?.error && <p className="dt-error" role="alert">{history.error}</p>}
        {history?.loaded && !turns.length && <p className="dt-hint">这条会话暂无可展示的消息。</p>}
        {turns.map(turn => <section className="cw-reply" aria-label="会话消息" aria-busy={['pending', 'inProgress', 'in_progress', 'running'].includes(turn.status)} key={turn.id} data-turn-id={turn.id}>
          {turn.messages.map(message => <div key={message.id} className={'cw-message cw-message-' + message.role}>
            {message.role === 'assistant' && ['pending', 'inProgress', 'in_progress', 'running'].includes(turn.status) && <span role="status" className="cw-activity-spinner" aria-label="等待原会话回复" />}
            {message.role === 'assistant' ? <ConversationMarkdown text={message.text} onLink={openLink} /> : message.text}{message.truncated && <small className="cw-message-notice">内容较长，当前仅展示部分；可在 Codex 打开完整消息。</small>}
            {'images' in message && message.images?.map((image, index) => <ConversationImage key={image.src + index} src={image.src} alt={image.alt} />)}
          </div>)}
        </section>)}
      </> : <p className="dt-hint">从左侧 Codex 工作区选择会话。已发现 {state.total} 条会话。</p>}
      {error && <p className="dt-error" role="alert">{error}</p>}
    </div>
    {selected && <form className="cw-composer" onSubmit={ask}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach([...event.dataTransfer.files]) } }}>
      {!!images.length && <div className="cw-composer-images">{images.map(image => <figure key={image.id}>
        <ConversationImage src={image.src} alt={image.name} /><figcaption>{image.name}</figcaption>
        <button type="button" aria-label={'移除图片 ' + image.name} disabled={busy} onClick={() => setImages(previous => previous.filter(item => item.id !== image.id))}>×</button>
      </figure>)}</div>}
      <ReferenceTextarea aria-label="向原 Codex 会话提问" placeholder="向这条 Codex 会话提问，可粘贴图片，@ 引用工程文件夹…" value={question} onChange={setQuestion}
        onPaste={event => { const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); void attach(files) } }}
        maxLength={8000} rows={3} disabled={!enabled || busy} />
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="选择要发送的图片"
        onChange={event => { void attach([...event.target.files ?? []]); event.target.value = '' }} />
      <div><span data-thread-id={selected.threadId}>{enabled ? '直接发送到「' + selected.title + '」，沿用该会话的模型与权限' : '此会话未启用续聊，仅可查看目录或打开原会话。'}</span>
        <Button type="button" disabled={!enabled || busy || uploading} onClick={() => imageInput.current?.click()}>{uploading ? '添加图片中…' : '添加图片'}</Button>
        <ManagedWorkButton workspace={selected.cwd} targetUid={'codex:' + selected.threadId} instruction={question}
          disabled={busy || uploading || !!images.length} onPrepared={openManagedWork} />
        <Button type="submit" variant="primary" disabled={!enabled || busy || uploading || !question.trim() && !images.length}>{busy ? '等待 Codex 回复…' : '发送到原会话'}</Button></div>
    </form>}
    </div>
    {selected && preview && <WorkspacePreview key={selected.threadId} target={preview} threadId={selected.threadId} onClose={() => setPreview(null)} onLink={href => {
      const next = previewTarget(href)
      if (next?.kind === 'file' && preview.kind === 'file' && !/^(?:[a-z]:[\\/]|[\\/])/i.test(next.path)) {
        const directory = preview.path.replace(/[^\\/]+$/, '')
        setPreview({ ...next, path: directory + next.path })
      } else if (next) setPreview(next)
    }} />}
    </div>
  </main>
}

/** A new conversation uses the main conversation surface; the sidebar only navigates. */
function NewCodexConversation({ store, openManagedWork }: { store: CodexWorkspaceStore; openManagedWork?(): void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const target = state.newTarget!
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [images, setImages] = useState<{ dataUrl: string; name: string }[]>([]), [uploading, setUploading] = useState(false), [imageError, setImageError] = useState('')
  const imageInput = useRef<HTMLInputElement>(null), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const requestId = useRef<string>()
  async function attach(files: File[]) {
    if (busy || uploading || error || !files.length || target.cwd === 'chatgpt') return
    setImageError('')
    if (images.length + files.length > 4) { setImageError('每条消息最多添加 4 张图片。'); return }
    setUploading(true)
    try {
      const added: { dataUrl: string; name: string }[] = []
      for (const file of files) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) throw Error('请选择 10 MB 以内的 PNG、JPEG、GIF 或 WebP 图片。')
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(Error('图片读取失败。')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file) })
        added.push({ dataUrl, name: file.name })
      }
      if (mounted.current) setImages(previous => [...previous, ...added])
    } catch (failure) { if (mounted.current) setImageError(failure instanceof Error ? failure.message : '图片添加失败。') }
    finally { if (mounted.current) setUploading(false) }
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    if (busy || uploading || !text.trim() && !images.length || !target.cwd || target.cwd === 'chatgpt') return
    setBusy(true); setError('')
    const id = requestId.current ??= crypto.randomUUID(), question = text.trim()
    try {
      const response = await fetch('/session-hub/api/sidebar/create', { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, target: 'codex', cwd: target.cwd, text: question, ...(images.length ? { images: images.map(image => image.dataUrl) } : {}) }) })
      const result = await response.json()
      if (!response.ok) throw Error(result.error ?? '创建未确认，请检查原会话后再试。')
      if (typeof result.threadId !== 'string' || typeof result.turnId !== 'string') throw Error('会话回执不完整，请检查原会话，避免重复发送。')
      const thread: CodexThread = { provider: 'codex', threadId: result.threadId, title: question.slice(0,100) || '图片提问', cwd: target.cwd, projectName: target.projectName, updatedAt: Math.floor(Date.now()/1000) }
      store.addExchange({ requestId: id, threadId: thread.threadId, turnId: result.turnId, question, text: '', status: 'pending',
        ...(images.length ? { images: images.map(image => ({ src: image.dataUrl, alt: image.name })) } : {}) })
      if (mounted.current && store.getSnapshot().newTarget === target) store.select(thread)
      void store.refresh()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '创建结果未知，请检查原会话，避免重复发送。') }
    finally { if (mounted.current) setBusy(false) }
  }
  return <main className="cw-page">{styles}
    <header className="cw-page-head"><h1>新会话</h1><span>{target.projectName}</span></header>
    <div className="cw-main-area"><div className="cw-chat">
      <div className="cw-content">
        <p className="dt-hint">{target.cwd === 'chatgpt' ? '普通 ChatGPT 云端新建尚未接通。' : target.cwd}</p>
        {busy && <div className="cw-message cw-message-user">{text}<p role="status">正在创建 Codex 会话并发送…</p></div>}
        {error && <p className="dt-error" role="alert">{error}</p>}
      </div>
      <form className="cw-composer" onSubmit={send} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach([...event.dataTransfer.files]) } }}>
        {!!images.length && <div className="cw-composer-images">{images.map((image, index) => <figure key={index}>
          <ConversationImage src={image.dataUrl} alt={image.name} /><figcaption>{image.name}</figcaption>
          <button type="button" aria-label={'移除图片 ' + image.name} disabled={busy || uploading} onClick={() => setImages(previous => previous.filter((_, position) => position !== index))}>×</button>
        </figure>)}</div>}
        {imageError && <p role="alert">{imageError}</p>}
        <ReferenceTextarea autoFocus aria-label="向新 Codex 会话提问" placeholder="输入问题，可粘贴图片，@ 引用工程文件夹…" value={text} maxLength={8000} rows={3} disabled={busy || !!error} onChange={setText}
          onPaste={event => { const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); void attach(files) } }} />
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="选择要发送的图片"
          onChange={event => { void attach([...event.target.files ?? []]); event.target.value = '' }} />
        <div><select aria-label="新会话项目" value={target.cwd} disabled={busy || !!error} onChange={event => {
          const row = state.threads.find(row => row.cwd === event.target.value)
          if (row) store.newConversation(row.cwd, row.projectName)
        }}>{target.cwd === 'chatgpt' && <option value="chatgpt">ChatGPT · 云端</option>}{[...new Map(state.threads.map(row => [row.cwd, row.projectName]))].map(([cwd,name]) => <option key={cwd} value={cwd}>{name}</option>)}</select>
        <Button type="button" disabled={busy || uploading || !!error || target.cwd === 'chatgpt'} onClick={() => imageInput.current?.click()}>{uploading ? '添加图片中…' : '添加图片'}</Button>
        <ManagedWorkButton workspace={target.cwd} instruction={text} disabled={busy || uploading || !!error || !!images.length || target.cwd === 'chatgpt'} onPrepared={openManagedWork} />
        <Button type="submit" variant="primary" disabled={busy || uploading || !!error || !text.trim() && !images.length || !target.cwd || target.cwd === 'chatgpt'}>{busy ? '发送中…' : '发送'}</Button></div>
      </form>
    </div></div>
  </main>
}
