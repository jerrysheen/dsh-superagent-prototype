/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { knowledgeTools } from './knowledge-tools.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { SessionHub } from './session-hub.ts'
import { ContextCatalog } from './context-catalog.ts'
import { SessionRouter } from './session-router.ts'
import { registerSessionHub } from './session-hub-http.ts'
import { LocalWork, localWorkKind, workspaceKey } from './local-work.ts'
import { ContextTargets } from './context-targets.ts'
import { ManagedWork } from './managed-work.ts'
import { workTitle } from './work-instruction.ts'
import { TargetResolver } from './target-resolver.ts'
import { CodexExecutor } from '../executor/codex.ts'
import { DesktopWorker } from '../executor/desktop-worker.ts'
import { NativeRouter } from '../executor/native-router.ts'
import { SessionActivities } from './session-activity.ts'
import { DeferredWork } from './deferred-work.ts'
import { DesktopActivityClient, DesktopActivityObserver, DesktopChatgptClient, DesktopChatClient, DesktopProjectClient, DesktopWorkClient } from './desktop-activity.ts'
import { ChatgptSource } from './chatgpt-source.ts'
import { CloudWorkers } from './cloud-workers.ts'
import { localExecution, localPermission, validateLocalInput, validateLocalWorkspace } from '../executor/local-dsh.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private masterChatOpening?: Promise<{ sessionId: string }>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  private sessionHub?: SessionHub
  private native?: NativeRouter
  private deferred?: DeferredWork
  private desktopObserver?: DesktopActivityObserver
  private chatgptSource?: ChatgptSource
  private cloudWorkers?: CloudWorkers
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const local = machine.coordinationMode === 'sessions'
      const deployed = () => local ? environmentOf({ sources: this.sources, settings: store.settings() }) : setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu, local)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      if (local) this.disposers.push(sources.register(localWorkKind))
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        masterChatOnly: local && !machine.sessionExecution, managedWork: local,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        ...(local ? {
          permission: (ticket?: Ticket) => ticket ? localPermission(store.triggers.get(ticket.origin.triggerId)) : 'read-only' as const,
          beforePrompt: async (ticket?: Ticket) => {
            if (!machine.sessionExecution) throw new Error('Local Engine execution is disabled')
            if (ticket) {
              const origin = store.triggers.get(ticket.origin.triggerId)
              for (const id of ticket.origin.triggerIds) validateLocalInput(origin, store.triggers.get(id))
              for (const input of ticket.inputs) if (input.kind === 'trigger' && !input.context) validateLocalInput(origin, store.triggers.get(input.triggerId))
              await validateLocalWorkspace(ticket, origin, sources)
            }
          },
        } : {}),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent)
          .filter(tool => !local || ['orchestrator_read', 'read_knowledge', 'list_cloud_workers', 'prepare_cloud_question', 'get_cloud_question_receipt',
            'search_projects', 'search_sessions', 'get_context_card', 'get_work_binding', 'get_session_activity', 'list_deferred_work', 'list_managed_work', 'read_project_progress', 'prepare_managed_work'].includes(tool.name)
            || machine.sessionExecution && ['orchestrator_route', 'orchestrator_ticket_retry', 'orchestrator_ticket_request_status', 'orchestrator_ticket_note',
              'orchestrator_eval', 'orchestrator_eval_read', 'orchestrator_eval_decide'].includes(tool.name)) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      const validateNative = async (ticket: Ticket) => {
        if (!machine.sessionExecution || runtime.paused()) throw Error('Native execution is paused or disabled')
        const origin = store.triggers.get(ticket.origin.triggerId)
        for (const id of ticket.origin.triggerIds) validateLocalInput(origin, store.triggers.get(id))
        for (const input of ticket.inputs) if (input.kind === 'trigger' && !input.context) validateLocalInput(origin, store.triggers.get(input.triggerId))
        await validateLocalWorkspace(ticket, origin, sources)
      }
      const boundNative = (binding: import('../executor/codex-state.ts').CodexBinding, ticket: Ticket) => {
        const timestamp = Math.floor(Date.now() / 1000)
        if (new ContextCatalog(store).targetEntries().some(card => card.threadId === binding.threadId)) return
        new ContextCatalog(store).importMetadata({ entries: [{ provider: 'codex', nativeThreadId: binding.threadId,
          cwd: binding.workspace, title: ticket.title, sourceKind: binding.transport === 'desktop' ? 'vscode' : 'appServer', archived: false, createdAt: timestamp, updatedAt: timestamp }] })
      }
      const background = local ? new CodexExecutor({ store,
        publish: async binding => {
          const pipe = process.env.DSH_ACTIVITY_PIPE_PATH, caller = process.env.DSH_ACTIVITY_CALLER_THREAD_ID
          if (!pipe || !caller) throw Error('桌面项目连接器未配置；当前仅在 Codex 后台执行。')
          const client = new DesktopProjectClient(pipe, caller)
          try { return await client.publish(binding.threadId, binding.workspace) } finally { client.close() }
        },
        model: () => store.settings().executor.codexModel ?? undefined,
        validate: validateNative,
        instruction: () => prompts.compose(prompts.current().config, 'worker'),
        bound: boundNative,
      }) : undefined
      const native = background ? this.native = new NativeRouter(store, background, new DesktopWorker({ store, validate: validateNative, bound: boundNative,
        client: () => {
          const pipe = process.env.DSH_ACTIVITY_PIPE_PATH, caller = process.env.DSH_ACTIVITY_CALLER_THREAD_ID
          if (!pipe || !caller) throw Error('桌面 workspace 连接器未连接；未派发，不会回退后台执行。')
          return new DesktopWorkClient(pipe, caller)
        } })) : undefined
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        ...(native ? { native } : {}),
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        ...(local ? { workspace: {
          prepare: (ticket: Ticket) => {
            const origin = store.triggers.get(ticket.origin.triggerId)
            for (const id of ticket.origin.triggerIds) validateLocalInput(origin, store.triggers.get(id))
            return localExecution(ticket, origin)
          },
          validate: (ticket: Ticket) => validateLocalWorkspace(ticket, store.triggers.get(ticket.origin.triggerId), sources),
        } } : {}),
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return local ? machine : setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => {
        const value = settingsPolicy(store.settings(), sources)
        return local && !machine.sessionExecution ? { ...value, paused: true } : value
      }
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => local ? !!machine.sessionExecution : setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        ...(local ? { contextTools: new ContextTargets(new ContextCatalog(store), store).tools() } : {}),
        ...(local ? { validateAttach: (ticketId: string, triggerId: string) => {
          const ticket = store.tickets.get(ticketId)
          validateLocalInput(ticket ? store.triggers.get(ticket.origin.triggerId) : undefined, store.triggers.get(triggerId))
        } } : {}),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.machine.coordinationMode === 'sessions' || this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { sources } = this
    const deployment = this.machine.coordinationMode === 'sessions' ? undefined : this.setup.deployment
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean {
    return (this.machine.coordinationMode === 'sessions' ? !this.machine.sessionExecution : !this.setup.configured()) || this.store.settings().paused
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (this.machine.coordinationMode === 'sessions') {
      const router = new SessionRouter({ llm: this.ctx.llm, model: () => this.store.settings().eval.model,
        timeoutMs: () => this.store.settings().eval.timeoutSeconds * 1000, lifetime: this.lifetime })
      this.sessionHub = new SessionHub(this.store, router)
      const catalog = new ContextCatalog(this.store)
      const work = new LocalWork({ store: this.store, sources: this.sources, enabled: () => !!this.machine.sessionExecution,
        nativeResult: id => this.native?.binding(id),
        validate: trigger => {
          if (trigger.meta.executor !== 'codex' || typeof trigger.meta.codexThreadId !== 'string') return
          const targets = new ContextTargets(catalog, this.store), card = targets.card('codex:' + trigger.meta.codexThreadId)
          if (!card || card.workspace !== workspaceKey(String(trigger.meta.workspaceRoot))) throw Error('Native session must be located in the authorized workspace first')
          const binding = targets.binding(card.uid)
          if (binding?.kind === 'engine-ticket' && binding.workId !== trigger.meta.workId) throw Error('Native session already has an Engine work binding; continue that workId')
        },
        receive: trigger => this.passes.receive(trigger) })
      const resolver = new TargetResolver(new ContextTargets(catalog, this.store), { llm: this.ctx.llm,
        model: () => this.store.settings().eval.model, timeoutMs: () => this.store.settings().eval.timeoutSeconds * 1000, lifetime: this.lifetime })
      const targets = resolver.targets
      const activities = new SessionActivities({ targets, running: threadId => this.store.tickets.list().some(ticket =>
        this.native?.binding(ticket.id)?.threadId === threadId && this.native.running(ticket.id)) })
      const deferred = this.deferred = new DeferredWork({ store: this.store, targets, activities, work,
        enabled: () => !this.closing() && !!this.machine.sessionExecution && !this.paused() })
      const managed = new ManagedWork({ store: this.store, targets, activities, work,
        options: () => ({ enabled: !!this.machine.sessionExecution, paused: this.paused(),
          defaultPermission: (this.sources.instance('local-work')?.config as { defaultPermission?: 'read-only' | 'workspace-write' } | undefined)?.defaultPermission,
          workspaces: ((this.sources.instance('local-work')?.config as { workspaces?: { path: string }[] } | undefined)?.workspaces ?? []).map(item => item.path) }),
        admit: request => {
          if (this.closing() || this.paused()) throw Error('本地执行已暂停或正在停止，未接单。')
          const triggerId = 'local-work:' + request.eventId, trigger = this.store.triggers.get(triggerId)
          if (!request.intakeProposalId || trigger?.meta.intakeProposalId !== request.intakeProposalId) throw Error('缺少已确认工作卡的来源绑定。')
          const disposition = this.store.triggers.disposition(triggerId)
          const prior = disposition?.decisionId ? this.store.decisions.get(disposition.decisionId) : undefined
          if (prior?.kind === 'unavailable') this.engine.reevaluate(triggerId)
          this.engine.evaluateDue()
          const candidate = this.engine.candidate(triggerId)
          if (candidate?.strength === 'explicit') {
            this.quiet++
            try { this.engine.decide(triggerId, { kind: 'accept', title: workTitle(request.instruction), scope: request.instruction.slice(0, 1500),
              name: 'managed-' + request.intakeProposalId.slice(0, 8), acknowledgement: '已受理' + (request.permission === 'workspace-write' ? '工程读写' : '只读') + '工作：' + request.instruction.slice(0, 60), reason: { code: 'explicitRouted' } }) }
            finally { this.quiet-- }
          }
          this.passes.request()
        },
        start: async request => {
          const ownTriggerId = 'local-work:' + request.eventId
          if (this.store.tickets.list().some(ticket => !ticket.ended) || this.store.threads.list().some(thread => thread.pending.some(id => id !== ownTriggerId)
            || thread.evaluating?.triggerIds.some(id => id !== ownTriggerId))
            || deferred.list().some(input => input.state === 'waiting')) throw Error('已有待处理工作；请先在工作与状态页核对，不能随新工作自动解除全局暂停。')
          if (this.sources.instances().some(source => source.enabled && source.kind !== 'local-work')) throw Error('本入口只启动本地工作；请先关闭其他执行来源。')
          await this.settings.pause(false, 'panel')
        } })
      this.disposers.push(this.ctx.on('session/event', (session, event) => {
        if (session.id !== this.masterId || event.type !== 'user/message' || !['user', 'user-rpc'].includes(event.data.source.kind)) return
        const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text.trim()) managed.capture(event.data.id, text, event.data.content.some(part => part.type === 'image'))
      }))
      const activityPipe = process.env.DSH_ACTIVITY_PIPE_PATH
      const activityCaller = process.env.DSH_ACTIVITY_CALLER_THREAD_ID
      const chatgpt = this.chatgptSource = new ChatgptSource(this.store,
        activityPipe && activityCaller ? new DesktopChatgptClient(activityPipe, activityCaller) : undefined)
      chatgpt.start()
      const cloudWorkers = this.cloudWorkers = new CloudWorkers({ store: this.store, source: chatgpt, closing: () => this.closing(),
        ...(activityPipe && activityCaller ? { transport: { send: async (threadId: string, prompt: string, requestId: string) => {
          const client = new DesktopChatClient(activityPipe, activityCaller)
          try { return await client.send(threadId, prompt, requestId, true) } finally { client.close() }
        } } } : {}),
      })
      if (activityPipe && activityCaller) {
        this.desktopObserver = new DesktopActivityObserver({ targets, activities, sync: rows => catalog.syncDesktop(rows),
          client: new DesktopActivityClient(activityPipe, activityCaller) })
        this.desktopObserver.start()
      }
      this.toolHost.contextTools = [...this.toolHost.contextTools ?? [], ...activities.tools(), ...deferred.tools(), ...cloudWorkers.tools(), ...managed.tools(),
        ...knowledgeTools(join(this.machine.stateDir, 'knowledge-library-organized.json'))]
      const poll = setInterval(() => { void deferred.tick().catch(() => {}) }, 5000); poll.unref?.()
      this.disposers.push(() => clearInterval(poll))
      this.disposers.push(registerSessionHub(this.ctx, this.sessionHub, catalog, router, work, undefined, resolver, join(this.machine.stateDir, 'knowledge-graph-cache.json'), activities, deferred, chatgpt, cloudWorkers, () => this.store.settings().eval.model, managed))
      if (this.machine.sessionExecution) {
        this.sessions.install()
        this.executor.install()
        await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
        this.executor.resume()
        this.passes.start()
        this.effects.start()
      }
      this.runtimeHealth.set({ state: 'ready', detail: this.machine.sessionExecution
        ? 'Original Engine ready with local-work input and DSH driver; policy pause and authorization remain in effect'
        : 'Local input/output ready; Engine execution disabled (sessionExecution=false)', at: now() })
      return
    }
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /** Prepare the configured chat Session on demand without starting Engine loops or sending a prompt. */
  openMasterChat(): Promise<{ sessionId: string }> {
    return this.masterChatOpening ??= (async () => {
      await this.ready
      if (this.closing()) throw new Error('Runtime is stopping')
      this.sessions.install()
      await this.sessions.ensure(this.masterId, this.machine.stateDir, 'SuperAgent', 'orchestrator')
      return { sessionId: this.masterId }
    })().catch(error => { this.masterChatOpening = undefined; throw error })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      openMasterChat: () => runtime.openMasterChat() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    await this.desktopObserver?.stop()
    await this.chatgptSource?.stop()
    await this.cloudWorkers?.shutdown()
    await this.deferred?.tick()
    await this.sessionHub?.idle()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
