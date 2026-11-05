import {expect,it} from 'vitest'
import {validateReconciliation,graphConceptMentioned} from '../src/app/graphify-expanded.ts'
import type {GraphifySample} from '../src/app/graphify-jobs.ts'
const quote='非移动 GC 是垃圾回收的一种策略，存活对象的地址不会被搬移。'
const samples:GraphifySample[]=[{entryId:'entry',threadId:'source',turnIds:['turn'],provider:'codex',title:'GC',question:'非移动 GC 与垃圾回收是什么关系？',answer:quote,topicIds:['mono-gc']}]
const nodes=[{id:'garbage_collection',label:'垃圾回收',domainIds:['runtime'],entryIds:['entry']},{id:'non_moving_gc',label:'非移动 GC',domainIds:['runtime'],entryIds:['entry']},{id:'nonmoving_alias',label:'非移动垃圾回收',domainIds:['runtime'],entryIds:['entry']}]
const evidence=[{entryId:'entry',quote}]
it('allows supported alias consolidation and cross-batch edges while preserving distinct GC concepts',()=>{
  const result=validateReconciliation({merges:[{from:'nonmoving_alias',to:'non_moving_gc',explanation:'同一策略的别名',evidence}],edges:[{source:'non_moving_gc',target:'garbage_collection',relation:'related_to',confidence:'EXTRACTED',confidence_score:1,explanation:'摘要陈述的策略归属',evidence}]},nodes,samples)
  expect(result.merges).toHaveLength(1);expect(result.edges).toHaveLength(1)
  expect(()=>validateReconciliation({merges:[{from:'non_moving_gc',to:'garbage_collection',explanation:'错误合并上下位概念',evidence}],edges:[]},nodes,samples)).toThrow('DISTINCT_CANONICAL_CONCEPTS')
})
it('rejects ungrounded links and cyclic merges',()=>{
  expect(()=>validateReconciliation({merges:[],edges:[{source:'non_moving_gc',target:'garbage_collection',relation:'related_to',confidence:'INFERRED',confidence_score:.8,explanation:'猜测',evidence:[{entryId:'entry',quote:'原文并没有出现的关系句子'}]}]},nodes,samples)).toThrow('INVALID_REVIEW_QUOTE')
  const aliases=[{id:'alias_one',label:'别名一',domainIds:['runtime'],entryIds:['entry']},{id:'alias_two',label:'别名二',domainIds:['runtime'],entryIds:['entry']}]
  expect(()=>validateReconciliation({merges:[{from:'alias_one',to:'alias_two',explanation:'同义',evidence},{from:'alias_two',to:'alias_one',explanation:'同义',evidence}],edges:[]},aliases,samples)).toThrow('CYCLIC_MERGE')
})
it('admits newly discovered literal cross-batch mentions without confusing GC.Alloc with GC',()=>{
  const heap={id:'managed_heap',label:'托管堆',domainIds:['runtime'],entryIds:['older']}
  const gc={id:'garbage_collection',label:'垃圾回收',domainIds:['runtime'],entryIds:['older']}
  const current={...samples[0]!,entryId:'newer',answer:'GC 可以回收托管堆中的不可达对象。'}
  const edge={source:'garbage_collection',target:'managed_heap',relation:'reclaims',confidence:'EXTRACTED',confidence_score:1,evidence:[{entryId:'newer',quote:current.answer}],explanation:'新批次中明确提及两端概念'}
  expect(validateReconciliation({merges:[],edges:[edge]},[heap,gc],[current]).edges).toHaveLength(1)
  expect(graphConceptMentioned(gc,'GC.Alloc 记录分配')).toBe(false)
  expect(graphConceptMentioned(heap,'捕获变量和 lambda/delegate 可能分配')).toBe(false)
})
