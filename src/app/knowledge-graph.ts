/** Explicitly requested, bounded content index. Raw transcripts stay local to each read and are never persisted. */
import { z } from 'zod'
import { win32 } from 'node:path'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { terms, type ContextCatalog, type ContextOrganization } from './context-catalog.ts'
import { readCodexTranscript, type CodexTranscript } from './codex-transcript.ts'
import { CodexReadClient } from './codex-local-client.ts'

export interface KnowledgeNode { provider: 'codex'; threadId: string; title: string; cwd: string; projectName: string; updatedAt: number; messages: number; partial: boolean;
  topics?: { label: string; evidence: string[] }[]; files?: string[]; organization?: ContextOrganization }
export interface KnowledgeEdge { source: string; target: string; kind: 'similarity' | 'reference' | 'shared-file' | 'contains' | 'co-discussed'; score: number; terms: string[]; turnId?: string }
export interface KnowledgeGraph { status: 'idle' | 'indexing' | 'ready' | 'cancelled'; completed: number; total: number;
  nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; failed: string[]; builtAt: string | null; scope: { cwd: string; limit?: number; turns: number } | null;
  cached?: number; cacheError?: string }
interface Document { node: KnowledgeNode; weights: Map<string, number>; refs: Map<string, string>; complete?: boolean; cursor?: string; clipped?: boolean }
export const KnowledgeRequest = z.object({ confirmed: z.literal(true), cwd: z.string().max(600).default(''),
  limit: z.number().int().min(2).max(100000).optional(), turns: z.number().int().min(1).max(10).default(3) }).strict()
const noise = new Set('const let function return import export from undefined null true false string number console this that with have will your please 现在 可以 我们 这个 那个 进行 完成 已经 需要 以及 使用 通过 相关 问题'.split(' '))
const key = (cwd: string) => cwd.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
const topicRules: [string, RegExp][] = [
  ['工程与配置', /^(工程|配置|部署|启动|windows|config|setup|deployment)$/i],
  ['会话与目标定位', /^(会话|检索|路由|定位|索引|session|routing|search|context)$/i],
  ['任务与 Agent 执行', /^(任务|执行|调度|绑定|agent|worker|engine|ticket|assignment)$/i],
  ['界面与交互', /^(界面|前端|交互|样式|预览|ui|css|react|markdown)$/i],
  ['性能与内存', /^(内存|性能|膨胀|加载|wasm|memory|heap|profiler|gc|performance)$/i],
  ['验证与测试', /^(验收|测试|回归|验证|test|tests|testing|verification)$/i],
]
function mentionedFiles(text: string, cwd: string): string[] {
  const files = new Set<string>()
  const candidates = [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)|`([^`\n]+)`/g)].map(match => match[1] ?? match[2] ?? '')
  for (let path of candidates) {
    path = path.replace(/^<|>$/g, '').replace(/(?:#.*|:\d+(?::\d+)?)$/, '').replace(/^\/([a-z]:[\\/])/i, '$1')
    if (/^[a-z][\w+.-]*:\/\//i.test(path) || !/\.(?:md|tsx?|jsx?|css|json|ya?ml|toml|py|ps1|cs|cpp|h|rs|go)$/i.test(path) || /[\u0000-\u001f]/.test(path)) continue
    const full = win32.resolve(cwd, path), relative = win32.relative(cwd, full)
    if (relative.startsWith('..') || win32.isAbsolute(relative) || /(?:^|[\\/])(?:\.local|\.env|\.git|credentials)(?:[\\/.]|$)/i.test(relative)) continue
    files.add(relative.replaceAll('\\', '/').toLowerCase())
  }
  return [...files].sort().slice(0, 40)
}

export function contentDocument(node: Omit<KnowledgeNode, 'messages' | 'partial'>, transcript: CodexTranscript): Document {
  if (transcript.threadId !== node.threadId) throw new Error('Indexed thread ID mismatch')
  const weights = new Map<string, number>(), refs = new Map<string, string>(), files = new Set<string>()
  const add = (text: string, weight: number) => {
    for (const token of terms(text)) if (token.length <= 40 && !noise.has(token) && !/^\d+$/.test(token)) weights.set(token, (weights.get(token) ?? 0) + weight)
  }
  const messages = transcript.turns.flatMap(turn => turn.messages)
  let remaining = 80000
  for (const turn of [...transcript.turns].reverse()) for (const message of turn.messages) {
    const text = message.text.slice(0, remaining); remaining -= text.length
    add(text.replace(/(?:https?:\/\/|codex:\/\/)\S+/gi, ' '), message.role === 'user' ? 2 : 1)
    for (const match of text.matchAll(/(?:codex:\/\/threads\/|thread:\/\/)([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/gi)) refs.set(match[1]!.toLowerCase(), turn.id)
    for (const file of mentionedFiles(text, node.cwd)) if (files.size < 40) files.add(file)
  }
  if (messages.length) add(node.title, 2)
  const topics = topicRules.flatMap(([label, pattern]) => {
    const evidence = [...weights.keys()].filter(term => pattern.test(term)).slice(0, 5)
    return evidence.length ? [{ label, evidence }] : []
  })
  return { node: { ...node, messages: messages.length, topics, files: [...files], partial: !!transcript.nextCursor || remaining === 0 || messages.some(item => item.truncated) },
    weights: new Map([...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 600)), refs }
}

export function knowledgeEdges(documents: Document[]): KnowledgeEdge[] {
  const frequencies = new Map<string, number>()
  for (const doc of documents) for (const term of doc.weights.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  const vectors = documents.map(doc => {
    const weighted: [string, number][] = [...doc.weights].map(([term, count]) => [term, (1 + Math.log(count)) * (1 + Math.log((documents.length + 1) / (frequencies.get(term)! + 1)))])
    const weights = new Map(weighted.sort((a, b) => b[1] - a[1]).slice(0, 256))
    return { ...doc, weights, norm: Math.sqrt([...weights.values()].reduce((sum, value) => sum + value * value, 0)) }
  })
  const references: KnowledgeEdge[] = [], candidates: KnowledgeEdge[] = [], pairs = new Set<string>()
  const pair = (a: string, b: string) => [a, b].sort().join(':')
  const ids = new Set(documents.map(doc => doc.node.threadId))
  for (const doc of documents) for (const [target, turnId] of doc.refs) if (ids.has(target) && target !== doc.node.threadId) {
    references.push({ source: doc.node.threadId, target, kind: 'reference', score: 1, terms: [], turnId }); pairs.add(pair(doc.node.threadId, target))
  }
  const postings = new Map<string, number[]>(), filePostings = new Map<string, number[]>()
  vectors.forEach((doc, index) => {
    for (const term of doc.weights.keys()) if (vectors.length < 80 || frequencies.get(term)! < vectors.length * .4) postings.set(term, [...postings.get(term) ?? [], index])
    for (const file of doc.node.files ?? []) { const id = key(doc.node.cwd) + ':' + file; filePostings.set(id, [...filePostings.get(id) ?? [], index]) }
  })
  for (let i = 0; i < vectors.length; i++) {
    const overlap = new Map<number, number>()
    for (const term of vectors[i]!.weights.keys()) for (const index of postings.get(term) ?? []) if (index > i) overlap.set(index, (overlap.get(index) ?? 0) + 1)
    const related = new Set([...overlap].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([index]) => index))
    for (const file of vectors[i]!.node.files ?? []) for (const index of filePostings.get(key(vectors[i]!.node.cwd) + ':' + file) ?? []) if (index > i) related.add(index)
    for (const j of related) {
    const a = vectors[i]!, b = vectors[j]!
    const sharedFiles = key(a.node.cwd) === key(b.node.cwd) ? (a.node.files ?? []).filter(file => b.node.files?.includes(file)) : []
    if (sharedFiles.length) references.push({ source: a.node.threadId, target: b.node.threadId, kind: 'shared-file', score: 1, terms: sharedFiles.slice(0, 6) })
    if (!a.norm || !b.norm || pairs.has(pair(a.node.threadId, b.node.threadId))) continue
    const shared = [...a.weights].filter(([term]) => b.weights.has(term)).map(([term, weight]) => ({ term, score: weight * b.weights.get(term)! })).sort((a, b) => b.score - a.score)
    const score = shared.reduce((sum, term) => sum + term.score, 0) / (a.norm * b.norm)
    if (shared.length >= 3 && score >= .16) candidates.push({ source: a.node.threadId, target: b.node.threadId, kind: 'similarity', score: Math.min(1, score), terms: shared.slice(0, 6).map(item => item.term) })
    }
  }
  const degree = new Map<string, number>()
  return [...references, ...candidates.sort((a, b) => b.score - a.score).filter(edge => {
    if ((degree.get(edge.source) ?? 0) >= 4 || (degree.get(edge.target) ?? 0) >= 4) return false
    for (const id of [edge.source, edge.target]) degree.set(id, (degree.get(id) ?? 0) + 1)
    return true
  })]
}

/** Maintains the separately requested knowledge graph and its bounded build state. */
export class KnowledgeIndex {
  private generation = 0
  private documents: Document[] = []
  private state: KnowledgeGraph = { status: 'idle', total: 0, completed: 0, nodes: [], edges: [], failed: [], builtAt: null, scope: null }
  private edges: KnowledgeEdge[] = []
  private dirty = true
  private computedAt = 0
  constructor(private catalog: Pick<ContextCatalog, 'threads'> & Partial<Pick<ContextCatalog, 'organizations'>>, private read = readCodexTranscript, private cachePath?: string) {
    if (cachePath && existsSync(cachePath)) try {
      const value = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (value.version !== 2 || !Array.isArray(value.documents)) throw new Error('Invalid cache')
      this.documents = value.documents.map((doc: any) => {
        if (!z.string().uuid().safeParse(doc.node?.threadId).success || !Array.isArray(doc.weights) || !Array.isArray(doc.refs)) throw new Error('Invalid cache document')
        return { node: doc.node, weights: new Map(doc.weights), refs: new Map(doc.refs), complete: doc.complete === true,
          cursor: typeof doc.cursor === 'string' ? doc.cursor : undefined, clipped: doc.clipped === true }
      })
      const complete = this.documents.filter(doc => doc.complete).length
      this.state = { ...this.state, status: complete === this.documents.length ? 'ready' : 'cancelled', completed: complete, total: this.documents.length,
        builtAt: typeof value.builtAt === 'string' ? value.builtAt : null, cached: this.documents.length }
    } catch { this.state.cacheError = '本地图谱缓存损坏或版本不兼容，需要重新处理。' }
  }
  snapshot(): KnowledgeGraph {
    if (this.dirty && (this.state.status !== 'indexing' || Date.now() - this.computedAt > 5000)) {
      this.edges = knowledgeEdges(this.documents); this.dirty = false; this.computedAt = Date.now()
    }
    const organizations = new Map((this.catalog.organizations?.() ?? []).map(item => [item.nativeThreadId, item]))
    return { ...this.state, nodes: this.documents.map(({ node }) => {
      const organization = organizations.get(node.threadId)
      if (!organization) return node
      return { ...node, title: !node.title.trim() || /^未命名(?: Codex)?(?: 会话|会话)$/.test(node.title) ? organization.title : node.title,
        organization, topics: [{ label: organization.category, evidence: ['内容整理'] }, ...(node.topics ?? []).filter(topic => topic.label !== organization.category)] }
    }), edges: this.edges }
  }
  private persist() {
    if (!this.cachePath) return
    try {
      mkdirSync(win32.dirname(this.cachePath), { recursive: true })
      writeFileSync(this.cachePath + '.tmp', JSON.stringify({ version: 2, builtAt: this.state.builtAt,
        documents: this.documents.map(doc => ({ node: doc.node, weights: [...doc.weights], refs: [...doc.refs], complete: doc.complete === true, cursor: doc.cursor, clipped: doc.clipped })) }), { mode: 0o600 })
      renameSync(this.cachePath + '.tmp', this.cachePath)
      delete this.state.cacheError
    } catch { this.state.cacheError = '本地处理缓存保存失败，当前结果仍在内存中。' }
  }
  cancel() { this.generation++; if (this.state.status === 'indexing') { this.state.status = 'cancelled'; this.persist() } return this.snapshot() }
  start(input: unknown) {
    const scope = KnowledgeRequest.parse(input)
    if (this.state.status === 'indexing') throw new Error('内容索引正在建立，请先停止或等待完成。')
    const selected: KnowledgeNode[] = []
    let offset: number | null = 0
    do {
      const page = this.catalog.threads({ offset, limit: 100, includeArchived: true, includeInternal: true })
      for (const thread of page.threads) if (!scope.cwd || key(thread.cwd) === key(scope.cwd)) selected.push({ ...thread, messages: 0, partial: false })
      offset = page.nextOffset
    } while (offset !== null && selected.length < (scope.limit ?? Infinity))
    const threads = scope.limit ? selected.slice(0, scope.limit) : selected, generation = ++this.generation
    const existing = new Map(this.documents.map(doc => [doc.node.threadId, doc]))
    this.documents = threads.map(thread => existing.get(thread.threadId) ?? { node: { ...thread, partial: true }, weights: new Map<string, number>(), refs: new Map<string, string>() })
    this.dirty = true
    this.state = { status: 'indexing', completed: 0, total: threads.length, nodes: [], edges: [], failed: [], builtAt: null,
      scope: { cwd: scope.cwd, limit: scope.limit, turns: scope.turns }, cached: 0 }
    void this.build(threads, scope.turns, generation, existing)
    return this.snapshot()
  }
  private async build(threads: KnowledgeNode[], turns: number, generation: number, existing: Map<string, Document>) {
    const organizations = new Map((this.catalog.organizations?.() ?? []).map(item => [item.nativeThreadId, item]))
    let reader: CodexReadClient | undefined, initialization: Promise<void> | undefined
    const read = this.read === readCodexTranscript ? (input: unknown) => readCodexTranscript(input, () => {
      reader ??= new CodexReadClient(60000)
      const current = reader
      return { initialize: () => initialization ??= current.initialize(), request: (method, params) => current.request(method, params), close: () => {} }
    }, { allItems: true, itemLimit: 20 }) : this.read
    try {
    for (const thread of threads) {
      if (generation !== this.generation) return
      const previous = existing.get(thread.threadId)
      const localTitleOnly = previous && /^未命名(?: Codex)?(?: 会话|会话)$/.test(previous.node.title)
        && organizations.get(thread.threadId)?.title === thread.title
      if (previous?.complete && previous.node.updatedAt === thread.updatedAt && (previous.node.title === thread.title || localTitleOnly) && key(previous.node.cwd) === key(thread.cwd)) {
        previous.node = { ...previous.node, title: thread.title }
        this.state.completed++; this.state.cached = (this.state.cached ?? 0) + 1; continue
      }
      try {
        const resumable = previous && previous.node.updatedAt === thread.updatedAt && previous.node.title === thread.title && previous.cursor
        let cursor: string | undefined = resumable ? previous.cursor : undefined
        const seen = new Set<string>()
        let document: Document | undefined = resumable ? { ...previous, node: { ...previous.node }, weights: new Map(previous.weights), refs: new Map(previous.refs) } : undefined
        let pages = 0
        do {
          let transcript: CodexTranscript
          try { transcript = await read({ threadId: thread.threadId, limit: turns, ...(cursor ? { cursor } : {}) }) }
          catch { transcript = await read({ threadId: thread.threadId, limit: 1, ...(cursor ? { cursor } : {}) }) }
          if (generation !== this.generation) return
          const page = contentDocument(thread, transcript)
          page.node.partial = transcript.turns.some(turn => turn.messages.some(message => message.truncated)) || transcript.turns.flatMap(turn => turn.messages).reduce((sum, message) => sum + message.text.length, 0) > 80000
          if (!document) { document = page; document.clipped = page.node.partial }
          else {
            document.node.messages += page.node.messages; document.clipped ||= page.node.partial
            for (const [word, weight] of page.weights) document.weights.set(word, (document.weights.get(word) ?? 0) + weight)
            for (const [id, turn] of page.refs) document.refs.set(id, turn)
            document.node.files = [...new Set([...(document.node.files ?? []), ...(page.node.files ?? [])])].slice(0, 100)
            const topics = new Map([...(document.node.topics ?? []), ...(page.node.topics ?? [])].map(topic => [topic.label, topic]))
            document.node.topics = [...topics.values()]
            if (document.weights.size > 2000) document.weights = new Map([...document.weights].sort((a, b) => b[1] - a[1]).slice(0, 2000))
          }
          cursor = transcript.nextCursor ?? undefined
          if (cursor && seen.has(cursor)) throw new Error('Repeated transcript cursor')
          if (cursor) seen.add(cursor)
          document.cursor = cursor; document.node.partial = !!cursor || !!document.clipped
          this.documents = this.documents.map(doc => doc.node.threadId === thread.threadId ? document! : doc)
          this.dirty = true
          if (++pages % 20 === 0) this.persist()
        } while (cursor)
        document!.weights = new Map([...document!.weights].sort((a, b) => b[1] - a[1]).slice(0, 1000))
        document!.complete = true
        if (generation !== this.generation) return
        this.documents = this.documents.map(doc => doc.node.threadId === thread.threadId ? document! : doc)
        this.dirty = true
      } catch { reader?.close(); reader = undefined; initialization = undefined; if (generation === this.generation) this.state.failed.push(thread.threadId) }
      if (generation !== this.generation) return
      this.state.completed++
      if (this.state.completed % 20 === 0) this.persist()
    }
    if (generation === this.generation) { this.state.status = 'ready'; this.state.builtAt = new Date().toISOString(); this.persist() }
    } finally { reader?.close() }
  }
}
