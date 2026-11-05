import { relationTopics } from './knowledge-relations.ts'
/** Human-only browse service for local derivatives. Does not register agent tools or initiate indexing. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { classifiedKnowledge } from './classified-knowledge.ts'
import { CodexReadClient } from './codex-local-client.ts'
import { knowledgeDomains, publicKnowledgeTopics } from './knowledge-taxonomy.ts'
import { safeKnowledgeText, type KnowledgeLibrary, type LibraryEntry, type LibraryThread } from './knowledge-organizer.ts'

const identifier = z.string().min(1).max(160)
const threadSchema = z.object({ threadId: z.string().uuid(), title: z.string().max(350), cwd: z.string().max(600),
  projectName: z.string().max(350), updatedAt: z.number(), archived: z.boolean(), sourceKind: z.string().max(80),
  kind: z.enum(['discussion','review','test','digest']), scan: z.object({ state: z.enum(['pending','complete','partial','failed']),
    pages: z.number().int().nonnegative(), turns: z.number().int().nonnegative(), truncated: z.boolean(), cursor: z.string().max(4096).optional(), failure: z.string().max(120).optional() }).strict() }).strict()
const entrySchema = z.object({ id: identifier, threadId: z.string().uuid(), turnId: identifier,
  questionMessageIds: z.array(identifier).max(100), answerMessageIds: z.array(identifier).max(100),
  question: z.string().min(1).max(2000), answer: z.string().max(8000), startedAt: z.number(), answered: z.boolean(), truncated: z.boolean(),
  topics: z.array(z.object({ id: identifier, score: z.number(), basis: z.enum(['question-answer','conversation-title']) }).strict()).max(3),
  method: z.enum(['local-condensation','model-extraction']), review: z.literal('source-not-verified'),
  evidence: z.object({ provider: z.enum(['codex','chatgpt']), turnIds: z.array(identifier).max(1000), needsReview: z.boolean(), answerState: z.enum(['historical_answer','proposal','open_question','failed_attempt','insufficient_evidence']).optional() }).strict().optional() }).strict()
const insightSchema = z.object({ id: identifier, topicId: identifier, title: z.string().max(150), summary: z.string().max(1800),
  entryIds: z.array(identifier).min(1).max(25), status: z.literal('historical-summary') }).strict()
const librarySchema = z.object({ version: z.literal(1), taxonomyVersion: z.union([z.literal(1),z.literal(2)]), builtAt: z.string(), inventoryAt: z.string(),
  status: z.enum(['processing','ready','partial']), threads: z.array(threadSchema).max(3500), entries: z.array(entrySchema).max(200000),
  insights: z.array(insightSchema).max(1000), policy: z.object({ rawTranscriptsPersisted: z.literal(false), modelCalls: z.boolean(), agentIntegration: z.boolean() }).strict() }).strict()
const kind = z.enum(['all','discussion','review','test','digest'])
export const LibraryQuery = z.object({ topic: z.string().max(80).default(''), q: z.string().trim().max(300).default(''),
  thread: z.string().max(160).default(''), provider: z.enum(['','codex','chatgpt']).default(''), kind: kind.default('discussion'), pending: z.enum(['true','false']).default('false'),
  insight: z.string().max(160).default(''),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(25) }).strict()
type Query = z.infer<typeof LibraryQuery>
const topics = publicKnowledgeTopics(), topicIds = new Set(topics.map(topic => topic.id))
const empty = (): KnowledgeLibrary => ({ version: 1, taxonomyVersion: 1, builtAt: '', inventoryAt: '', status: 'ready', threads: [], entries: [], insights: [],
  policy: { rawTranscriptsPersisted: false, modelCalls: false, agentIntegration: false } })

/** Validates and queries derived knowledge artifacts without initiating indexing or model calls. */
export class KnowledgeLibraryReader {
  private current = empty()
  private stamp = ''
  private error = ''
  constructor(private file?: string) {}
  private load() {
    if (!this.file || !existsSync(this.file)) { this.current = empty(); this.stamp = ''; this.error = ''; return this.current }
    try {
      const stat = statSync(this.file), stamp = stat.mtimeMs + ':' + stat.size
      if (stamp === this.stamp) return this.current
      if (stat.size > 128 * 1024 * 1024) throw Error('Library too large')
      const value = librarySchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) as KnowledgeLibrary
      const ids = new Set(value.threads.map(thread => thread.threadId)), entryIds = new Set(value.entries.map(entry => entry.id))
      if (value.entries.some(entry => entry.method === 'local-condensation' ? !entry.questionMessageIds.length : !entry.evidence?.turnIds.length)) throw Error('Missing evidence')
      if (ids.size !== value.threads.length || entryIds.size !== value.entries.length || value.entries.some(entry => !ids.has(entry.threadId) || entry.topics.some(topic => !topicIds.has(topic.id)))) throw Error('Invalid source relationships')
      if (value.insights.some(insight => !topicIds.has(insight.topicId) || insight.entryIds.some(id => !entryIds.has(id)))) throw Error('Unknown insight evidence')
      this.current = value; this.stamp = stamp; this.error = ''
    } catch { this.error = '知识整理文件暂不可用；保留上一次可读取的结果。' }
    return this.current
  }
  overview() {
    const value = this.load(), byId = new Map(value.threads.map(thread => [thread.threadId, thread]))
    const substantive = value.entries.filter(entry => byId.get(entry.threadId)?.kind === 'discussion')
    const topicRows = topics.map(topic => {
      const entries = substantive.filter(entry => entry.topics.some(item => item.id === topic.id))
      return { ...topic, pairs: entries.length, threads: new Set(entries.map(entry => entry.threadId)).size,
        insights: value.insights.filter(insight => insight.topicId === topic.id) }
    })
    return { available: value.threads.length > 0, status: value.status, builtAt: value.builtAt, inventoryAt: value.inventoryAt, error: this.error,
      domains: knowledgeDomains.map(domain => ({ ...domain, topics: topicRows.filter(topic => topic.domainId === domain.id) })),
      stats: { threads: value.threads.length, pairs: value.entries.length, turns: value.threads.reduce((sum, thread) => sum + thread.scan.turns, 0),
        complete: value.threads.filter(thread => thread.scan.state === 'complete').length,
        incomplete: value.threads.filter(thread => thread.scan.state !== 'complete').length,
        truncated: value.threads.filter(thread => thread.scan.truncated).length,
        unassigned: value.entries.filter(entry => !entry.topics.length).length,
        noReadablePairs: value.threads.filter(thread => !value.entries.some(entry => entry.threadId === thread.threadId)).length,
        discussion: value.threads.filter(thread => thread.kind === 'discussion').length,
        review: value.threads.filter(thread => thread.kind === 'review').length,
        test: value.threads.filter(thread => thread.kind === 'test').length,
        digest: value.threads.filter(thread => thread.kind === 'digest').length,
        insights: value.insights.length }, policy: value.policy }
  }
  private matches(thread: LibraryThread, request: Query) { return (!request.provider || (thread.sourceKind === 'chatgpt' ? 'chatgpt' : 'codex') === request.provider) && (request.kind === 'all' || thread.kind === request.kind) && (!request.thread || thread.threadId === request.thread) }
  entries(input: unknown) {
    const request = LibraryQuery.parse(input), value = this.load(), byId = new Map(value.threads.map(thread => [thread.threadId, thread]))
    const words = request.q.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const insightIds = request.insight ? new Set(value.insights.find(item => item.id === request.insight)?.entryIds ?? []) : undefined
    const all = value.entries.filter(entry => {
      const thread = byId.get(entry.threadId)!
      const text = [entry.question, entry.answer, thread.title, thread.projectName, ...entry.topics.map(t => topics.find(topic => topic.id === t.id)?.name)].join(' ').toLocaleLowerCase()
      return this.matches(thread, request) && (!request.topic || entry.topics.some(topic => topic.id === request.topic))
        && (!insightIds || insightIds.has(entry.id))
        && (request.pending !== 'true' || entry.evidence?.needsReview || !entry.topics.length || !entry.answered || entry.truncated || thread.scan.state !== 'complete') && words.every(word => text.includes(word))
    }).sort((a,b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
    return { total: all.length, nextOffset: request.offset + request.limit < all.length ? request.offset + request.limit : null,
      entries: all.slice(request.offset, request.offset + request.limit).map(entry => ({ ...entry, thread: byId.get(entry.threadId)! })) }
  }
  threads(input: unknown) {
    const request = LibraryQuery.parse(input), value = this.load(), words = request.q.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const all = value.threads.filter(thread => this.matches(thread, request)
      && (request.pending !== 'true' || thread.scan.state !== 'complete' || !value.entries.some(entry => entry.threadId === thread.threadId))
      && words.every(word => (thread.title + ' ' + thread.projectName).toLocaleLowerCase().includes(word)))
    return { total: all.length, nextOffset: request.offset + request.limit < all.length ? request.offset + request.limit : null,
      threads: all.slice(request.offset, request.offset + request.limit).map(thread => ({ ...thread, pairs: value.entries.filter(entry => entry.threadId === thread.threadId).length })) }
  }
  entry(id: string) { return this.load().entries.find(entry => entry.id === id) }
  classifiedGraph() { return classifiedKnowledge(this.load(), this.error) }
  relationEntries(source: string, target: string, offset = 0) {
    const value=this.load(),graph=this.classifiedGraph()
    const edge=graph.edges.find(e=>e.kind==='co-discussed'&&e.source===source&&e.target===target)
    if(!edge)return {total:0,nextOffset:null,entries:[]}
    const threads=new Map(value.threads.map(t=>[t.threadId,t]))
    const all=value.entries.filter(entry=>{const thread=threads.get(entry.threadId);if(!thread)return false;const ids=relationTopics(entry,thread);return ids.includes(source.slice(6))&&ids.includes(target.slice(6))})
    return {total:all.length,nextOffset:offset+10<all.length?offset+10:null,entries:all.slice(offset,offset+10).map(entry=>({...entry,thread:threads.get(entry.threadId)!}))}
  }
  graphifySample(theme: string) {
    const rules:Record<string,RegExp>={'runtime-memory':/GC\.Alloc|托管堆|垃圾回收|Managed.?Heap|GC.*分配/i,'render-performance':/FrameTicket|帧同步|GPUScene|渲染线程.*同步|CPU.*GPU.*等待/i,'wasm-delivery':/WebCIL|WASM.*加载|代码膨胀|程序集裁剪|IL2CPP.*Mono/i}
    const pattern=rules[theme];if(!pattern)throw Error('Unknown Graphify sample')
    const value=this.load(),threads=new Map(value.threads.map(t=>[t.threadId,t]))
    const candidates=value.entries.filter(e=>threads.get(e.threadId)?.kind==='discussion'&&e.answered&&!e.truncated&&e.answer.length>=40&&(!e.evidence?.answerState||e.evidence.answerState==='historical_answer')&&pattern.test(e.question+' '+e.answer))
      .sort((a,b)=>Number(pattern.test(b.question))-Number(pattern.test(a.question))||a.id.localeCompare(b.id))
    const seen=new Set<string>(),chosen=[]
    for(const entry of candidates){if(seen.has(entry.threadId))continue;seen.add(entry.threadId);chosen.push(entry);if(chosen.length===8)break}
    return chosen.map(e=>({entryId:e.id,threadId:e.threadId,turnIds:e.evidence?.turnIds??[e.turnId],provider:e.evidence?.provider??'codex',title:threads.get(e.threadId)!.title,
      question:e.question.slice(0,1200),answer:e.answer.slice(0,2400),topicIds:e.topics.map(t=>t.id)}))
  }
  graphifyExpandedSample() {
    const value=this.load(),threads=new Map(value.threads.map(t=>[t.threadId,t]))
    const eligible=value.entries.filter(e=>threads.get(e.threadId)?.kind==='discussion'&&e.answered&&!e.truncated&&e.answer.length>=40&&(!e.evidence?.answerState||e.evidence.answerState==='historical_answer'))
    const chosen:typeof eligible=[],ids=new Set<string>(),sources=new Set<string>()
    const groups:[RegExp,number][]=[[/GC\.Alloc|托管堆|垃圾回收|非移动|Boehm|SGen|托管.*分配|内存.*分配|Memory.?Profiler/i,30],[/FrameTicket|帧同步|GPUScene|渲染线程|CPU.*GPU.*等待/i,10],[/WebCIL|WASM|程序集裁剪|IL2CPP/i,10]]
    const add=(entry:typeof eligible[number])=>{chosen.push(entry);ids.add(entry.id);sources.add(entry.threadId)}
    for(const [pattern,count] of groups){
      const rows=eligible.filter(e=>!ids.has(e.id)&&pattern.test(e.question+' '+e.answer)).sort((a,b)=>Number(pattern.test(b.question))-Number(pattern.test(a.question))||a.id.localeCompare(b.id))
      const end=chosen.length+count
      for(const provider of ['codex','chatgpt']){const entry=rows.find(e=>!ids.has(e.id)&&(e.evidence?.provider??'codex')===provider&&!sources.has(e.threadId));if(entry&&chosen.length<end)add(entry)}
      for(const entry of rows){if(chosen.length>=end)break;if(!ids.has(entry.id)&&!sources.has(entry.threadId))add(entry)}
      for(const entry of rows){if(chosen.length>=end)break;if(!ids.has(entry.id))add(entry)}
    }
    return chosen.map(e=>({entryId:e.id,threadId:e.threadId,turnIds:e.evidence?.turnIds??[e.turnId],provider:e.evidence?.provider??'codex',title:threads.get(e.threadId)!.title,question:e.question.slice(0,1200),answer:e.answer.slice(0,2400),topicIds:e.topics.map(t=>t.id)}))
  }
  graphifyBaseline() {
    const value=this.load(),graph=this.classifiedGraph(),byId=new Map(value.entries.map(e=>[e.id,e]))
    const references=(ids:string[])=>ids.flatMap(id=>{const e=byId.get(id);return e?[{entryId:e.id,threadId:e.threadId,turnIds:e.evidence?.turnIds??[e.turnId],provider:e.evidence?.provider??'codex',quote:e.question.slice(0,500)}]:[]})
    return {version:1,builtAt:value.builtAt,domains:knowledgeDomains,stats:graph.stats,
      nodes:graph.nodes.filter(n=>n.kind==='topic'&&n.domainId).map(n=>({id:n.id.replace(':','_'),label:n.title,file_type:'document',source_file:'derived/knowledge-library',domainIds:[n.domainId],origin:'candidate-overview',pairs:n.pairs})),
      edges:graph.edges.flatMap(e=>e.kind==='co-discussed'?[{source:e.source.replace(':','_'),target:e.target.replace(':','_'),relation:'co_discussed_in_derived_qa',confidence:'AMBIGUOUS',confidence_score:0,
        source_file:'derived/knowledge-library',origin:'candidate-overview',weight:e.support.association,support:e.support,evidence:references(e.support.entryIds),explanation:'同问答专题共现，仅作未评估的候选关联。'}]:[])}
  }
  /** Shared navigation tree for people and the master. Membership is classification, never a causal claim. */
  tree() {
    const value = this.load()
    return { builtAt: value.builtAt, error: this.error, semanticClaimsVerified: false,
      domains: knowledgeDomains.map(domain => ({ ...domain, topics: topics.filter(topic => topic.domainId === domain.id).map(topic => {
        const entries = value.entries.filter(entry => entry.topics.some(item => item.id === topic.id))
        return { ...topic, pairs: entries.length, threadIds: [...new Set(entries.map(entry => entry.threadId))] }
      }) })), unassigned: value.entries.filter(entry => !entry.topics.length).length }
  }
}

/** Exact source lookup. Only source IDs already present in a validated local entry can be requested. */
export async function readLibraryEvidence(entry: LibraryEntry, create = () => new CodexReadClient(30000)) {
  if (entry.method === 'model-extraction') throw Error('Use the cited original conversation and turns; message IDs were not retained by extraction')
  const reader = create(), allowed = new Map([...entry.questionMessageIds.map(id => [id, 'user'] as const), ...entry.answerMessageIds.map(id => [id, 'assistant'] as const)])
  try {
    await reader.initialize()
    const messages: { id: string; role: 'user' | 'assistant'; text: string }[] = [], seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await reader.request('thread/items/list', { threadId: entry.threadId, turnId: entry.turnId, limit: 20, sortDirection: 'asc', ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(page.data)) throw Error('Invalid evidence page')
      for (const row of page.data) {
        if (row.turnId !== entry.turnId) throw Error('Evidence turn mismatch')
        const item = row.item, role = allowed.get(item?.id)
        if (!role || (role === 'user' ? item.type !== 'userMessage' : item.type !== 'agentMessage' || (item.phase && item.phase !== 'final_answer'))) continue
        const text = role === 'user' ? (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => String(part.text ?? '')).join('\n') : String(item.text ?? '')
        messages.push({ id: item.id, role, text: safeKnowledgeText(text).slice(0, 40000) })
      }
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw Error('Evidence cursor repeated')
      if (cursor) seen.add(cursor)
      if (seen.size > 1000) throw Error('Evidence page budget exceeded')
    } while (cursor)
    if (!messages.some(message => message.role === 'user')) throw Error('Question evidence unavailable')
    return { threadId: entry.threadId, turnId: entry.turnId, messages, answerAvailable: messages.some(message => message.role === 'assistant') }
  } finally { reader.close() }
}
