import {expect,it} from 'vitest'
import {validateCorpusExtraction,resolveCorpusLocations,planCorpusTasks,CORPUS_OUTPUT_BUDGET,CORPUS_OUTPUT_HARD_LIMIT,type CorpusDocument} from '../src/app/graphify-corpus.ts'
const doc:CorpusDocument={id:'a'.repeat(64),path:'sessions/one/part-1.md',sourceId:'one',provider:'codex',title:'GC',text:'垃圾回收器扫描托管堆，识别不可达对象。',domainHints:['runtime'],locations:[],part:1,parts:1,inputPartial:false}
const make=()=>({nodes:[{id:'gc',label:'垃圾回收器',file_type:'document',source_file:doc.path,domainIds:['runtime'],evidence:[{source_file:doc.path,quote:doc.text}]},{id:'managed_heap',label:'托管堆',file_type:'document',source_file:doc.path,domainIds:['runtime'],evidence:[{source_file:doc.path,quote:doc.text}]}],edges:[{source:'gc',target:'managed_heap',relation:'scans',confidence:'EXTRACTED',confidence_score:1,source_file:doc.path,evidence:[{source_file:doc.path,quote:doc.text}],explanation:'提炼中的明确关系'}],hyperedges:[],unassignedFiles:[]})
it('keeps native Graphify fields and verifies document citations',()=>{
  expect(validateCorpusExtraction(make(),[doc]).edges[0]!.relation).toBe('scans')
  const bad=make();bad.edges[0]!.evidence[0]!.quote='这段引用并未出现在输入文档里'
  expect(()=>validateCorpusExtraction(bad,[doc])).toThrow('QUOTE_NOT_IN_DOCUMENT')
  expect(()=>validateCorpusExtraction(make(),[doc,{...doc,id:'b'.repeat(64),path:'sessions/two/part-1.md'}])).toThrow('DOCUMENT_SILENTLY_OMITTED')
})
it('bounds input batches and the hard output ceiling without losing documents',()=>{
  const documents=Array.from({length:11},(_,i)=>({id:String(i),path:String(i),sourceId:String(i),chars:9000,domain:'runtime'}))
  const tasks=planCorpusTasks({version:1,planId:'p',sources:[],documents},'prompt')
  expect(tasks.flatMap(t=>t.documents)).toEqual(documents.map(d=>d.id))
  expect(tasks.every(t=>t.documents.length<=2)).toBe(true)
  expect(CORPUS_OUTPUT_BUDGET).toBeLessThanOrEqual(CORPUS_OUTPUT_HARD_LIMIT)
  expect(CORPUS_OUTPUT_HARD_LIMIT).toBe(12000)
})
it('copies exact evidence from native source_file/source_location references',()=>{
  const native={nodes:[{id:'gc',label:'垃圾回收',file_type:'document',source_file:'doc_1.md',source_location:'L1',domainIds:['runtime']}],edges:[],hyperedges:[],unassignedFiles:[]}
  const parsed=validateCorpusExtraction(resolveCorpusLocations(native,[doc]),[doc])
  expect(parsed.nodes[0]!.evidence[0]!.quote).toBe(doc.text)
  expect(()=>resolveCorpusLocations({...native,nodes:[{...native.nodes[0]!,source_location:'L999'}]},[doc])).toThrow('INVALID_LINE_RANGE')
})
it('normalizes native identifier casing consistently and rejects collisions',()=>{
  const value=make();value.nodes[0]!.id='leanCLR';value.edges[0]!.source='leanCLR'
  expect(validateCorpusExtraction(value,[doc]).edges[0]!.source).toBe('leanclr')
  value.nodes[1]!.id='leanclr'
  expect(()=>validateCorpusExtraction(value,[doc])).toThrow('DUPLICATE_NODE_IDS')
})
