import { expect, it } from 'vitest'
import { classifiedKnowledge } from '../src/app/classified-knowledge.ts'
import { classifiedLayout } from '../src/client/classified-layout.ts'
import type { KnowledgeLibrary, LibraryEntry } from '../src/app/knowledge-organizer.ts'

export function fixture(): KnowledgeLibrary {
  const threads = [0,1,2].map(i=>({ threadId:`00000000-0000-4000-8000-00000000000${i}`,title:['GPUScene 讨论','GC 讨论','未知内容'][i]!,cwd:i?'':'F:/Game',projectName:i?'Cloud':'Game',updatedAt:1,archived:false,sourceKind:i?'chatgpt':'codex',kind:'discussion' as const,
    scan:{state:'complete' as const,pages:0,turns:1,truncated:false} }))
  const entries: LibraryEntry[] = [
    [0,['scene-data','frame-sync']], [0,['scene-data','session-system']], [1,['mono-gc']], [2,[]],
  ].map(([i,ids],n)=>({id:'entry-'+n,threadId:threads[i as number]!.threadId,turnId:'turn-'+n,questionMessageIds:[],answerMessageIds:[],question:'question',answer:'answer',startedAt:1,answered:true,truncated:false,
    topics:(ids as string[]).map(id=>({id,score:3,basis:'question-answer' as const})),method:'model-extraction',review:'source-not-verified',evidence:{provider:i?'chatgpt':'codex',turnIds:['turn-'+n],needsReview:n===1} }))
  return {version:1,taxonomyVersion:2,builtAt:'2026-11-05T00:00:00Z',inventoryAt:'',status:'partial',threads,entries,insights:[],policy:{rawTranscriptsPersisted:false,modelCalls:true,agentIntegration:true}}
}
it('replaces similarity clusters with seven domains, topics and all local/cloud sources',()=>{
  const g=classifiedKnowledge(fixture())
  expect(g.nodes.filter(n=>n.kind==='domain')).toHaveLength(7)
  expect(g.stats).toMatchObject({sources:3,local:1,cloud:2,unassignedSources:1,unassignedPairs:1})
  const source=g.nodes.find(n=>n.id.endsWith('00000000-0000-4000-8000-000000000000'))!
  expect(source).toMatchObject({domainId:'graphics',topicId:'scene-data',pending:true})
  expect(source.source!.topicIds).toContain('session-system')
  const byId=new Map(g.nodes.map(n=>[n.id,n]))
  for(const edge of g.edges){
    expect(byId.has(edge.source)&&byId.has(edge.target)).toBe(true)
    expect(byId.get(edge.source)!.kind).not.toBe('source')
    expect(edge.kind).toBe('contains')
  }
  for(const source of g.nodes.filter(n=>n.kind==='source'))expect(g.edges.filter(e=>e.target===source.id)).toHaveLength(1)
})
it('lays out every source once without reading the old layout cache, and supports collapsed domains',()=>{
  const graph=classifiedKnowledge(fixture()), points=classifiedLayout(graph.nodes)
  expect(points).toHaveLength(graph.nodes.length)
  expect(new Set(points.map(p=>p.id)).size).toBe(points.length)
  expect(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.r>0)).toBe(true)
  expect(classifiedLayout(graph.nodes)).toEqual(points)
  expect(classifiedLayout(graph.nodes,false).some(p=>p.kind==='source')).toBe(false)
})
