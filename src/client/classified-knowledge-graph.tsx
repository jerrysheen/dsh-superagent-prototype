import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClassifiedGraph, ClassifiedNode } from '../app/classified-knowledge.ts'
import type { KnowledgeNode } from '../app/knowledge-graph.ts'
import type { KnowledgeLibraryReader } from '../app/knowledge-library.ts'
import { Button, Input } from './controls.tsx'
import { classifiedLayout } from './classified-layout.ts'
import { useGraphCamera } from './graph-camera.ts'
import { classifiedLabels, classifiedLabelLines } from './classified-labels.ts'
import { graphVisualMetrics } from './graph-raster.ts'
import STYLES from './knowledge-graph.css?raw'
import CLASSIFIED_STYLES from './classified-knowledge-graph.css?raw'

const HEADERS = { 'x-orchestrator-request':'1' }
type Entries = ReturnType<KnowledgeLibraryReader['entries']>
const kinds = { discussion:'主讨论',review:'审查与子任务',test:'测试',digest:'周期汇总' }
const palette = ['#9eacc2','#a9b8a1','#baa8bd','#c1ae95','#a1babb','#bda1a4','#b6b58e']
async function graph(signal: AbortSignal) {
  const response = await fetch('/session-hub/api/knowledge-classified',{headers:HEADERS,signal})
  if(!response.ok)throw Error('分类图谱暂不可用，请稍后刷新。')
  const data = await response.json() as ClassifiedGraph
  if(data.taxonomyVersion!==2 || !Array.isArray(data.nodes) || !Array.isArray(data.edges))throw Error('分类图谱版本不匹配，请刷新页面。')
  return data
}

export function ClassifiedKnowledgeGraphWindow({onOpenThread}:{onOpenThread?: (node:KnowledgeNode)=>void}) {
  const [data,setData]=useState<ClassifiedGraph>(),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  const [domain,setDomain]=useState(''),[topic,setTopic]=useState(''),[selected,setSelected]=useState('')
  const [provider,setProvider]=useState(''),[kind,setKind]=useState('all'),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[showSources,setShowSources]=useState(true)
  const [entries,setEntries]=useState<Entries>(),[entryError,setEntryError]=useState(''),[offset,setOffset]=useState(0)
  const svg=useRef<SVGSVGElement>(null),scene=useRef<SVGGElement>(null),pending=useRef<AbortController>()
  const camera=useGraphCamera(svg,scene)
  const refresh=useCallback(async()=>{
    pending.current?.abort();const c=new AbortController();pending.current=c;setLoading(true);setError('')
    try{const value=await graph(c.signal);if(!c.signal.aborted)setData(value)}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'图谱读取失败。')}
    finally{if(!c.signal.aborted)setLoading(false)}
  },[])
  useEffect(()=>{void refresh();return()=>pending.current?.abort()},[refresh])
  useEffect(()=>{const timer=setTimeout(()=>setSearch(query),180);return()=>clearTimeout(timer)},[query])
  const roots=useMemo(()=>data?.nodes.filter(n=>n.kind==='domain') ?? [],[data])
  const sourceNodes=useMemo(()=>data?.nodes.filter(n=>n.kind==='source'&&(!provider||n.source?.provider===provider)&&(!domain||!!topic||n.domainId===domain)&&(!topic||n.topicId===topic||n.source?.topicIds.includes(topic))&&(!kind||kind==='all'||n.source?.kind===kind)&&(!search.trim()||(n.title+' '+n.source?.projectName).toLowerCase().includes(search.trim().toLowerCase()))).map(n=>topic?{...n,topicId:topic,domainId:domain}:n) ?? [],[data,domain,topic,kind,provider,search])
  const nodes=useMemo(()=>{
    if(!data)return []
    const activeTopics=new Set(sourceNodes.map(n=>n.topicId)),filtered=!!provider||kind!=='all'||!!search.trim()
    const domainCounts=new Map<string,number>(),topicCounts=new Map<string,number>()
    for(const n of sourceNodes){domainCounts.set(n.domainId,(domainCounts.get(n.domainId)??0)+1);topicCounts.set(n.topicId!, (topicCounts.get(n.topicId!)??0)+1)}
    return data.nodes.filter(n=>n.kind!=='source'&&(topic!=='unassigned'||n.kind!=='domain')&&(!domain||n.domainId===domain)&&(!topic||n.kind==='domain'||n.topicId===topic)&&(!filtered||n.kind==='domain'||activeTopics.has(n.topicId))).map(n=>({...n,sources:(n.kind==='domain'?domainCounts.get(n.domainId):topicCounts.get(n.topicId!))??0})).concat(sourceNodes)
  },[data,domain,topic,sourceNodes,provider,kind,search])
  const points=useMemo(()=>classifiedLayout(nodes,showSources),[nodes,showSources])
  const positions=useMemo(()=>new Map(points.map(p=>[p.id,p])),[points])
  const names=useMemo(()=>new Map(nodes.map(n=>[n.id,n])),[nodes])
  const selectedDefinition=data?.nodes.find(n=>n.id===selected)
  const selectedNode=selectedDefinition?.kind==='source'?selectedDefinition:names.get(selected) ?? selectedDefinition
  const displayEdges=useMemo(()=>[...(data?.edges.filter(e=>e.kind==='contains'&&!e.target.startsWith('source:')) ?? []),...sourceNodes.map(n=>({source:'topic:'+n.topicId,target:n.id,kind:'contains' as const}))],[data,sourceNodes])
  useEffect(()=>{
    const element=svg.current;if(!element)return
    const marks=new Map([...element.querySelectorAll<SVGGElement>('[data-classified-node]')].map(mark=>[mark.dataset.classifiedNode!,mark]))
    const labels=new Map([...marks].map(([id,mark])=>[id,mark.querySelector<SVGGElement>('.cg-label')!]))
    const lines=[...element.querySelectorAll<SVGLineElement>('.cg-link')]
    let focus=selected,visible=new Set<string>(),lastScale=0
    const paint=()=>{
      const rect=element.getBoundingClientRect(),view=classifiedLabels(points,names,camera.current(),rect.width||1000,rect.height||540,focus,!!domain||!!topic)
      if(view.scale!==lastScale){
        lastScale=view.scale
        for(const point of points){const mark=marks.get(point.id);if(!mark)continue;const size=graphVisualMetrics(point.r,1,view.scale)
          mark.querySelector('.cg-dot')?.setAttribute('r',String(size.radius))
          mark.querySelector('.cg-hit')?.setAttribute('r',String((size.radiusPx+3)/view.scale))
        }
      }
      const next=new Set(view.placed.map(p=>p.id))
      for(const id of visible)if(!next.has(id))labels.get(id)?.removeAttribute('data-visible')
      for(const p of view.placed){const label=labels.get(p.id);label?.setAttribute('data-visible','');label?.setAttribute('transform',`translate(${p.x} ${p.y}) scale(${1/view.scale})`)}
      visible=next
    }
    const highlight=(id:string)=>{focus=id;for(const line of lines)line.toggleAttribute('data-highlight',!!id&&(line.dataset.source===id||line.dataset.target===id));paint()}
    const over=(event:Event)=>{const mark=(event.target as Element).closest<SVGGElement>('[data-classified-node]');highlight(mark?.dataset.classifiedNode??selected)}
    const leave=()=>highlight(selected)
    element.addEventListener('pointerover',over);element.addEventListener('focusin',over);element.addEventListener('pointerleave',leave)
    const unsubscribe=camera.subscribe(paint),resize=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(paint);resize?.observe(element);window.addEventListener('resize',paint);highlight(selected)
    return()=>{unsubscribe();resize?.disconnect();window.removeEventListener('resize',paint);for(const label of labels.values())label.removeAttribute('data-visible');element.removeEventListener('pointerover',over);element.removeEventListener('focusin',over);element.removeEventListener('pointerleave',leave)}
  },[points,names,selected,domain,topic,camera])
  useEffect(()=>{ camera.reset() },[domain,topic,provider,kind,showSources])
  useEffect(()=>{
    setOffset(0)
  },[selected])
  useEffect(()=>{
    setEntries(undefined);setEntryError('')
    if(!selectedNode||selectedNode.kind==='domain')return
    const c=new AbortController(),params=new URLSearchParams({kind:kind==='all'?'all':kind,limit:'10',offset:String(offset),provider,q:search,...(selectedNode.kind==='source'?{thread:selectedNode.source!.threadId}:{topic:selectedNode.topicId!})})
    void fetch('/session-hub/api/knowledge-library/entries?'+params,{headers:HEADERS,signal:c.signal}).then(async r=>{if(!r.ok)throw Error('问答暂不可用。');setEntries(await r.json())}).catch(e=>{if(!c.signal.aborted)setEntryError(e.message)})
    return()=>c.abort()
  },[selectedNode,offset,kind,provider,search])
  const select=(node:ClassifiedNode)=>{
    setSelected(node.id)
    if(node.kind==='domain'){setDomain(node.domainId);setTopic('')}
    if(node.kind==='topic'){setDomain(node.domainId);setTopic(node.topicId ?? '')}
  }
  const reset=()=>{setDomain('');setTopic('');setSelected('');camera.reset()}
  const domainName=roots.find(n=>n.domainId===domain)?.title
  const topicName=data?.nodes.find(n=>n.kind==='topic'&&n.topicId===topic)?.title
  return <section className="kg-window cg-window" aria-label="分类知识图谱" data-taxonomy-version="2"><style>{STYLES+CLASSIFIED_STYLES}</style><div className="kg-canvas">
    <header className="cg-heading"><div className="cg-breadcrumb"><button type="button" onClick={reset}>七条知识主线</button>{domainName&&<><span> / </span><button type="button" onClick={()=>{setTopic('');setSelected('domain:'+domain)}}>{domainName}</button></>}{topicName&&<><span> / </span><span>{topicName}</span></>}</div><small>领域 → 专题 → 来源会话 · 连线表示分类归属</small></header>
    <div className="cg-controls"><Input aria-label="搜索分类图谱" placeholder="搜索会话或工程" value={query} onChange={e=>{setQuery(e.target.value);setSelected('')}}/>
      <select aria-label="来源范围" value={provider} onChange={e=>{setProvider(e.target.value);setSelected('')}}><option value="">全部来源</option><option value="codex">Codex 本地</option><option value="chatgpt">ChatGPT 云端</option></select>
      <details><summary>显示</summary><div><select aria-label="图谱记录类型" value={kind} onChange={e=>{setKind(e.target.value);setSelected('')}}><option value="all">全部记录</option>{Object.entries(kinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><label><input type="checkbox" checked={showSources} onChange={e=>setShowSources(e.target.checked)}/>来源节点</label></div></details>
      <Button size="sm" disabled={loading} onClick={()=>{void refresh()}}>{loading?'读取中…':'刷新图谱'}</Button>
    </div>
    <svg ref={svg} className="kg-svg cg-svg" viewBox="0 0 1000 540" tabIndex={0} aria-label="按七条主干分类的关系图谱" onClick={e=>{if(!(e.target as Element).closest('[data-classified-node]'))setSelected('')}}>
      <g ref={scene} transform="translate(0 0) scale(1)">
        {displayEdges.map(edge=>{const a=positions.get(edge.source),b=positions.get(edge.target);if(!a||!b)return null;const leaf=b.kind==='source';return <line key={edge.source+':'+edge.target} data-source={edge.source} data-target={edge.target} data-membership={leaf?'source':'topic'} className={'cg-link'+(leaf?' cg-leaf-link':'')} x1={a.x} y1={a.y} x2={b.x} y2={b.y}><title>分类归属</title></line>})}
        {points.map(p=>{const node=names.get(p.id)!;const color=palette[Math.max(0,roots.findIndex(r=>r.domainId===node.domainId))%palette.length];const labelLines=classifiedLabelLines(node);return <g key={p.id} data-classified-node={node.id} data-node-kind={node.kind} data-selected={selected===node.id||undefined} className={'cg-node cg-'+node.kind} transform={`translate(${p.x},${p.y})`} style={{'--cg-color':color} as React.CSSProperties} role="button" tabIndex={0} aria-label={node.title} aria-pressed={selected===node.id} onClick={()=>select(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(node)}}}>
          <title>{node.title+(node.source?' · '+(node.source.provider==='chatgpt'?'ChatGPT 云端':'Codex 本地')+' · '+node.pairs+' 组问答':' · '+node.sources+' 条主归属会话')}</title><circle className="cg-hit" r={Math.max(3,p.r+2)}/><circle className="cg-dot" r={p.r}/>
          <g className="cg-label"><text textAnchor="middle">{labelLines.map((line,index)=><tspan key={index} x="0" dy={index?14:0} className={node.kind!=='source'&&index===labelLines.length-1?'cg-count':undefined}>{line}</tspan>)}</text></g>
        </g>})}
      </g>
    </svg>
    {error&&<p role="alert" className="cg-error">{error}</p>}{data?.error&&<p role="alert" className="cg-error">{data.error}</p>}
    {!data&&!error&&<div className="kg-empty" role="status">正在读取分类图谱…</div>}
    {data&&!sourceNodes.length&&<div className="kg-empty"><strong>当前范围没有来源会话</strong><p>可以清空搜索或调整来源范围。</p></div>}
    {selectedNode&&<aside className="kg-inspector cg-inspector" aria-label="分类与来源详情"><div className="kg-inspector-title"><strong>{selectedNode.title}</strong><Button size="sm" aria-label="关闭分类详情" onClick={()=>setSelected('')}>×</Button></div>
      {selectedNode.kind==='domain'?<><p>{selectedNode.summary}</p><p>{selectedNode.sources} 条主归属会话</p>{data?.nodes.filter(n=>n.kind==='topic'&&n.domainId===selectedNode.domainId).map(n=><button type="button" className="cg-topic-row" key={n.id} onClick={()=>select(n)}>{n.title}<small>{n.sources}</small></button>)}</>:selectedNode.kind==='topic'?<><p>{selectedNode.summary}</p><p>{selectedNode.sources} 条相关会话 · {selectedNode.pairs} 组相关问答</p></>:<>
        <p>{selectedNode.source?.provider==='chatgpt'?'ChatGPT 云端':'Codex 本地'} · {selectedNode.source?.projectName} · {kinds[selectedNode.source!.kind]}</p><p>{selectedNode.pairs} 组问答{selectedNode.pending?' · 含待复核内容':''}</p><h3>专题归属</h3>{selectedNode.source?.topicIds.map(id=>{const n=data?.nodes.find(n=>n.id==='topic:'+id);return n&&<button type="button" className="cg-topic-row" key={id} onClick={()=>select(n)}>{n.title}<small>{id===selectedNode.topicId?'主归属':'交叉归属'}</small></button>})}
        {!!selectedNode.source?.unassignedPairs&&<p>{selectedNode.source.unassignedPairs} 组问答尚待归类。</p>}
        <div className="kg-node-actions">{selectedNode.source?.provider==='codex'&&onOpenThread&&<Button size="sm" onClick={()=>onOpenThread({provider:'codex',threadId:selectedNode.source!.threadId,title:selectedNode.title,cwd:selectedNode.source!.cwd,projectName:selectedNode.source!.projectName,updatedAt:selectedNode.source!.updatedAt,messages:selectedNode.source!.scan.turns,partial:selectedNode.pending})}>查看会话</Button>}<a href={selectedNode.source?.provider==='chatgpt'?'https://chatgpt.com/c/'+selectedNode.source.threadId:'codex://threads/'+selectedNode.source?.threadId}>打开原会话 ↗</a></div>
      </>}
      {selectedNode.kind!=='domain'&&<><h3>问答与开放问题{entries?' · '+entries.total:''}</h3>{entryError&&<p role="alert">{entryError}</p>}{!entries&&!entryError&&<p role="status">读取中…</p>}{entries?.entries.map(entry=><article className="cg-answer" key={entry.id}><strong>{entry.question}</strong><p>{entry.answer||'尚无答复。'}</p><small>{entry.thread.title} · 历史内容待核验</small><details><summary>来源轮次</summary><p>{entry.evidence?.turnIds.join('、')||entry.turnId}</p></details></article>)}{entries&&entries.total>10&&<div className="cg-pagination"><Button size="sm" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-10))}>上一页</Button><span>{Math.floor(offset/10)+1}</span><Button size="sm" disabled={entries.nextOffset===null} onClick={()=>setOffset(entries.nextOffset ?? offset)}>下一页</Button></div>}</>}
      <p className="cg-note">主归属依据问答专题覆盖数；保留交叉归属。分类尚待语义复核，历史答复不等于已经验证的结果。</p>
    </aside>}
    <footer className="kg-legend cg-legend">{data&&<><span>{data.stats.domains} 条主线 · {data.stats.topics} 个专题 · {sourceNodes.length} / {data.stats.sources} 条来源</span><span>本地 {data.stats.local} · 云端 {data.stats.cloud} · 待归类 {data.stats.unassignedSources} 条来源 / {data.stats.unassignedPairs} 组问答</span><span>更新于 {new Date(data.builtAt).toLocaleString('zh-CN')} · 点击主线或专题展开</span></>}</footer>
    <div className="kg-zoom"><Button size="sm" aria-label="放大分类图谱" onClick={()=>camera.zoom(1.25)}>＋</Button><Button size="sm" aria-label="缩小分类图谱" onClick={()=>camera.zoom(.8)}>−</Button><Button size="sm" onClick={()=>camera.reset()}>复位</Button></div>
  </div></section>
}
