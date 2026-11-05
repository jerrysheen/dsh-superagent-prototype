// @vitest-environment jsdom
import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {GraphifyWindow as KnowledgeGraphWindow} from '../src/client/graphify-window.tsx'
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.replaceChildren();vi.unstubAllGlobals()})
it('embeds the native Graphify viewer in an isolated frame and does not start model jobs on load',async()=>{
  const fetcher=vi.fn(async(_url:unknown)=>Response.json({available:true,manifest:{builtAt:'now',nodes:43,edges:50,communities:7,llmBatches:0,llmSampleEntries:0,clustering:'Louvain'},jobs:{status:'idle',model:null,tasks:[]}}));vi.stubGlobal('fetch',fetcher)
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  const frame=host.querySelector('iframe')!
  expect(frame.getAttribute('src')).toBe('/graphify-view/graph.html?v=now')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[0]).toBe('/session-hub/api/graphify/status')
})
