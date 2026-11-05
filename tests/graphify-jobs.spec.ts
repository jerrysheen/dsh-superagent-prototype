import { expect,it } from 'vitest'
import { validateGraphifyExtraction, type GraphifySample } from '../src/app/graphify-jobs.ts'
const samples:GraphifySample[]=[{entryId:'qa',threadId:'00000000-0000-4000-8000-000000000001',turnIds:['turn'],provider:'codex',title:'GC',question:'Profiler 如何观测 GC 分配？',answer:'Profiler 可以用于观察托管堆对象的分配情况。',topicIds:['mono-gc','memory-analysis']}]
function result(){return {nodes:[{id:'profiler',label:'Profiler',domainIds:['diagnostics'],entryIds:['qa']},{id:'managed_heap',label:'托管堆',domainIds:['runtime'],entryIds:['qa']}],edges:[{source:'profiler',target:'managed_heap',relation:'measures',confidence:'EXTRACTED',confidence_score:1,evidence:[{entryId:'qa',quote:'Profiler 可以用于观察托管堆对象的分配情况。'}],explanation:'摘要中的明确描述，历史内容待复核。'}],unassignedEntryIds:[]}}
it('accepts only cited concepts, known domains and verbatim derivative evidence',()=>{expect(validateGraphifyExtraction(result(),samples).edges).toHaveLength(1)})
it('lowers inconsistent explicit confidence instead of inventing certainty',()=>{
  const proposal=result();proposal.edges[0]!.confidence_score=.85
  const validated=validateGraphifyExtraction(proposal,samples)
  expect(validated.edges[0]).toMatchObject({confidence:'INFERRED',confidence_score:.85})
  proposal.edges[0]!.evidence[0]!.quote='这句话不在给定输入提炼之中'
  expect(()=>validateGraphifyExtraction(proposal,samples)).toThrow('Quote')
})
it('rejects invented quotes, domain IDs, dangling endpoints and silently omitted inputs',()=>{
  const quote=result();quote.edges[0]!.evidence[0]!.quote='没有在输入中出现的关系证据';expect(()=>validateGraphifyExtraction(quote,samples)).toThrow('Quote')
  const domain=result();domain.nodes[0]!.domainIds=['imagined'];expect(()=>validateGraphifyExtraction(domain,samples)).toThrow('Unknown')
  const endpoint=result();endpoint.edges[0]!.target='not_present';expect(()=>validateGraphifyExtraction(endpoint,samples)).toThrow('endpoint')
  expect(()=>validateGraphifyExtraction(result(),[...samples,{...samples[0]!,entryId:'forgotten'}])).toThrow('omitted')
})
