import { knowledgeAssociations, type KnowledgeAssociation } from './knowledge-relations.ts'
/** Classification and evidence-backed candidate associations share one graph. */
import type { KnowledgeLibrary, LibraryThread } from './knowledge-organizer.ts'
import { knowledgeDomains, publicKnowledgeTopics } from './knowledge-taxonomy.ts'

export interface ClassifiedNode {
  id: string; kind: 'domain' | 'topic' | 'source'; title: string; summary: string
  domainId: string; topicId?: string; pairs: number; sources: number; pending: boolean
  source?: LibraryThread & { provider: 'codex' | 'chatgpt'; topicIds: string[]; unassignedPairs: number; associations?: number; crossDomainAssociations?: number }
}
export type ClassifiedEdge = { source: string; target: string; kind: 'contains' } | KnowledgeAssociation
export interface ClassifiedGraph {
  version: 1; taxonomyVersion: 2; relationVersion?: 1; builtAt: string; error: string
  nodes: ClassifiedNode[]; edges: ClassifiedEdge[]
  stats: { domains: number; topics: number; sources: number; local: number; cloud: number; pairs: number; unassignedSources: number; unassignedPairs: number; associations?: number; crossDomainAssociations?: number }
}

export function classifiedKnowledge(library: KnowledgeLibrary, error = ''): ClassifiedGraph {
  const topics = publicKnowledgeTopics(), byTopic = new Map(topics.map(t => [t.id,t]))
  const rows = new Map(library.threads.map(thread => [thread.threadId, { thread, weights: new Map<string,number>(), pairs: 0, unassigned: 0, pending: thread.scan.state !== 'complete' }]))
  const pairs = new Map<string,number>()
  for (const entry of library.entries) {
    const row = rows.get(entry.threadId)
    if (!row) continue
    row.pairs++; row.pending ||= !!entry.evidence?.needsReview || entry.truncated
    if (!entry.topics.length) row.unassigned++
    for (const topic of entry.topics) if (byTopic.has(topic.id)) {
      // One question group contributes once to a topic. Source/project names cannot assign it.
      row.weights.set(topic.id,(row.weights.get(topic.id) ?? 0)+1)
      pairs.set(topic.id,(pairs.get(topic.id) ?? 0)+1)
    }
  }
  const sourceNodes: ClassifiedNode[] = [...rows.values()].map(row => {
    const ranked = [...row.weights].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
    const domains = new Map<string,number>()
    for (const [id,weight] of ranked) { const d=byTopic.get(id)!.domainId; domains.set(d,(domains.get(d) ?? 0)+weight) }
    const domainId = [...domains].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
    const primary = ranked.find(([id])=>byTopic.get(id)!.domainId===domainId)?.[0] ?? 'unassigned'
    return { id: 'source:'+row.thread.threadId, kind: 'source', title: row.thread.title, summary: '', domainId, topicId: primary,
      pairs: row.pairs, sources: 1, pending: row.pending,
      source: { ...row.thread, provider: row.thread.sourceKind === 'chatgpt' ? 'chatgpt' : 'codex', topicIds: ranked.map(([id])=>id), unassignedPairs: row.unassigned } }
  })
  const nodes: ClassifiedNode[] = knowledgeDomains.map(d => ({ id:'domain:'+d.id,kind:'domain',title:d.name,summary:d.summary,domainId:d.id,
    sources: sourceNodes.filter(n=>n.domainId===d.id).length, pairs: library.entries.filter(e=>e.topics.some(t=>byTopic.get(t.id)?.domainId===d.id)).length, pending:false }))
  nodes.push(...topics.map(t=>({ id:'topic:'+t.id,kind:'topic' as const,title:t.name,summary:t.summary,domainId:t.domainId,topicId:t.id,
    sources:sourceNodes.filter(n=>n.topicId===t.id).length,pairs:pairs.get(t.id) ?? 0,pending:false })))
  const unassigned = sourceNodes.filter(n=>!n.domainId)
  if (unassigned.length) nodes.push({ id:'topic:unassigned',kind:'topic',title:'待归类',summary:'尚无专题依据的来源保留在这里。',domainId:'',topicId:'unassigned',sources:unassigned.length,pairs:unassigned.reduce((s,n)=>s+n.pairs,0),pending:true })
  nodes.push(...sourceNodes)
  const edges: ClassifiedEdge[] = [
    ...topics.map(t=>({ source:'domain:'+t.domainId,target:'topic:'+t.id,kind:'contains' as const })),
    ...sourceNodes.map(n=>({ source:'topic:'+n.topicId,target:n.id,kind:'contains' as const })),
  ]
  const associations=knowledgeAssociations(library)
  edges.push(...associations)
  return { version:1,taxonomyVersion:2,relationVersion:1,builtAt:library.builtAt,error,nodes,edges,
    stats:{ domains:knowledgeDomains.length,topics:topics.length,sources:sourceNodes.length,
      local:sourceNodes.filter(n=>n.source?.provider==='codex').length,cloud:sourceNodes.filter(n=>n.source?.provider==='chatgpt').length,
      associations:associations.length,crossDomainAssociations:associations.filter(e=>e.support.crossDomain).length,
      pairs:library.entries.length,unassignedSources:unassigned.length,unassignedPairs:library.entries.filter(e=>!e.topics.length).length } }
}
