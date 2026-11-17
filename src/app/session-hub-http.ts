import { GraphifyService } from './graphify-service.ts'
import type { RoleModel } from '../policy.ts'
/** Loopback-only session coordination API, sharing the panel's same-origin request guard. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { workerReferences, resolveWorkerReference } from './worker-references.ts'
import type { ChatgptSource } from './chatgpt-source.ts'
import type { CloudWorkers } from './cloud-workers.ts'
import { sameOrigin } from './http.ts'
import { SessionHub, TaskRequestSchema, SessionCardSchema } from './session-hub.ts'
import { ContextCatalog, SearchSchema } from './context-catalog.ts'
import type { SessionRouting } from './session-router.ts'
import type { LocalWork } from './local-work.ts'
import { TargetResolver, ResolveTargetSchema } from './target-resolver.ts'
import { ProjectSearchSchema, TargetSearchSchema } from './context-targets.ts'
import { CodexQuestionSchema, CodexRelay, CodexRelayError } from './codex-relay.ts'
import { readCodexTranscript, TranscriptQuery } from './codex-transcript.ts'
import { PreviewQuery, readWorkspacePreview } from './workspace-preview.ts'
import { KnowledgeIndex } from './knowledge-graph.ts'
import type { SessionActivities } from './session-activity.ts'
import type { DeferredWork } from './deferred-work.ts'
import { queueCodexUserMessage } from './codex-user-queue.ts'
import { continueDesktopCodex } from './codex-desktop-relay.ts'
import { ConversationMedia } from './conversation-media.ts'
import { CodexRpc } from '../executor/codex-rpc.ts'
import { dirname, join, win32 } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { KnowledgeLibraryReader, readLibraryEvidence } from './knowledge-library.ts'
import { probeVision } from './vision-probe.ts'
import { folderReferences, resolveFolderReference } from './folder-references.ts'
import type { ManagedWork } from './managed-work.ts'
import { BotTicketListQuery, BotTicketDetailQuery, type BotTicketView } from './bot-ticket-view.ts'

export function registerSessionHub(ctx: Context, hub: SessionHub, catalog?: ContextCatalog, router?: SessionRouting, work?: LocalWork,
  codex?: CodexRelay, resolver?: TargetResolver, knowledgeCachePath?: string, activities?: SessionActivities, deferred?: DeferredWork, chatgpt?: ChatgptSource, cloudWorkers?: CloudWorkers, graphifyModel?: () => RoleModel | null, managed?: ManagedWork, botTicketView?: BotTicketView): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Session coordination requires loopback binding')
  const knowledge = catalog ? new KnowledgeIndex(catalog, undefined, knowledgeCachePath) : undefined
  const library = new KnowledgeLibraryReader(knowledgeCachePath ? join(dirname(knowledgeCachePath), 'knowledge-library-organized.json') : undefined)
  const graphifyRoot=process.env.DSH_GRAPHIFY_ROOT
  const graphify=knowledgeCachePath&&graphifyRoot&&graphifyModel?new GraphifyService(ctx,library,graphifyRoot,graphifyModel,dirname(knowledgeCachePath)):undefined
  const graphifyViewer=graphify?.registerViewer()
  const media = new ConversationMedia()
  const creations = new Map<string, { body: string; result: Promise<unknown> }>()
  const connections = new Map<CodexRpc, () => Promise<void>>()
  let probingVision = false
  // A typed question is user input. The desktop agent-to-agent tool remains reserved for delegated work.
  const relay = codex ?? (catalog ? new CodexRelay(() => catalog.targetEntries().filter(entry => !entry.archived).map(entry => entry.threadId),
    (question, onQueued) => continueDesktopCodex(question, {
      queue: () => queueCodexUserMessage(question, question.images?.length ? media.uploads(question.threadId, question.images) : []),
      onQueued,
    }), 'native_user_queue') : new CodexRelay((process.env.DSH_CODEX_RELAY_THREAD_IDS ?? '').split(',').map(id => id.trim()).filter(id => z.string().uuid().safeParse(id).success)))
  // Legacy transcript indexing is explicit only. Graphify reads recovered derivatives, never raw histories.
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/session-hub/api', handler: async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    if (!sameOrigin(req, ctx.webServer.port)) { reply(403, { error: 'Same-origin management request required' }); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/session-hub/api'.length)
    const body = async (maxBytes = 128 * 1024) => {
      const buffers: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); size += buffer.length
        if (size > maxBytes) throw new Error('Request body is too large')
        buffers.push(buffer)
      }
      return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown
    }
    try {
      const authenticatedBridge = () => {
        const expected = process.env.DSH_BOT_BRIDGE_TOKEN
        const presented = req.headers['x-superagent-bot-token']
        return !!expected && typeof presented === 'string' &&
          Buffer.byteLength(expected) === Buffer.byteLength(presented) &&
          timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
      }
      if (req.method === 'POST' && ['/managed-work/confirm', '/managed-work/cancel'].includes(path) && !authenticatedBridge()) {
        reply(403, { error: '确认或取消工作需要管理凭据，请在面板填写或使用已认证的 Bot 草案卡。' }); return
      }
      // Stable read-only Ticket contract for long-lived Bot UIs.
      if (botTicketView && req.method === 'GET' && path === '/bot/ticket-changes') {
        const { after } = z.object({ after: z.coerce.number().int().min(-1).default(-1) }).strict()
          .parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        const disconnect = new AbortController()
        res.once('close', () => disconnect.abort())
        const revision = await botTicketView.waitForChange(after, disconnect.signal)
        if (!disconnect.signal.aborted) {
          if (revision === null) reply(503, { error: 'Ticket observers are busy' })
          else reply(200, { revision })
        }
        return
      }
      if (botTicketView && req.method === 'GET' && path === '/bot/tickets') {
        const query = BotTicketListQuery.parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200, botTicketView.list(query)); return
      }
      if (botTicketView && req.method === 'GET' && path === '/bot/ticket') {
        const query = BotTicketDetailQuery.parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        const detail = botTicketView.detail(query)
        if (!detail) { reply(404, { error: 'unknown_or_unindexed_ticket' }); return }
        reply(200, detail); return
      }
      if (managed && ['/bot/confirm-work', '/bot/cancel-work', '/bot/confirm-reviewed-work', '/bot/draft'].includes(path)) {
        if (req.headers.origin !== undefined || !authenticatedBridge()) {
          reply(403, { error: 'ManagedWork Bot actions require an authenticated host bridge' }); return
        }
        if (req.method === 'GET' && path === '/bot/draft') {
          const id = z.string().uuid().parse(new URL(req.url!, 'http://localhost').searchParams.get('id'))
          const proposal = managed.draft(id, true)
          if (!proposal) { reply(404, { error: '草案不存在。' }); return }
          reply(200, { proposal, options: managed.options() }); return
        }
        if (req.method !== 'POST' || path === '/bot/draft') { reply(405, { error: 'Method not allowed' }); return }
        if (path === '/bot/confirm-reviewed-work') {
          reply(200, managed.summary(await managed.confirm(await body(4096)))); return
        }
        reply(200, await managed.botAction(path === '/bot/confirm-work' ? 'confirm' : 'cancel', await body(4096))); return
      }
      if (managed && req.method === 'GET' && path === '/managed-work/options') { reply(200, managed.options()); return }
      if (managed && req.method === 'GET' && path === '/managed-work/drafts') {
        const pending = new URL(req.url!, 'http://localhost').searchParams.get('pending') === '1'
        reply(200, { options: managed.options(), proposals: managed.summaries(pending) }); return
      }
      if (managed && req.method === 'GET' && path === '/managed-work/draft') {
        const id = z.string().uuid().parse(new URL(req.url!, 'http://localhost').searchParams.get('id'))
        const proposal = managed.draft(id)
        if (!proposal) { reply(404, { error: '草案不存在。' }); return }
        reply(200, { proposal, options: managed.options() }); return
      }
      if (managed && path === '/managed-work' && req.method === 'GET') { reply(200, managed.list()); return }
      if (managed && path === '/managed-work/prepare' && req.method === 'POST') { reply(200, managed.prepare(await body())); return }
      if (managed && path === '/managed-work/confirm' && req.method === 'POST') { reply(200, await managed.confirm(await body())); return }
      if (managed && path === '/managed-work/cancel' && req.method === 'POST') {
        const input = z.object({ id: z.string().uuid() }).strict().parse(await body())
        reply(200, managed.cancel(input.id)); return
      }
      if (resolver && req.method === 'GET' && path === '/context/folders') {
        const input = z.object({ query: z.string().max(500).default('') }).strict()
          .parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200, { items: folderReferences(resolver.targets, input.query) }); return
      }
      if (resolver && req.method === 'GET' && path === '/context/folder') {
        const input = z.object({ uid: z.string().min(1).max(200) }).strict()
          .parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200, { reference: resolveFolderReference(resolver.targets, input.uid) }); return
      }
      if (path === '/diagnostics/vision' && req.method === 'POST') {
        if (probingVision) { reply(409, { error: '识图探针正在运行，请勿重复提交。' }); return }
        probingVision = true
        try { reply(200, await probeVision({ llm: ctx.llm, attachments: ctx.get('attachments') }, await body())) } finally { probingVision = false }
        return
      }
      if (path === '/sidebar/create' && req.method === 'POST') {
        const input = z.object({ requestId: z.string().uuid(), target: z.enum(['codex', 'chatgpt']), cwd: z.string().max(600), text: z.string().trim().max(8000),
          images: z.array(z.string().max(14 * 1024 * 1024)).max(4).optional() }).strict()
          .refine(value => !!value.text || !!value.images?.length, '请填写消息或添加图片。').parse(await body(57 * 1024 * 1024))
        if (input.target === 'chatgpt') { reply(501, { error: '当前 ChatGPT 桥接尚未验证云端新建能力，未创建或发送。' }); return }
        const workspace = catalog?.targetEntries().find(row => !row.archived && win32.normalize(row.workspace).toLowerCase() === win32.normalize(input.cwd).toLowerCase())?.workspace
        if (!workspace) throw Error('请选择已有 Codex 项目目录')
        const encoded = createHash('sha256').update(JSON.stringify(input)).digest('hex'), prior = creations.get(input.requestId)
        if (prior && prior.body !== encoded) throw Error('requestId 已用于不同的新建内容；未重复发送。')
        if (!creations.has(input.requestId)) {
          if (creations.size >= 1000) throw Error('本次运行的新建请求已达上限，请重启服务')
          creations.set(input.requestId, { body: encoded, result: (async () => {
            const connection = new CodexRpc()
            let threadId = ''; const imageIds: string[] = []
            const cleanup = () => media.releaseUploads(input.requestId, imageIds).catch(() => {})
            connections.set(connection, cleanup)
            connection.subscribe(event => {
              if (event.method === 'connection/lost' || event.method === 'turn/completed' && event.params?.threadId === threadId) {
                connections.delete(connection); void connection.close().finally(cleanup)
              }
            })
            try {
              for (const dataUrl of input.images ?? []) imageIds.push((await media.upload(input.requestId, dataUrl, workspace)).id)
              await connection.initialize()
              const result = await connection.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'dsh_sidebar', selectedCapabilityRoots: [], developerInstructions: 'No Computer Use, desktop input, external messages, or private-history reads.' })
              threadId = z.string().uuid().parse(result.thread?.id)
              if (win32.normalize(result.thread.cwd).toLowerCase() !== win32.normalize(workspace).toLowerCase()) throw Error('创建回执目录不匹配')
              catalog!.syncDesktop([{ id: threadId, cwd: workspace, title: input.text.slice(0, 100) || '图片提问', updatedAt: Math.floor(Date.now()/1000) }])
              const turn = await connection.request('turn/start', { threadId, input: [
                ...(input.text ? [{ type: 'text', text: input.text, text_elements: [] }] : []),
                ...media.uploads(input.requestId, imageIds).map(path => ({ type: 'localImage', path }))] })
              const turnId = z.string().min(1).parse(turn.turn?.id)
              return { threadId, turnId, cwd: workspace, status: 'accepted', model: result.model ?? result.thread?.model }
            } catch {
              connections.delete(connection); await connection.close(); await cleanup()
              throw Error('创建或发送未确认' + (threadId ? '，已创建会话：' + threadId : '') + '；请检查原生会话后再新建，系统不会自动重发。')
            }
          })() })
        }
        reply(200, await creations.get(input.requestId)!.result); return
      }
      if (cloudWorkers) {
        if (path === '/workers/cloud' && req.method === 'GET') { reply(200, cloudWorkers.view()); return }
        if (path === '/workers/cloud' && req.method === 'POST') { reply(200, cloudWorkers.register(await body())); return }
        if (path === '/workers/cloud/prepare' && req.method === 'POST') { reply(200, cloudWorkers.prepare(await body())); return }
        const worker = /^\/workers\/cloud\/([0-9a-f-]{36})$/i.exec(path)
        if (worker && req.method === 'PUT') { reply(200, cloudWorkers.enable(worker[1]!, await body())); return }
        const message = /^\/workers\/cloud\/messages\/([0-9a-f-]{36})\/(send|result|cancel)$/i.exec(path)
        if (message && req.method === 'POST') {
          const input = await body()
          reply(200, message[2] === 'send' ? await cloudWorkers.send(message[1]!, input)
            : message[2] === 'result' ? cloudWorkers.result(message[1]!, input) : cloudWorkers.cancel(message[1]!)); return
        }
      }
      if (chatgpt && path === '/context/chatgpt-source') {
        if (req.method === 'GET') { reply(200, chatgpt.view()); return }
        if (req.method === 'PUT') { reply(200, chatgpt.configure(await body())); return }
      }
      if (chatgpt && path === '/context/chatgpt-check' && req.method === 'POST') { await chatgpt.check(); reply(200, chatgpt.view()); return }
      if (chatgpt && path === '/context/chatgpt-sync' && req.method === 'POST') { await chatgpt.sync(); reply(200, chatgpt.view()); return }
      if (chatgpt && path === '/context/chatgpt-threads' && req.method === 'GET') {
        const input = z.object({ query: z.string().max(500).default(''), offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(30) }).strict()
          .parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200, chatgpt.list(input.query, input.offset, input.limit)); return
      }
      if (resolver && req.method === 'GET' && path === '/context/references') {
        const input = z.object({ query: z.string().max(500).default(''), limit: z.coerce.number().int().min(1).max(30).default(12) })
          .strict().parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        const local = workerReferences(resolver.targets, input.query, input.limit)
        const cloud = chatgpt?.list(input.query, 0, input.limit)
        reply(200, { items: [...(cloud?.threads.map(row => chatgpt!.reference('chatgpt:' + row.id)) ?? []), ...local.items],
          total: local.total + (cloud?.total ?? 0) }); return
      }
      if (resolver && req.method === 'GET' && path === '/context/reference') {
        const input = z.object({ uid: z.string().min(1).max(200) }).strict()
          .parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200, { reference: input.uid.startsWith('chatgpt:') && chatgpt ? chatgpt.reference(input.uid) : resolveWorkerReference(resolver.targets, input.uid) }); return
      }
      if (req.method === 'GET' && path === '/knowledge-library') { reply(200, library.overview()); return }
      if (req.method === 'GET' && path === '/knowledge-tree') { reply(200, library.tree()); return }
      if(graphify&&path==='/graphify/status'&&req.method==='GET'){reply(200,graphify.status());return}
      if(graphify&&path==='/graphify/build'&&req.method==='POST'){z.object({confirmed:z.literal(true)}).strict().parse(await body());reply(200,await graphify.build());return}
      if(graphify&&path==='/graphify/corpus/pause'&&req.method==='POST'){z.object({confirmed:z.literal(true)}).strict().parse(await body());reply(200,graphify.corpus.pause());return}
      if(graphify&&path==='/graphify/review'&&req.method==='POST'){const input=z.object({confirmed:z.literal(true),maxBatches:z.number().int().min(1).max(5000).optional()}).strict().parse(await body());if(graphify.status().jobs.status==='running'){reply(409,{error:'Wait for corpus collection before global review'});return}reply(202,await graphify.review.start(input.maxBatches));return}
      if(graphify&&path==='/graphify/review/pause'&&req.method==='POST'){z.object({confirmed:z.literal(true)}).strict().parse(await body());reply(200,graphify.review.pause());return}
      if(graphify&&path==='/graphify/test'&&req.method==='POST'){const input=z.object({confirmed:z.literal(true),profile:z.enum(['luna-24','deepseek-50','deepseek-corpus']).optional(),maxBatches:z.number().int().min(1).max(5000).optional()}).strict().parse(await body());reply(202,await graphify.start(input.profile,input.maxBatches));return}
      if (req.method === 'GET' && path === '/knowledge-classified') { reply(200, library.classifiedGraph()); return }
      if (req.method === 'GET' && path === '/knowledge-classified/evidence') {
        const query=z.object({source:z.string().max(100),target:z.string().max(100),offset:z.coerce.number().int().min(0).default(0)}).strict().parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        reply(200,library.relationEntries(query.source,query.target,query.offset));return
      }
      if (req.method === 'GET' && (path === '/knowledge-library/entries' || path === '/knowledge-library/threads')) {
        const query = Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams)
        reply(200, path.endsWith('/entries') ? library.entries(query) : library.threads(query)); return
      }
      if (req.method === 'GET' && path === '/knowledge-library/source') {
        const query = z.object({ id: z.string().min(1).max(160) }).strict().parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        const entry = library.entry(query.id)
        if (!entry) { reply(404, { error: '未找到对应的问答来源。' }); return }
        try { reply(200, await readLibraryEvidence(entry)) } catch { reply(503, { error: '此轮原始内容暂时不可读取，请在原会话回查。' }) }
        return
      }
      if (catalog && req.method === 'POST' && path === '/codex/upload') {
        const input = z.object({ threadId: z.string().uuid(), dataUrl: z.string().max(14 * 1024 * 1024) }).strict().parse(await body(15 * 1024 * 1024))
        const selected = catalog.targetEntries().find(entry => entry.threadId === input.threadId && !entry.archived)
        if (!selected) throw Error('请选择当前目录中的会话后添加图片。')
        reply(200, await media.upload(input.threadId, input.dataUrl, selected.workspace)); return
      }
      if (activities && req.method === 'POST' && path === '/activity/query') {
        const input = z.object({ threadIds: z.array(z.string().uuid()).max(100) }).strict().parse(await body())
        reply(200, { sessions: activities.snapshot(input.threadIds) }); return
      }
      if (activities && req.method === 'POST' && path === '/activity/observe') {
        const observed = activities.publish(await body()); await deferred?.tick(); reply(200, observed); return
      }
      if (activities && req.method === 'GET' && path.startsWith('/activity/')) {
        reply(200, await activities.get(decodeURIComponent(path.slice('/activity/'.length)))); return
      }
      if (deferred && req.method === 'GET' && path === '/deferred-work') { reply(200, deferred.list()); return }
      if (deferred && req.method === 'POST' && path === '/deferred-work') { const row = deferred.enqueue(await body()); await deferred.tick(); reply(202, row); return }
      if (deferred && req.method === 'POST' && path === '/deferred-work/cancel') {
        const input = z.object({ eventId: z.string().min(1).max(80) }).strict().parse(await body()); reply(200, deferred.cancel(input.eventId)); return
      }
      if (knowledge && path === '/knowledge' && req.method === 'GET') { reply(200, knowledge.snapshot()); return }
      if (knowledge && path === '/knowledge' && req.method === 'POST') { reply(202, knowledge.start(await body())); return }
      if (knowledge && path === '/knowledge/cancel' && req.method === 'POST') { await body(); reply(200, knowledge.cancel()); return }
        if (resolver && req.method === 'POST' && path === '/context/resolve') { reply(200, await resolver.resolve(ResolveTargetSchema.parse(await body()))); return }
        if (resolver && req.method === 'POST' && path === '/context/projects') { reply(200, { projects: resolver.targets.projects(ProjectSearchSchema.parse(await body())) }); return }
        if (resolver && req.method === 'POST' && path === '/context/sessions') { reply(200, { sessions: resolver.targets.search(TargetSearchSchema.parse(await body())) }); return }
        if (resolver && req.method === 'POST' && path === '/context/select') {
          const selected = z.object({ uid: z.string().min(1).max(200), fingerprint: z.string().length(64) }).strict().parse(await body())
          reply(200, { target: resolver.select(selected), action: 'selected', execution: 'not_submitted' }); return
        }
      if (req.method === 'GET' && path === '/codex/capabilities') { reply(200, relay.capabilities()); return }
      if (catalog && req.method === 'GET' && path === '/codex/preview') {
        const query = PreviewQuery.parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        const thread = catalog.threads({ query: query.threadId, limit: 1, includeArchived: true, includeInternal: true }).threads.find(thread => thread.threadId === query.threadId)
        if (!thread) { reply(404, { error: '此会话不在当前 Codex 工作区目录中。' }); return }
        reply(200, await readWorkspacePreview(thread.cwd, query.path)); return
      }
      if (catalog && req.method === 'GET' && path === '/codex/transcript') {
        const query = TranscriptQuery.parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        if (!catalog.threads({ query: query.threadId, limit: 1, includeArchived: true, includeInternal: true }).threads.some(thread => thread.threadId === query.threadId)) {
          reply(404, { error: '此会话不在当前 Codex 工作区目录中。' }); return
        }
        const selected = catalog.threads({ query: query.threadId, limit: 1, includeArchived: true, includeInternal: true }).threads.find(thread => thread.threadId === query.threadId)!
        reply(200, await readCodexTranscript(query, undefined, query.progress ? {} : { image: source => media.register(query.threadId, source, selected.cwd) })); return
      }
      if (catalog && req.method === 'GET' && path === '/codex/media') {
        const query = z.object({ threadId: z.string().uuid(), id: z.string().uuid() }).strict().parse(Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams))
        if (!catalog.targetEntries().some(entry => entry.threadId === query.threadId)) throw Error('Unknown session')
        const image = await media.read(query.threadId, query.id)
        res.writeHead(200, { 'content-type': image.type, 'content-length': image.bytes.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); res.end(image.bytes); return
      }
      if (req.method === 'POST' && path === '/codex/submit') {
        const input = CodexQuestionSchema.parse(await body())
        const result = relay.ask(input)
        void result.catch(() => {})
        reply(202, { requestId: input.requestId, threadId: input.threadId, status: 'pending' }); return
      }
      const requestStatus = /^\/codex\/requests\/([0-9a-f-]{36})$/i.exec(path)
      if (req.method === 'GET' && requestStatus) { reply(200, relay.status(requestStatus[1]!)); return }
      if (req.method === 'POST' && path === '/codex/ask') { reply(200, await relay.ask(await body())); return }
      if (work && req.method === 'POST' && (path === '/tasks' || path === '/clear-demo' || /^\/tasks\/[^/]+\/receipts$/.test(path))) {
        reply(409, { error: 'Legacy SessionHub tasks are read-only. Submit /work and read original Engine Tickets instead.' }); return
      }
      if (work && req.method === 'POST' && path === '/work') { reply(200, work.submit(await body())); return }
      if (work && req.method === 'GET' && path.startsWith('/work/')) { reply(200, work.result(decodeURIComponent(path.slice('/work/'.length)))); return }
      if (router && req.method === 'POST' && path === '/recommend') {
        const request = TaskRequestSchema.parse(await body()), state = hub.snapshot()
        const cards = state.sessions.filter(card => (!request.target.uid || card.uid === request.target.uid)
          && (!request.target.projectId || card.projectId === request.target.projectId) && (!request.target.mode || card.mode === request.target.mode))
        reply(200, { decision: await router.recommend({ request, cards, tasks: [] }), action: 'recommended_not_sent' }); return
      }
      if (req.method === 'GET' && path === '/snapshot') { reply(200, hub.snapshot()); return }
      if (req.method === 'POST' && path === '/sessions') { reply(200, hub.register(await body())); return }
      if (req.method === 'POST' && path === '/tasks') { reply(200, await hub.submitRouted(await body())); return }
      // Imported historical metadata never becomes a Ticket merely because it was indexed.
      if (catalog && req.method === 'GET' && path === '/context/stats') { reply(200, catalog.stats()); return }
      if (catalog && req.method === 'GET' && path === '/context/threads') {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        reply(200, catalog.threads(Object.fromEntries(params))); return
      }
      if (catalog && req.method === 'POST' && path === '/context/import') { reply(200, catalog.importMetadata(await body())); return }
      if (catalog && req.method === 'POST' && path === '/context/reconcile') { reply(200, catalog.reconcile(await body())); return }
      if (catalog && req.method === 'POST' && path === '/context/organization') { reply(200, catalog.importOrganization(await body())); return }
      if (catalog && req.method === 'POST' && path === '/context/experience') { reply(200, catalog.importExperience(await body())); return }
      if (catalog && req.method === 'POST' && path === '/context/search') {
        reply(200, { matches: catalog.search(await body()) }); return
      }
      if (catalog && req.method === 'GET' && path === '/context/fixtures') {
        // Local benchmark harness only; no chat turns are read or exported.
        reply(200, { cases: catalog.benchmarkFixtures(120) }); return
      }
      if (catalog && req.method === 'GET' && path === '/context/benchmark') {
        reply(200, catalog.metadataBenchmark(120)); return
      }
      if (catalog && req.method === 'POST' && path === '/context/candidates') {
        reply(200, catalog.frozenCandidates(SearchSchema.parse(await body()))); return
      }
      // Read-only replay over caller-frozen evidence, without touching catalog or task state.
      if (router && req.method === 'POST' && path === '/context/evaluate') {
        const input = z.object({ query: z.string().trim().min(1).max(2000),
          cards: z.array(SessionCardSchema).max(30),
          purpose: z.enum(['lookup', 'task']).default('lookup') }).strict().parse(await body())
        const request = TaskRequestSchema.parse({ requestId: 'frozen-context-evaluation', instruction: input.query })
        reply(200, { decision: await router.recommend({ request, cards: input.cards, tasks: [], purpose: input.purpose }) }); return
      }
      if (catalog && router && req.method === 'POST' && path === '/context/route') {
        const query = SearchSchema.parse(await body())
        const cards = catalog.routingCandidates(query)
        const request = TaskRequestSchema.parse({ requestId: 'context-only-probe', instruction: query.query })
        const decision = await router.recommend({ cards, request, tasks: [], purpose: 'lookup' })
        reply(200, { decision, candidates: cards.map(card => ({
          uid: card.uid, title: card.title, projectName: card.projectName
        })) })
        return
      }
      const receipt = /^\/tasks\/([^/]+)\/receipts$/.exec(path)
      if (req.method === 'POST' && receipt) { reply(200, hub.receipt(decodeURIComponent(receipt[1]!), await body())); return }
      if (req.method === 'POST' && path === '/clear-demo') { reply(200, hub.clearDemo()); return }
      reply(404, { error: 'Unknown session operation' })
    } catch (error) {
      if (error instanceof CodexRelayError) { reply(409, { error: error.message, code: error.code, stage: error.stage }); return }
      if (error instanceof z.ZodError) { reply(400, { error: 'Invalid session data', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); return }
      reply(400, { error: error instanceof Error ? error.message : 'Session operation failed' })
    }
  } })
  return () => {
    for (const [connection, cleanup] of connections) void connection.close().finally(cleanup)
    graphifyViewer?.(); knowledge?.cancel(); dispose()
  }
}
