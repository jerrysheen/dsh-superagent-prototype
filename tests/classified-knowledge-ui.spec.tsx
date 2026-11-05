// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeGraphWindow } from '../src/client/knowledge-graph.tsx'
import { classifiedKnowledge } from '../src/app/classified-knowledge.ts'
import type { KnowledgeLibrary } from '../src/app/knowledge-organizer.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.replaceChildren();vi.unstubAllGlobals();vi.restoreAllMocks()})
function graph() {
  const library:KnowledgeLibrary={version:1,taxonomyVersion:2,builtAt:'2026-11-05T00:00:00Z',inventoryAt:'',status:'partial',threads:[{threadId:'00000000-0000-4000-8000-000000000001',title:'云端 GC 讨论',cwd:'',projectName:'Cloud',updatedAt:1,archived:false,sourceKind:'chatgpt',kind:'discussion',scan:{state:'complete',pages:0,turns:1,truncated:false}}],entries:[{id:'qa',threadId:'00000000-0000-4000-8000-000000000001',turnId:'turn',questionMessageIds:[],answerMessageIds:[],question:'GC',answer:'Historical answer',startedAt:1,answered:true,truncated:false,topics:[{id:'mono-gc',score:3,basis:'question-answer'}],method:'model-extraction',review:'source-not-verified',evidence:{provider:'chatgpt',turnIds:['turn'],needsReview:false}}],insights:[],policy:{rawTranscriptsPersisted:false,modelCalls:true,agentIntegration:true}}
  return classifiedKnowledge(library)
}
it('opens the new classified graph by default, expands a topic and preserves cloud source links',async()=>{
  const fetcher=vi.fn(async(url:unknown)=>String(url).includes('knowledge-classified')?Response.json(graph()):Response.json({entries:[],total:0,nextOffset:null}))
  vi.stubGlobal('fetch',fetcher)
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  expect(host.querySelectorAll('[data-node-kind=domain]')).toHaveLength(7)
  expect(host.querySelectorAll('[data-node-kind=source]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-membership=source]')).toHaveLength(1)
  expect(fetcher).toHaveBeenCalledWith('/session-hub/api/knowledge-classified',expect.anything())
  expect(fetcher.mock.calls.every(([url])=>String(url)!=='/session-hub/api/knowledge')).toBe(true)
  const topic=host.querySelector('[data-classified-node="topic:mono-gc"]')!
  await act(async()=>topic.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  expect(host.querySelector('[aria-label="分类与来源详情"]')?.textContent).toContain('Mono、GC 与托管堆')
  await act(async()=>host.querySelector('[data-node-kind=source]')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  expect(host.querySelector('.kg-node-actions a')?.getAttribute('href')).toBe('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001')
  expect(host.querySelector('.kg-node-actions')?.textContent).not.toContain('在 Codex 打开')
})
it('reveals source names on hover and zoom while keeping dots small and membership lines visible',async()=>{
  const frames=new Map<number,FrameRequestCallback>();let next=0
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++next,callback);return next})
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(graph())))
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  const svg=host.querySelector('svg')!,source=host.querySelector<SVGGElement>('[data-node-kind=source]')!,label=source.querySelector('.cg-label')!
  svg.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:540} as DOMRect)
  expect(label.textContent).toContain('云端 GC 讨论')
  expect(label.hasAttribute('data-visible')).toBe(false)
  source.dispatchEvent(new MouseEvent('pointerover',{bubbles:true}))
  expect(label.hasAttribute('data-visible')).toBe(true)
  expect(host.querySelector('[data-membership=source]')?.hasAttribute('data-highlight')).toBe(true)
  svg.dispatchEvent(new MouseEvent('pointerleave'))
  const [x,y]=source.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  for(let i=0;i<3;i++)svg.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,clientX:x,clientY:y,cancelable:true}))
  const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(16)
  expect(label.hasAttribute('data-visible')).toBe(true)
  for(const circle of host.querySelectorAll('.cg-dot'))expect(Number(circle.getAttribute('r'))*20).toBeLessThanOrEqual(10.001)
  expect(host.querySelectorAll('[data-membership=source]')).toHaveLength(1)
})
it('filters local/cloud source nodes without sending messages or rebuilding transcript indexes',async()=>{
  const fetcher=vi.fn(async()=>Response.json(graph()));vi.stubGlobal('fetch',fetcher)
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  const select=host.querySelector<HTMLSelectElement>('[aria-label="来源范围"]')!
  await act(async()=>{select.value='codex';select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(host.querySelectorAll('[data-node-kind=source]')).toHaveLength(0)
  expect(host.textContent).toContain('当前范围没有来源会话')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('includes cross-topic sources in a focused topic while keeping their original main assignment',async()=>{
  const data=graph(),source=data.nodes.find(n=>n.kind==='source')!
  source.source!.topicIds.push('session-system')
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).includes('knowledge-classified')?Response.json(data):Response.json({entries:[],total:0,nextOffset:null})))
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  await act(async()=>host.querySelector('[data-classified-node="topic:session-system"]')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  expect(host.querySelectorAll('[data-node-kind=source]')).toHaveLength(1)
  await act(async()=>host.querySelector('[data-node-kind=source]')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  const topics=host.querySelectorAll('.cg-topic-row')
  expect(topics[0]?.textContent).toContain('Mono、GC 与托管堆主归属')
  expect(topics[1]?.textContent).toContain('会话协作与任务中枢交叉归属')
})
it('keeps unassigned sources separate and focuses them without seven empty domain groups',async()=>{
  const data=graph(),source=data.nodes.find(n=>n.kind==='source')!
  source.domainId='';source.topicId='unassigned';source.source!.topicIds=[]
  data.nodes.push({id:'topic:unassigned',kind:'topic',title:'待归类',summary:'待复核',domainId:'',topicId:'unassigned',pairs:1,sources:1,pending:true})
  data.edges=data.edges.filter(e=>e.target!==source.id).concat({source:'topic:unassigned',target:source.id,kind:'contains'})
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).includes('knowledge-classified')?Response.json(data):Response.json({entries:[],total:0,nextOffset:null})))
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  await act(async()=>host.querySelector('[data-classified-node="topic:unassigned"]')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  expect(host.querySelectorAll('[data-node-kind=domain]')).toHaveLength(0)
  expect(host.querySelectorAll('[data-node-kind=source]')).toHaveLength(1)
})
