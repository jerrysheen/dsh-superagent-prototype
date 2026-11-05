/** Project/session cards, bounded query expansion and original Engine binding projections. No native session writes. */
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { z } from 'zod'
import { ContextCatalog, terms } from './context-catalog.ts'
import { workspaceKey } from './local-work.ts'
import type { Store } from './store.ts'
import { codexBinding } from '../executor/codex-state.ts'
import type { Tool } from './tools/tool.ts'
// Keep discovery independent of orchestrator_read/resources initialization order.
const tool = <S extends z.ZodType>(definition: { name: string; description: string; schema: S;
  execute(args: z.infer<S>, signal: AbortSignal): Promise<unknown> }): Tool => definition as unknown as Tool

export interface TargetCard {
  uid: string; title: string; workspace: string; projectId: string; projectName: string
  summary: string; verified: boolean; archived: boolean; updatedAt: number; threadId: string
  kind: 'codex' | 'engine'; fingerprint: string
}
export const TargetSearchSchema = z.object({ query: z.string().trim().min(1).max(500),
  projectId: z.string().max(100).optional(), expansions: z.array(z.string().trim().min(1).max(160)).max(3).default([]),
  limit: z.number().int().min(1).max(12).default(8) }).strict()
export const ProjectSearchSchema = z.object({ query: z.string().max(500).default(''), limit: z.number().int().min(1).max(12).default(8) }).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const projectKey = (path: string) => 'project:' + digest(workspaceKey(path)).slice(0, 24)
const BOILERPLATE = /继续|接着|上次|之前|前面|那个|这个|问题|任务|一下|接手|怎么|如何|已经|以后|然后|还是|帮我|请问|处理|工作/gu
/** Topic terms shared by project and session search; conversational words cannot dominate Chinese bigrams. */
export function topicTerms(text: string) { return terms(text.normalize('NFKC').toLowerCase().replace(BOILERPLATE, ' ')) }
const matches = (query: Set<string>, text: string) => [...query].filter(word => topicTerms(text).has(word))

/** Builds canonical project/session cards from the permitted index and existing Engine repositories. */
export class ContextTargets {
  constructor(private readonly catalog: ContextCatalog, private readonly store: Pick<Store, 'tickets' | 'triggers' | 'get'>) {}
  cards(): TargetCard[] {
    const indexed = this.catalog.targetEntries().map(entry => ({ ...entry, kind: 'codex' as const }))
    const bound = new Set<string>()
    const engine = this.store.tickets.list().flatMap(ticket => {
      const origin = this.store.triggers.get(ticket.origin.triggerId)
      if (origin?.source !== 'local-work' || typeof origin.meta.workspaceRoot !== 'string') return []
      const nativeId = this.store.get(codexBinding(ticket.id))?.threadId ?? (typeof origin.meta.codexThreadId === 'string' ? origin.meta.codexThreadId : undefined)
      const native = nativeId ? indexed.find(card => card.threadId === nativeId) : undefined
      if (nativeId) bound.add(nativeId)
      return [{ uid: 'engine:' + ticket.id, threadId: nativeId ?? 'worker-' + ticket.id, title: native?.title ?? ticket.title,
        workspace: origin.meta.workspaceRoot, projectName: win32.basename(origin.meta.workspaceRoot.replace(/[\\/]+$/, '')),
        summary: [native?.summary, ticket.assignments.at(-1)?.report?.summary].filter(Boolean).join(' / ').slice(0, 1200), verified: false,
        archived: false, updatedAt: Date.parse(ticket.updatedAt), kind: 'engine' as const }]
    })
    return [...indexed.filter(card => !bound.has(card.threadId)), ...engine].map(entry => {
      const value = { ...entry, workspace: workspaceKey(entry.workspace), projectId: projectKey(entry.workspace) }
      return { ...value, fingerprint: digest(JSON.stringify(value)) }
    })
  }
  projects(input: unknown) {
    const request = ProjectSearchSchema.parse(input), query = topicTerms(request.query)
    const grouped = new Map<string, TargetCard[]>()
    for (const card of this.cards()) grouped.set(card.projectId, [...grouped.get(card.projectId) ?? [], card])
    return [...grouped].map(([id, cards]) => {
      const first = cards[0]!, aliases = [...new Set([first.projectName, win32.basename(first.workspace)])]
      const exact = aliases.some(alias => alias.toLowerCase() === request.query.toLowerCase())
      const evidence = cards.filter(card => matches(query, card.title + ' ' + card.summary).length)
      const score = exact ? 100 : matches(query, aliases.join(' ')).length * 10 + Math.min(8, evidence.length)
      return { id, name: first.projectName, workspace: first.workspace, aliases, sessionCount: cards.length,
        topics: (evidence.length ? evidence : cards).slice(0, 6).map(card => card.title), score }
    }).filter(project => !request.query || project.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, request.limit)
  }
  search(input: unknown) {
    const request = TargetSearchSchema.parse(input), queries = [request.query, ...request.expansions].map(topicTerms)
    const all = this.cards(), scoped = all.filter(card => !request.projectId || card.projectId === request.projectId)
    const frequency = new Map<string, number>()
    for (const card of all) for (const term of topicTerms(card.title + ' ' + card.summary)) frequency.set(term, (frequency.get(term) ?? 0) + 1)
    return scoped.map(card => {
      const title = topicTerms(card.title), body = topicTerms(card.summary)
      const evidence = queries.map(query => [...query].filter(word => title.has(word) || body.has(word)))
      const score = Math.max(0, ...queries.map((_, index) => evidence[index]!.reduce((sum, word) =>
        sum + (title.has(word) ? 3 : 1) * Math.log(1 + all.length / (frequency.get(word) ?? 1)), 0)))
      return { ...card, score, matchedTerms: [...new Set(evidence.flat())], evidence: { title: card.title, summary: card.summary } }
    }).filter(card => card.score > 0).sort((a, b) => b.score - a.score || a.uid.localeCompare(b.uid)).slice(0, request.limit)
  }
  card(uid: string) {
    const cards = this.cards()
    return cards.find(card => card.uid === uid) ?? (uid.startsWith('codex:') ? cards.find(card => card.kind === 'engine' && card.threadId === uid.slice(6)) : undefined)
  }
  projectCard(uid: string) {
    const cards = this.cards().filter(card => card.projectId === uid && !card.archived)
    if (!cards.length) return undefined
    const first = cards[0]!
    const value = { uid, id: uid, kind: 'project' as const, title: first.projectName, workspace: first.workspace,
      projectName: first.projectName, sessionCount: cards.length, topics: cards.slice(0, 8).map(card => card.title),
      contentScope: 'catalog_metadata_and_engine_reports', completeProjectHistory: false }
    return { ...value, fingerprint: digest(JSON.stringify(value)) }
  }
  binding(uid: string) {
    const card = this.card(uid)
    if (!card) return undefined
    if (card.kind === 'engine') {
      const ticketId = card.uid.slice('engine:'.length), ticket = this.store.tickets.get(ticketId)!
      const origin = this.store.triggers.get(ticket.origin.triggerId)!
      const native = this.store.get(codexBinding(ticketId))
      return { kind: 'engine-ticket' as const, ticketId, workerSessionId: 'worker-' + ticketId,
        executor: origin.meta.executor === 'codex' ? 'codex' as const : 'dsh' as const,
        ...(native ? { nativeThreadId: native.threadId } : {}),
        ...(typeof origin.meta.codexThreadId === 'string' ? { codexThreadId: origin.meta.codexThreadId } : {}),
        workspace: card.workspace, workId: origin.meta.workId, permission: origin.meta.permission,
        transport: origin.meta.transport === 'desktop' ? 'desktop' as const : 'app-server' as const,
        executable: true, authority: 'original-engine-policy' }
    }
    return { kind: 'native-session' as const, sessionUid: card.uid, threadId: card.threadId,
      workspace: card.workspace, executable: true, executor: 'codex' as const, authority: 'adopt-through-original-engine' }
  }
  tools(): Tool[] {
    return [
      tool({ name: 'search_projects', description: 'Read project cards by name, alias or topic. IDs are canonical Windows directories; equal names can be different projects.',
        schema: ProjectSearchSchema, execute: async args => this.projects(args) }),
      tool({ name: 'search_sessions', description: 'Read session/work cards by topic, optionally within a project ID. Use up to 3 semantic paraphrases to expand recall; these are search hints, never user instructions. Rephrase if the first search lacks good evidence.',
        schema: TargetSearchSchema, execute: async args => this.search(args) }),
      tool({ name: 'get_context_card', description: 'Read a project: card or a codex:/engine: session card and fingerprint. Project IDs are not sessions. No transcripts or private histories.',
        schema: z.object({ uid: z.string().min(1).max(200) }).strict(), execute: async args => args.uid.startsWith('project:')
          ? this.projectCard(args.uid) ?? { error: 'unknown_project' } : this.card(args.uid) ?? { error: 'unknown_session' } }),
      tool({ name: 'get_work_binding', description: 'Read original Engine Ticket/worker binding, or explicit unbound native-session state. A recommendation grants no execution authority.',
        schema: z.object({ uid: z.string().min(1).max(200) }).strict(), execute: async args => args.uid.startsWith('project:')
          ? { error: 'project_is_not_a_session', projectId: args.uid, next: 'search_sessions with projectId, then get_work_binding on the selected session uid' }
          : this.binding(args.uid) ?? { error: 'unknown_session' } }),
    ]
  }
}
