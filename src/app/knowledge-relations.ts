/** Candidate associations backed by the same recovered question group, never by folder membership. */
import { knowledgeTopics } from './knowledge-taxonomy.ts'
import type { KnowledgeLibrary, LibraryEntry, LibraryThread } from './knowledge-organizer.ts'

const topics = new Map(knowledgeTopics.map(topic=>[topic.id,topic]))
export function relationTopics(entry: LibraryEntry, thread: LibraryThread) {
  if(thread.kind!=='discussion'||entry.truncated)return []
  return [...new Set(entry.topics.filter(item=>item.basis==='question-answer'&&topics.get(item.id)?.pattern.test(entry.question+' '+entry.answer)).map(item=>item.id))].sort()
}
export interface KnowledgeAssociation {
  source: string; target: string; kind: 'co-discussed'; confidence: 'INFERRED'
  support: { pairs: number; sources: number; entryIds: string[]; crossDomain: boolean; association: number }
}
export function knowledgeAssociations(library: KnowledgeLibrary): KnowledgeAssociation[] {
  const threads=new Map(library.threads.map(t=>[t.threadId,t])),totals=new Map<string,number>()
  const pairs=new Map<string,{a:string;b:string;ids:string[];sources:Set<string>}>()
  for(const entry of library.entries){
    const thread=threads.get(entry.threadId);if(!thread)continue
    const ids=relationTopics(entry,thread)
    for(const id of ids)totals.set(id,(totals.get(id)??0)+1)
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
      const a=ids[i]!,b=ids[j]!,key=a+'|'+b
      const row=pairs.get(key)??{a,b,ids:[],sources:new Set<string>()}
      row.ids.push(entry.id);row.sources.add(entry.threadId);pairs.set(key,row)
    }
  }
  return [...pairs.values()].filter(row=>row.ids.length>=3&&row.sources.size>=2).map(row=>({
    source:'topic:'+row.a,target:'topic:'+row.b,kind:'co-discussed' as const,confidence:'INFERRED' as const,
    support:{pairs:row.ids.length,sources:row.sources.size,entryIds:row.ids.slice(0,8),
      crossDomain:topics.get(row.a)!.domainId!==topics.get(row.b)!.domainId,
      association:row.ids.length/((totals.get(row.a)??0)+(totals.get(row.b)??0)-row.ids.length)},
  })).sort((a,b)=>b.support.sources-a.support.sources||b.support.pairs-a.support.pairs||a.source.localeCompare(b.source)||a.target.localeCompare(b.target))
}
