/** Source-derived knowledge index. NOT a second Ticket or Chat store.
 * Codex metadata are indexed; content/experience summaries must be explicitly curated.
 */
import { win32 } from 'node:path'
import { z } from 'zod'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import type { SessionCard } from './session-hub.ts'

const NativeId = z.string().uuid()
const WindowsDir = z.string().min(3).max(600).refine(value => /^[a-zA-Z]:[\\/]/.test(value) && win32.isAbsolute(value),
  'Local absolute Windows directory required')
export const ContextEntrySchema = z.object({
  provider: z.literal('codex'), nativeThreadId: NativeId,
  cwd: WindowsDir, sourceKind: z.string().min(1).max(70),
  title: z.string().max(350).default(''),
  /** Optional first-message short preview from thread/list; explicit local opt-in, never full history. */
  preview: z.string().max(220).optional(),
  archived: z.boolean(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict()
export type ContextEntry = z.infer<typeof ContextEntrySchema>

export const ContextExperienceSchema = z.object({
  nativeThreadId: NativeId, problem: z.string().trim().min(5).max(400),
  conclusion: z.string().trim().min(5).max(800),
  nextStep: z.string().max(400).default(''),
  evidence: z.array(z.object({ threadId: NativeId, turnId: NativeId.optional() }).strict()).min(1).max(12),
  /** The importer never claims success automatically; only a separately reviewed fact is confirmed. */
  verified: z.boolean().default(false),
}).strict()
type ContextExperience = z.infer<typeof ContextExperienceSchema>
export const ContextOrganizationSchema = z.object({
  nativeThreadId: NativeId, title: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60), summary: z.string().trim().min(5).max(500),
  kind: z.enum(['discussion', 'review', 'test', 'insufficient']),
  coverage: z.enum(['recent-turns', 'available-turns', 'prompt-only']),
  evidence: z.array(z.object({ threadId: NativeId, turnId: NativeId.optional() }).strict()).min(1).max(12),
  reviewedAt: z.string().datetime(),
}).strict()
export type ContextOrganization = z.infer<typeof ContextOrganizationSchema>
type StoredEntry = ContextEntry & { experience?: ContextExperience; organization?: ContextOrganization }
const displayTitle = (entry: StoredEntry) => entry.title.trim() || entry.organization?.title || ''
type IndexState = { entries: StoredEntry[]; revisedAt: string }
const State = record<IndexState>('context-catalog:v1')
const ImportSchema = z.object({ entries: z.array(ContextEntrySchema).min(1).max(100) }).strict()
const ExperienceImportSchema = z.object({ experience: ContextExperienceSchema }).strict()
export const SearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  cwd: WindowsDir.optional(), limit: z.number().int().min(1).max(20).default(12),
}).strict()
export type ContextSearch = z.infer<typeof SearchSchema>

const NORMAL = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
const pathKey = (path: string) => win32.normalize(path).replace(/[\\/]+$/, '').toLocaleLowerCase()
export function projectName(cwd: string): string {
  const tail = win32.basename(cwd.replace(/[\\/]+$/, ''))
  return ['client', 'src', 'app'].includes(tail.toLowerCase()) ? win32.basename(win32.dirname(cwd)) : tail
}
const STOP = new Set(['the', 'and', 'with', 'from', 'into', 'what', 'when', 'where', 'please', '继续', '问题', '任务', '一下'])
/** Lexical baseline, not a semantic embedding. Chinese bigrams cover terms without whitespace. */
export function terms(value: string): Set<string> {
  const result = new Set<string>()
  for (const part of NORMAL(value).match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_.-]*/gu) ?? []) {
    if (STOP.has(part)) continue
    if (/^[\p{Script=Han}]+$/u.test(part) && part.length > 2) {
      for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2))
    } else if (part.length >= 2) result.add(part)
  }
  return result
}
function overlap(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter(token => b.has(token))
}
export type ContextHit = {
  uid: string; nativeThreadId: string; title: string; cwd: string; projectName: string;
  sourceKind: string; archived: boolean; updatedAt: number; hasExperience: boolean;
  score: number; matchedTerms: string[]
}
/** Stores bounded historical evidence for read-only retrieval, independently of authorized Engine work. */
export class ContextCatalog {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic'>) {}
  private state(): IndexState {
    return this.store.get(State) ?? { entries: [], revisedAt: new Date(0).toISOString() }
  }
  /** Bounded index cards for read-only tools; never include first-message previews or native transcripts. */
  targetEntries() {
    return this.state().entries.filter(entry => !entry.sourceKind.startsWith('subAgent')).map(entry => ({
      uid: 'codex:' + entry.nativeThreadId, threadId: entry.nativeThreadId, title: displayTitle(entry) || '未命名会话',
      workspace: entry.cwd, projectName: projectName(entry.cwd), archived: entry.archived, updatedAt: entry.updatedAt,
      summary: entry.experience ? [entry.experience.problem, entry.experience.conclusion, entry.experience.nextStep].filter(Boolean).join(' / ').slice(0, 1200) : entry.organization?.summary ?? '',
      verified: entry.experience?.verified ?? false,
    }))
  }
  /** Idempotent upsert keyed by immutable provider-native thread ID; preserves curated knowledge. */
  importMetadata(input: unknown): { received: number; added: number; updated: number; total: number } {
    const batch = ImportSchema.parse(input)
    return this.store.atomic(() => {
      const state = this.state(), entries = new Map(state.entries.map(entry => [entry.nativeThreadId, entry]))
      let added = 0, updated = 0
      for (const entry of batch.entries) {
        const prior = entries.get(entry.nativeThreadId)
        if (prior && pathKey(prior.cwd) !== pathKey(entry.cwd)) {
          throw new Error('Native thread ID may not move to a different workspace')
        }
        if (!prior && entries.size >= 3500) throw new Error('Context catalog capacity reached')
        if (prior) updated++; else added++
        entries.set(entry.nativeThreadId, { ...entry,
          ...(prior?.organization ? { organization: prior.organization } : {}),
          ...(prior?.experience ? { experience: prior.experience } : {}) })
      }
      this.store.set(State, { entries: [...entries.values()], revisedAt: new Date().toISOString() })
      return { received: batch.entries.length, added, updated, total: entries.size }
    })
  }
  /** Incremental desktop metadata updates preserve curated knowledge and never prune absent rows. */
  syncDesktop(rows: { id: string; cwd: string; title?: string; updatedAt?: number }[]) {
    const state = this.state(), known = new Map(state.entries.map(entry => [entry.nativeThreadId, entry]))
    const entries: ContextEntry[] = []
    for (const row of rows) {
      const prior = known.get(row.id)
      const candidate = ContextEntrySchema.safeParse({ provider: 'codex', nativeThreadId: row.id, cwd: row.cwd,
        title: row.title ?? prior?.title ?? '', sourceKind: prior?.sourceKind ?? 'unknown', archived: false,
        createdAt: prior?.createdAt ?? 0, updatedAt: row.updatedAt ?? prior?.updatedAt ?? 0 })
      if (!candidate.success || prior && pathKey(prior.cwd) !== pathKey(row.cwd)) continue
      if (!prior || prior.title !== candidate.data.title || prior.updatedAt !== candidate.data.updatedAt || prior.archived) entries.push(candidate.data)
    }
    if (entries.length) this.importMetadata({ entries })
  }
  /** Only a complete native inventory may remove stale derivatives; partial polling never prunes. */
  reconcile(input: unknown) {
    const value = z.object({ nativeThreadIds: z.array(NativeId).max(3500), complete: z.literal(true) }).strict().parse(input)
    const ids = new Set(value.nativeThreadIds), state = this.state(), entries = state.entries.filter(entry => ids.has(entry.nativeThreadId))
    this.store.set(State, { entries, revisedAt: new Date().toISOString() })
    return { removed: state.entries.length - entries.length, total: entries.length }
  }
  /** Local reviewed labels are independent of native names and never rename/send to Codex. */
  importOrganization(input: unknown) {
    const batch = z.object({ entries: z.array(ContextOrganizationSchema).min(1).max(100) }).strict().parse(input)
    return this.store.atomic(() => {
      const state = this.state()
      const targets = batch.entries.map(organization => {
        const entry = state.entries.find(item => item.nativeThreadId === organization.nativeThreadId)
        if (!entry) throw new Error('Cannot organize unknown thread')
        if (!organization.evidence.every(item => item.threadId === entry.nativeThreadId)) throw new Error('Organization evidence must belong to this native thread')
        return { entry, organization }
      })
      for (const { entry, organization } of targets) entry.organization = organization
      this.store.set(State, { ...state, revisedAt: new Date().toISOString() })
      return { organized: targets.length }
    })
  }
  organizations(): ContextOrganization[] {
    return this.state().entries.flatMap(entry => entry.organization ? [entry.organization] : [])
  }
  /** Optional reviewed experience, bound to a real indexed native thread and verifiable source refs. */
  importExperience(input: unknown): { nativeThreadId: string; verified: boolean } {
    const { experience } = ExperienceImportSchema.parse(input)
    return this.store.atomic(() => {
      const state = this.state()
      const entry = state.entries.find(x => x.nativeThreadId === experience.nativeThreadId)
      if (!entry) throw new Error('Cannot attach experience to unknown thread')
      if (!experience.evidence.every(item => item.threadId === entry.nativeThreadId))
        throw new Error('Experience evidence must belong to this native thread')
      entry.experience = experience
      state.revisedAt = new Date().toISOString()
      this.store.set(State, state)
      return { nativeThreadId: entry.nativeThreadId, verified: experience.verified }
    })
  }
  stats() {
    const state = this.state(), projects: Record<string, number> = {}, sources: Record<string, number> = {}
    let titled = 0, curated = 0, archived = 0, organized = 0
    for (const entry of state.entries) {
      const name = projectName(entry.cwd)
      projects[name] = (projects[name] ?? 0) + 1
      sources[entry.sourceKind] = (sources[entry.sourceKind] ?? 0) + 1
      if (displayTitle(entry)) titled++
      if (entry.organization) organized++
      if (entry.experience) curated++
      if (entry.archived) archived++
    }
    return { total: state.entries.length, titled, curated, organized, archived, projects, sources, revisedAt: state.revisedAt }
  }
  /** Sidebar projection: metadata only, never previews, experience notes or conversation turns. */
  threads(input: unknown = {}) {
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50), query: z.string().trim().max(200).default(''),
      includeArchived: z.boolean().default(false), includeInternal: z.boolean().default(false),
    }).strict().parse(input)
    const state = this.state(), term = NORMAL(query.query)
    const all = state.entries.filter(item => (query.includeArchived || !item.archived) && (query.includeInternal || !item.sourceKind.startsWith('subAgent'))
      && (!term || NORMAL(displayTitle(item) + ' ' + item.cwd + ' ' + item.nativeThreadId).includes(term)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.nativeThreadId.localeCompare(b.nativeThreadId))
    const threads = all.slice(query.offset, query.offset + query.limit).map(item => ({
      provider: 'codex' as const, threadId: item.nativeThreadId, title: displayTitle(item) || '未命名 Codex 会话',
      cwd: item.cwd, projectName: projectName(item.cwd), updatedAt: item.updatedAt,
    }))
    return { threads, total: all.length, revisedAt: state.revisedAt,
      nextOffset: query.offset + threads.length < all.length ? query.offset + threads.length : null }
  }
  search(input: unknown, includePreview = true): ContextHit[] {
    const request = SearchSchema.parse(input), q = terms(request.query)
    const result: ContextHit[] = []
    for (const item of this.state().entries) {
      if (request.cwd && pathKey(item.cwd) !== pathKey(request.cwd)) continue
      const pt = terms(projectName(item.cwd)), title = terms(displayTitle(item))
      const preview = terms(includePreview ? item.preview ?? '' : '')
      const notes = terms([item.experience
        ? [item.experience.problem, item.experience.conclusion, item.experience.nextStep].join(' ') : '',
        item.organization?.summary, item.organization?.category].filter(Boolean).join(' '))
      const t = overlap(q, title), v = overlap(q, preview), n = overlap(q, notes), p = overlap(q, pt)
      const matched = [...new Set([...t, ...v, ...n, ...p])]
      // For project-scoped searches use title/experience relevance, not workspace alone.
      if (matched.length === 0) continue
      const score = t.length * 5 + v.length * 2.5 + n.length * 3 + p.length * 1.5
        - (item.archived ? 0.3 : 0) - (item.sourceKind === 'subAgent' ? 0.5 : 0)
      result.push({
        uid: 'codex:' + item.nativeThreadId, nativeThreadId: item.nativeThreadId,
        title: displayTitle(item) || 'Untitled Codex thread', cwd: item.cwd, projectName: projectName(item.cwd),
        sourceKind: item.sourceKind, archived: item.archived, updatedAt: item.updatedAt,
        hasExperience: !!item.experience, score, matchedTerms: matched,
      })
    }
    result.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.uid.localeCompare(b.uid))
    return result.slice(0, request.limit)
  }
  /** Share only bounded candidate evidence with the existing DSH SessionRouter. No sending. */
  routingCandidates(query: ContextSearch, includePreview = true): SessionCard[] {
    const state = new Map(this.state().entries.map(x => [x.nativeThreadId, x]))
    // A sub-agent's internal thread is evidence, not an ordinary human-resumable target.
    return this.search({ ...query, limit: 20 }, includePreview)
      .filter(hit => !hit.sourceKind.startsWith('subAgent')).slice(0, query.limit)
      .map((hit): SessionCard => {
      const source = state.get(hit.nativeThreadId)!
      return {
        uid: hit.uid, provider: 'codex', surface: 'codex', mode: 'work',
        projectId: pathKey(hit.cwd), projectName: hit.projectName,
        workspacePath: hit.cwd, threadId: hit.nativeThreadId,
        title: hit.title,
        summary: source.experience
          ? (source.experience.verified ? '人工确认经验：' : '待核实经验：')
            + [source.experience.problem, source.experience.conclusion, source.experience.nextStep].filter(Boolean).join(' / ').slice(0, 850)
          : source.organization ? '内容整理（未验证执行结果）：' + source.organization.summary
          : includePreview && source.preview ? '第一条消息预览（未验证）：' + source.preview
            : '仅有会话元数据，未提炼任务进度及经验。',
        scope: 'local', identity: 'machine_confirmed',
        capabilities: { read: 'api', send: 'user' }, evidence: [], origin: 'connector',
      }
    })
  }
  /** Freeze a common candidate pool; only preview summaries differ between arms. */
  frozenCandidates(query: ContextSearch): { metadata: SessionCard[]; preview: SessionCard[] } {
    const metadata = this.routingCandidates(query, false), preview = this.routingCandidates(query, true)
    const ids = [...new Set([...metadata, ...preview].map(card => card.uid))].sort()
    // Materialize both views for the union, including candidates retrieved by preview alone.
    const entries = this.state().entries
    const view = (includePreview: boolean) => ids.map(uid => {
      const source = entries.find(entry => 'codex:' + entry.nativeThreadId === uid)!
      const card = [...metadata, ...preview].find(card => card.uid === uid)!
      return { ...card, summary: source.experience ? card.summary
        : includePreview && source.preview ? '第一条消息预览（未验证）：' + source.preview
          : '仅有会话元数据，未提炼任务进度及经验。' }
    })
    return { metadata: view(false), preview: view(true) }
  }
  /** Weak title-derived fixtures for regression testing, not human-labelled intent. */
  benchmarkFixtures(max = 120): { query: string; cwd: string; expectedUid: string }[] {
    const usable = this.state().entries.filter(entry => !entry.sourceKind.startsWith('subAgent')
      && terms(entry.title || entry.preview || '').size >= 2)
    // Stratify across directories; otherwise the newest GIGNew and DSH sessions can dominate.
    const byProject = new Map<string, StoredEntry[]>()
    for (const item of usable) {
      const group = pathKey(item.cwd)
      if (!byProject.has(group)) byProject.set(group, [])
      byProject.get(group)!.push(item)
    }
    for (const group of byProject.values()) group.sort((a, b) =>
      b.updatedAt - a.updatedAt || a.nativeThreadId.localeCompare(b.nativeThreadId))
    const result: { query: string; cwd: string; expectedUid: string }[] = []
    const used = new Set<string>()
    const groups = [...byProject.values()].sort((a, b) => b.length - a.length)
    // Round-robin, preserving per-project recency.
    while (result.length < max && groups.some(group => group.length)) {
      for (const group of groups) {
        const item = group.shift()
        if (!item) continue
        const text = item.title || item.preview || ''
        const key = NORMAL(text)
        if (used.has(key)) continue
        used.add(key)
        result.push({ query: text, cwd: item.cwd, expectedUid: 'codex:' + item.nativeThreadId })
        if (result.length >= max) break
      }
    }
    return result
  }
  metadataBenchmark(max = 120) {
    const fixtures = this.benchmarkFixtures(Math.min(200, Math.max(1, max)))
    let top1 = 0, top3 = 0, top10 = 0, withoutHits = 0
    const byProject: Record<string, { n: number; top3: number }> = {}
    for (const fixture of fixtures) {
      const hits = this.search({ query: fixture.query, cwd: fixture.cwd, limit: 10 })
      const rank = hits.findIndex(hit => hit.uid === fixture.expectedUid)
      if (rank === 0) top1++
      if (rank >= 0 && rank < 3) top3++
      if (rank >= 0) top10++
      if (!hits.length) withoutHits++
      const name = projectName(fixture.cwd)
      byProject[name] ??= { n: 0, top3: 0 }
      byProject[name].n++
      if (rank >= 0 && rank < 3) byProject[name].top3++
    }
    return { testType: 'source-label-weak-label', n: fixtures.length,
      hitAt1: top1, hitAt3: top3, hitAt10: top10, emptyResults: withoutHits, byProject,
      warning: 'This measures title retrieval, not true semantic task understanding. Human-labelled tests are required.' }
  }
}
