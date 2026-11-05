import {it,expect} from 'vitest'
import {validateGlobalReview,type ReviewInput} from '../src/app/graphify-review.ts'
const input:ReviewInput={focalIds:['gc'],nodes:[{id:'gc',label:'垃圾回收',aliases:[],domainIds:['runtime'],evidenceIds:['a']},{id:'heap',label:'托管堆',aliases:[],domainIds:['runtime'],evidenceIds:['b']}],candidatePairs:[['gc','heap']],evidence:{a:{source_file:'one.md',quote:'垃圾回收器扫描托管堆并回收不可达对象。',threadId:'one'},b:{source_file:'two.md',quote:'托管堆保存对象，垃圾回收会扫描这些对象。',threadId:'two'}}}
const valid=()=>({reviewedIds:['gc'],merges:[],edges:[{source:'gc',target:'heap',relation:'scans',confidence:'EXTRACTED',confidence_score:1,explanation:'两个来源的提炼均明确描述扫描关系。',evidenceIds:['a','b']}]})
it('requires evidence from both endpoints and complete focal coverage',()=>{
  expect(validateGlobalReview(valid(),input).edges[0]!.evidence[0]!.quote).toBe(input.evidence.a!.quote)
  expect(validateGlobalReview({...valid(),reviewedIds:['gc','heap']},input).reviewedIds).toEqual(['gc'])
  const bad=valid();bad.edges[0]!.evidenceIds=['a'];expect(validateGlobalReview(bad,input).rejectedEdges[0]!.reason).toContain('BOTH_ENDPOINTS')
  expect(()=>validateGlobalReview({...valid(),reviewedIds:[]},input)).toThrow('FOCAL_REVIEW_INCOMPLETE')
})
it('discards individual extracted claims without a joint citation',()=>{
  const altered={...input,evidence:{a:{...input.evidence.a!,quote:'垃圾回收器的执行有一定开销。'},b:{...input.evidence.b!,quote:'托管堆保存对象的内容。'}}}
  const result=validateGlobalReview(valid(),altered)
  expect(result.edges).toHaveLength(0)
  expect(result.rejectedEdges[0]!.reason).toContain('JOINT_CITATION')
})
