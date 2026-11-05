export { ClassifiedKnowledgeGraphWindow as KnowledgeGraphWindow } from './classified-knowledge-graph.tsx'
import type { KnowledgeLibraryReader } from '../app/knowledge-library.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeGraph, KnowledgeNode } from '../app/knowledge-graph.ts'
import { Button, Input } from './controls.tsx'
import { useKnowledgeLayout } from './use-knowledge-layout.ts'
import STYLES from './knowledge-graph.css?raw'
import { useGraphCamera } from './graph-camera.ts'
import { GraphMarks } from './graph-marks.tsx'
import { GraphRasterLayer } from './graph-raster-layer.tsx'
import { reconcileKnowledgeSnapshot } from './knowledge-snapshot.ts'
import { organizeKnowledgeGraph, nodeView } from './knowledge-communities.ts'

const initial: KnowledgeGraph = { status: 'idle', completed: 0, total: 0, nodes: [], edges: [], failed: [], builtAt: null, scope: null }
function useSettledLayout(value: { charge: number; distance: number; center: number; linkStrength: number }) {
  const [settled, setSettled] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setSettled(value), 160); return () => clearTimeout(timer) }, [value.charge, value.distance, value.center, value.linkStrength])
  return settled
}
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<KnowledgeGraph> {
  const response = await fetch('/session-hub/api/knowledge' + path, { method: body === undefined ? 'GET' : 'POST', signal,
    headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json() as KnowledgeGraph & { error?: string }
  if (!response.ok) throw new Error(data.error ?? '知识图谱接口暂不可用。')
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges) || !Array.isArray(data.failed)) throw new Error('知识图谱接口尚未就绪，请刷新或检查插件版本。')
  return data
}

export function LegacyKnowledgeGraphWindow({ onOpenThread }: { onOpenThread?: (thread: KnowledgeNode) => void }) {
  const [data, setData] = useState(initial), [error, setError] = useState(''), [working, setWorking] = useState(false)
  const [cwd, setCwd] = useState('')
  const [domain, setDomain] = useState(''), [tree, setTree] = useState<ReturnType<KnowledgeLibraryReader['tree']>>()
  useEffect(() => { const c = new AbortController(); void fetch('/session-hub/api/knowledge-tree', { headers: { 'x-orchestrator-request': '1' }, signal: c.signal }).then(async r => { if (r.ok) { const value = await r.json(); if (Array.isArray(value.domains)) setTree(value) } }).catch(() => {}); return () => c.abort() }, [])
  const domainIds = useMemo(() => domain ? new Set(tree?.domains.find(d => d.id === domain)?.topics.flatMap(t => t.threadIds) ?? []) : undefined, [domain, tree])
  const [charge, setCharge] = useState(-35), [distance, setDistance] = useState(60), [nodeScale, setNodeScale] = useState(1), [opacity, setOpacity] = useState(.22), [colorGroups, setColorGroups] = useState(false)
  const [center, setCenter] = useState(.025), [linkStrength, setLinkStrength] = useState(.15), [controls, setControls] = useState(true)
  const [query, setQuery] = useState(''), [minimum, setMinimum] = useState(.16), [relation, setRelation] = useState('all'), [labels, setLabels] = useState(true)
  const [selected, setSelected] = useState(''), [topic, setTopic] = useState('')
  const [allLinks, setAllLinks] = useState(false)
  const selectNode = useCallback((id: string) => setSelected(previous => previous === id ? '' : id), [])
  const svg = useRef<SVGSVGElement>(null), scene = useRef<SVGGElement>(null), active = useRef(true)
  const camera = useGraphCamera(svg, scene)
  const action = useRef<AbortController>()
  const busy = working || data.status === 'indexing'
  useEffect(() => {
    active.current = true
    const controller = new AbortController()
    void request('', undefined, controller.signal).then(value => setData(previous => reconcileKnowledgeSnapshot(previous, value)), failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => { active.current = false; controller.abort(); action.current?.abort() }
  }, [])
  useEffect(() => {
    if (data.status !== 'indexing') return
    const controller = new AbortController()
    const timer = setTimeout(() => { void request('', undefined, controller.signal).then(value => { setData(previous => reconcileKnowledgeSnapshot(previous, value)); setError('') }, failure => {
      if (!controller.signal.aborted) { setError('进度暂不可用，后台可能仍在索引：' + failure.message); setData(previous => ({ ...previous })) }
    }) }, 1000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [data])
  async function run(cancel = false) {
    if (working) return
    const controller = new AbortController(); action.current = controller
    setWorking(true); setError('')
    try {
      const result = await request(cancel ? '/cancel' : '', cancel ? {} : { confirmed: true }, controller.signal)
      if (!controller.signal.aborted) { setData(previous => reconcileKnowledgeSnapshot(previous, result)); setSelected(''); camera.reset() }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '内容索引失败。') }
    finally { if (active.current) setWorking(false) }
  }
  const topics = useMemo(() => [...new Set(data.nodes.flatMap(node => node.topics?.map(item => item.label) ?? []))].sort(), [data.nodes])
  const projects = useMemo(() => [...new Map(data.nodes.map(node => [node.cwd, { cwd: node.cwd, name: node.projectName }])).values()], [data.nodes])
  const visibleNodes = useMemo(() => data.nodes.filter(node => (!domainIds || domainIds.has(node.threadId)) && (!cwd || node.cwd === cwd) && (!topic || (topic === '未归类' ? !node.topics?.length : node.topics?.some(item => item.label === topic))) && (!query.trim() || (node.title + ' ' + node.projectName).toLowerCase().includes(query.trim().toLowerCase()))), [data.nodes, query, topic, cwd, domainIds])
  const ids = useMemo(() => new Set(visibleNodes.map(node => node.threadId)), [visibleNodes])
  const visibleEdges = useMemo(() => data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && (relation === 'all' || edge.kind === relation) && (edge.kind !== 'similarity' || edge.score >= minimum)), [data.edges, ids, minimum, relation])
  const organized = useMemo(() => organizeKnowledgeGraph(visibleNodes, visibleEdges), [visibleNodes, visibleEdges])
  const drawnEdges = allLinks ? visibleEdges : organized.edges
  const layoutSettings = useSettledLayout({ charge, distance, center, linkStrength })
  const points = useKnowledgeLayout(organized.nodes, organized.edges, layoutSettings)
  const current = organized.nodes.find(node => node.threadId === selected) ?? data.nodes.find(node => node.threadId === selected)
  const currentView = current && nodeView(current)
  const related = visibleEdges.filter(edge => edge.source === selected || edge.target === selected)
  const names = useMemo(() => new Map(data.nodes.map(node => [node.threadId, node])), [data.nodes])
  return <section className="kg-window" aria-label="知识图谱">{<style>{STYLES}</style>}
    <div className="kg-canvas">
      <div className="kg-canvas-title">关系图谱</div>
      {!controls && <Button className="kg-settings-toggle" size="sm" aria-label="打开图谱设置" onClick={() => setControls(true)}>⚙</Button>}
      <div className="kg-filter" hidden={!controls}>
        <div className="kg-filter-actions"><span>图谱设置</span><Button size="sm" aria-label="恢复图谱默认设置" onClick={() => { setCharge(-35); setDistance(60); setCenter(.025); setLinkStrength(.15); setNodeScale(1); setOpacity(.22); setColorGroups(false); setLabels(true); setQuery(''); setCwd(''); setDomain(''); setTopic(''); setRelation('all'); setMinimum(.16); setAllLinks(false) }}>↺</Button><Button size="sm" aria-label="关闭图谱设置" onClick={() => setControls(false)}>×</Button></div>
        <details><summary>筛选</summary><div>
          <Input aria-label="筛选图谱会话" placeholder="搜索会话或项目" value={query} onChange={event => setQuery(event.target.value)} />
          <label>知识主线<select aria-label="知识主线" value={domain} onChange={e => { setDomain(e.target.value); setSelected('') }}><option value="">全部主线</option>{tree?.domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>工程<select aria-label="筛选工程" value={cwd} onChange={event => setCwd(event.target.value)}><option value="">全部工程</option>{projects.map(project => <option key={project.cwd} value={project.cwd}>{project.name}</option>)}</select></label>
          <label>主题<select aria-label="主题归类" value={topic} onChange={event => { setTopic(event.target.value); setSelected('') }}><option value="">全部主题</option>{topics.map(label => <option key={label}>{label}</option>)}<option>未归类</option></select></label>
          <label>连线<select aria-label="关联类型" value={relation} onChange={event => setRelation(event.target.value)}><option value="all">全部关系</option><option value="similarity">内容相似</option><option value="reference">明确引用</option><option value="shared-file">共同文件</option></select></label>
          <label>相似度阈值 {Math.round(minimum * 100)}%<input aria-label="相似度阈值" type="range" min="0.16" max="0.9" step="0.02" value={minimum} onChange={event => setMinimum(Number(event.target.value))} /></label>
          <label><input type="checkbox" checked={allLinks} onChange={event=>setAllLinks(event.target.checked)} />显示全部关联（含辅助线）</label>
        </div></details>
        <details><summary>颜色组</summary><div><label><input type="checkbox" checked={colorGroups} onChange={event => setColorGroups(event.target.checked)} />按主题着色</label></div></details>
        <details><summary>外观</summary><div><label><input type="checkbox" checked={labels} onChange={event => setLabels(event.target.checked)} />随缩放显示会话名称</label>
          <label>节点大小<input aria-label="节点大小" type="range" min="0.5" max="2.5" step="0.1" value={nodeScale} onChange={event => setNodeScale(Number(event.target.value))} /></label>
          <label>连线透明度<input aria-label="连线透明度" type="range" min="0.05" max="1" step="0.05" value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label>
        </div></details>
        <details><summary>力度</summary><div><label>中心力<input aria-label="中心力" type="range" min="0.005" max="0.15" step="0.005" value={center} onChange={event => setCenter(Number(event.target.value))} /></label><label>排斥力<input aria-label="排斥力" type="range" min="10" max="150" value={-charge} onChange={event => setCharge(-Number(event.target.value))} /></label>
          <label>连线拉力<input aria-label="连线拉力" type="range" min="0.02" max="0.5" step="0.01" value={linkStrength} onChange={event => setLinkStrength(Number(event.target.value))} /></label>
          <label>连线距离<input aria-label="连线距离" type="range" min="15" max="120" value={distance} onChange={event => setDistance(Number(event.target.value))} /></label></div></details>
        <details><summary>处理与缓存</summary><div><span className="kg-scope" role="status">{data.status === 'indexing' ? `处理全部会话 ${data.completed} / ${data.total} · 命中缓存 ${data.cached ?? 0}` : `全部 ${data.nodes.length} 条会话 · ${data.edges.length} 条关联`}{data.status === 'cancelled' ? ' · 已暂停' : ''}</span>
          <Button size="sm" disabled={busy} onClick={() => { void run() }}>更新本地缓存</Button>{data.status === 'indexing' && <Button size="sm" disabled={working} onClick={() => { void run(true) }}>暂停处理</Button>}
          {data.failed.length > 0 && <span className="kg-scope">{data.failed.length} 条会话读取失败，更新缓存时会重试。</span>}
          {data.cacheError && <span role="alert">{data.cacheError}</span>}{error && <span role="alert">{error}</span>}
        </div></details>
      </div>
      <GraphRasterLayer svg={svg} camera={camera} nodes={organized.nodes} edges={drawnEdges} points={points} selected={selected}
        nodeScale={nodeScale} opacity={opacity} colorGroups={colorGroups} labels={labels} onSelect={selectNode} />
      <svg ref={svg} className="kg-svg" viewBox="0 0 1000 540" tabIndex={0} aria-label="会话知识关系图" onClick={event => {
        if (!event.currentTarget.hasAttribute('data-raster') && event.button === 0 && !(event.target as Element).closest('[data-node], [data-edge]')) setSelected('')
      }}>
        <g ref={scene} className="kg-scene" transform="translate(0 0) scale(1)"><GraphMarks nodes={organized.nodes} edges={drawnEdges} points={points} selected={selected}
          labels={false} nodeScale={nodeScale} opacity={opacity} colorGroups={colorGroups} onSelect={selectNode} /></g>
      </svg>
      {!points.length && <div className="kg-empty"><span aria-hidden="true">◌</span><strong>{data.status === 'idle' ? '让会话之间的关联浮现出来' : visibleNodes.length ? '正在排列会话' : data.status === 'indexing' ? '正在建立内容索引' : '当前范围没有可显示的会话'}</strong>
        <p>{data.status === 'idle' ? '更新本地缓存后，全部会话会在这里呈现，相关内容通过连线聚集。' : '可以调整范围或清空搜索；没有依据的会话会独立显示。'}</p></div>}
      {current && <aside className="kg-inspector" aria-label="会话关联详情"><div className="kg-inspector-title"><strong>{current.title}</strong><Button size="sm" aria-label="关闭关联详情" onClick={() => setSelected('')}>×</Button></div>
        <p>{current.projectName} · {current.messages} 条消息{current.partial && ' · 部分内容'}</p>
        {currentView && <p>{currentView.role==='core' ? `聚合：${currentView.label} · ${currentView.size} 条${currentView.hub?' · 代表会话':''}` : `边缘分区：${currentView.label}`}<br />{currentView.reason}</p>}
        {current.organization && <><p>{current.organization.summary}</p><p>内容整理 · {current.organization.category} · {{ discussion: '技术讨论', review: '子任务记录', test: '测试记录', insufficient: '内容待补充' }[current.organization.kind]}</p>
          <small>{current.organization.coverage === 'recent-turns' ? '依据开头预览与近期对话整理，尚未逐轮复核全部历史。' : current.organization.coverage === 'prompt-only' ? '仅找到任务提示，未发现可读回复。' : '依据当前可读取的对话整理。'}</small></>}
        <p>主题归类{!current.organization && '（关键词建议）'}：{current.topics?.map(item => item.label).join('、') || '未归类'}</p>
        <details><summary>分类依据</summary>{current.topics?.map(item => <p key={item.label}>{item.label}：{item.evidence.join('、')}</p>)}</details>
        <div className="kg-node-actions">{onOpenThread && <Button size="sm" variant="outline" onClick={() => onOpenThread(data.nodes.find(node=>node.threadId===current.threadId) ?? current)}>查看会话</Button>}<a href={'codex://threads/' + current.threadId}>在 Codex 打开 ↗</a></div>
        <h3>关联依据 · {related.length}</h3>
        {!related.length && <p>当前阈值下没有关联。独立节点也会保留。</p>}
        {related.map((edge, index) => { const other = names.get(edge.source === selected ? edge.target : edge.source)!; return <div key={index} className="kg-evidence">
          <button type="button" onClick={() => setSelected(other.threadId)}>{other.title}</button>
          <small>{edge.kind === 'reference' ? (edge.source === selected ? '本会话引用了它' : '它引用了本会话') : edge.kind === 'shared-file' ? '同一工程内的共同文件' : '文本相似度 ' + Math.round(edge.score * 100) + '%'}</small>
          <p>{edge.kind === 'reference' ? '依据：消息中出现该会话的链接。' : (edge.kind === 'shared-file' ? '文件路径：' : '共同关键词：') + edge.terms.join('、')}</p>
        </div> })}
      </aside>}
      <div className="kg-legend" title="按真实关联聚合；边缘记录保留，辅助连线可在筛选中展开"><span>{visibleNodes.length} 节点 · {organized.groups.length} 簇 · {drawnEdges.length} 连线 · 边缘 {organized.peripheral}</span></div>
      <div className="kg-zoom"><Button size="sm" aria-label="放大图谱" onClick={() => camera.zoom(1.25)}>＋</Button><Button size="sm" aria-label="缩小图谱" onClick={() => camera.zoom(.8)}>−</Button><Button size="sm" onClick={() => camera.reset()}>复位</Button></div>
    </div>
  </section>
}
