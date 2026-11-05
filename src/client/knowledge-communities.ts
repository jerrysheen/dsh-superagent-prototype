import type { KnowledgeNode, KnowledgeEdge } from '../app/knowledge-graph.ts'
export type NodeRole = 'core' | 'test' | 'routine' | 'pending' | 'unlinked'
export interface NodeView { community: string; label: string; size: number; hub: boolean; importance: number; role: NodeRole; reason: string }
export type PresentedNode = KnowledgeNode & { view: NodeView }
export interface Community { id: string; label: string; hub: string; members: string[] }
export const roleLabels: Record<NodeRole, string> = { core: '关联会话', test: '测试与演示', routine: '周期汇总', pending: '内容待核实', unlinked: '暂未关联' }
export function nodeView(node: KnowledgeNode | undefined): NodeView | undefined { return (node as Partial<PresentedNode> | undefined)?.view }
function roleOf(node: KnowledgeNode): { role: NodeRole; reason: string } {
  if (node.organization?.kind === 'test' || /^(?:hello(?: world)?|ok|test(?:ing)?|测试(?:一下)?|最小\s*ok\s*回复连通性测试)$/i.test(node.title.trim())) return { role: 'test', reason: '连通性测试或演示记录' }
  if (/^(每日|每周|daily|weekly).*(总结|汇总|日报|简报|summary|digest)/i.test(node.title)) return { role: 'routine', reason: '周期性汇总，单独收纳以减少主图重复信息' }
  if (node.organization?.kind === 'insufficient' || node.organization?.coverage === 'prompt-only' || node.messages === 0) return { role: 'pending', reason: node.partial ? '正文尚未完整读取，不能判定为空会话' : '索引未提取到正文或上下文不足，保留原会话待核实' }
  return { role: 'core', reason: '依据内容相似、明确引用及具体共同文件聚合' }
}
const genericFile = (file: string) => /^(?:readme(?:\.[^/]*)?|agents\.md|execution_report\.md|package(?:-lock)?\.json|pnpm-lock\.yaml|tsconfig(?:\.[^/]*)?\.json)$/i.test(file.replaceAll('\\', '/').split('/').at(-1) ?? '')
/** Presentation only: no node deletion, synthetic links, native renaming or history writes. */
export function organizeKnowledgeGraph(nodes: KnowledgeNode[], sourceEdges: KnowledgeEdge[]) {
  const roles = new Map(nodes.map(node => [node.threadId, roleOf(node)])), byId = new Map(nodes.map(node => [node.threadId, node]))
  const fileUsers = new Map<string, Set<string>>()
  const fileKey = (id: string, file: string) => (byId.get(id)?.cwd ?? '').toLowerCase().replaceAll('\\', '/') + ':' + file.toLowerCase()
  const eligible = sourceEdges.filter(edge => edge.source !== edge.target && roles.get(edge.source)?.role === 'core' && roles.get(edge.target)?.role === 'core')
  for (const edge of eligible) if (edge.kind === 'shared-file') for (const file of edge.terms.filter(file => !genericFile(file))) {
    const key = fileKey(edge.source, file), users = fileUsers.get(key) ?? new Set<string>()
    users.add(edge.source); users.add(edge.target); fileUsers.set(key, users)
  }
  const weighted = eligible.map(edge => {
    const specificity = edge.terms.filter(file => !genericFile(file)).map(file => 1 / Math.max(2, fileUsers.get(fileKey(edge.source, file))?.size ?? 2))
    const weight = edge.kind === 'reference' ? 2 : edge.kind === 'similarity' ? (edge.score >= .24 ? edge.score ** 2 * 3 : 0)
      : specificity.length ? 2 * Math.max(...specificity) : 0
    return { edge, weight }
  }).filter(item => item.weight > 0)
  const adjacency = new Map<string, Map<string, number>>()
  for (const { edge, weight } of weighted) for (const [a,b] of [[edge.source,edge.target],[edge.target,edge.source]] as const) {
    const neighbors = adjacency.get(a) ?? new Map<string, number>(); neighbors.set(b, (neighbors.get(b) ?? 0) + weight); adjacency.set(a, neighbors)
  }
  const degree = new Map([...adjacency].map(([id, neighbors]) => [id, Math.round([...neighbors.values()].reduce((a,b) => a+b, 0)*1e8)/1e8]))
  const total = [...degree.values()].reduce((a,b) => a+b, 0), labels = new Map([...degree.keys()].map(id => [id,id])), totals = new Map(degree)
  const order = [...degree.keys()].sort((a,b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b))
  // Deterministic weighted modularity local moves. Common-file cliques are degree-discounted.
  for (let pass = 0; pass < 24 && total; pass++) {
    let moves = 0
    for (const id of order) {
      const current = labels.get(id)!, k = degree.get(id)!, votes = new Map<string, number>()
      for (const [other, weight] of adjacency.get(id)!) { const c = labels.get(other)!; votes.set(c, (votes.get(c) ?? 0) + weight) }
      totals.set(current, totals.get(current)! - k)
      let best = current, score = (votes.get(current) ?? 0) - .85 * k * (totals.get(current) ?? 0) / total
      for (const [candidate, weight] of [...votes].sort((a,b)=>a[0].localeCompare(b[0]))) {
        const next = weight - .85 * k * (totals.get(candidate) ?? 0) / total
        if (next > score + 1e-10) { best = candidate; score = next }
      }
      labels.set(id, best); totals.set(best, (totals.get(best) ?? 0) + k); if (best !== current) moves++
    }
    if (!moves) break
  }
  // Attach small connected fragments to their strongest neighboring community, never by project name alone.
  for (let pass = 0; pass < 2; pass++) {
    const members = new Map<string, string[]>()
    for (const [id,c] of labels) members.set(c, [...members.get(c) ?? [], id])
    for (const [c, ids] of [...members].sort((a,b) => a[1].length-b[1].length || a[0].localeCompare(b[0]))) if (ids.length <= 3) {
      const votes = new Map<string, number>()
      for (const id of ids) for (const [other,weight] of adjacency.get(id) ?? []) { const target = labels.get(other)!; if (target !== c) votes.set(target, (votes.get(target) ?? 0) + weight) }
      const target = [...votes].filter(([target]) => (members.get(target)?.length ?? 0) > ids.length && (members.get(target)?.length ?? 0) + ids.length <= 180).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      if (target) { for (const id of ids) labels.set(id,target); members.get(target)!.push(...ids); members.set(c,[]) }
    }
  }
  const members = new Map<string, string[]>()
  for (const [id,c] of labels) members.set(c, [...members.get(c) ?? [], id])
  const references = new Map<string, number>()
  for (const {edge} of weighted) if (edge.kind === 'reference') references.set(edge.target,(references.get(edge.target) ?? 0)+1)
  const groups: Community[] = [...members.values()].map(ids => {
    ids.sort((a,b) => (degree.get(b)! + (references.get(b) ?? 0)*2) - (degree.get(a)! + (references.get(a) ?? 0)*2) || a.localeCompare(b))
    const hub = ids[0]!, categories = new Map<string, number>()
    for (const id of ids) { const category = byId.get(id)?.organization?.category; if (category) categories.set(category,(categories.get(category) ?? 0)+1) }
    const category = [...categories].sort((a,b)=>b[1]-a[1])[0]
    const label = category && category[1] >= Math.max(2, ids.length*.35) ? category[0] : byId.get(hub)!.title
    return { id: [...ids].sort()[0]!, hub, label: label.length > 24 ? label.slice(0,24)+'…' : label, members: ids }
  }).sort((a,b)=>b.members.length-a.members.length || a.id.localeCompare(b.id))
  const views = new Map<string, NodeView>()
  for (const group of groups) {
    const maximum = Math.max(...group.members.map(id=>degree.get(id)!))
    for (const id of group.members) views.set(id, { community: group.id, label: group.label, size: group.members.length, hub: id===group.hub,
      importance: Math.min(1, degree.get(id)! / maximum), role: 'core', reason: roles.get(id)!.reason })
  }
  for (const node of nodes) if (!views.has(node.threadId)) {
    const source = roles.get(node.threadId)!, role: NodeRole = source.role==='core' ? 'unlinked' : source.role
    views.set(node.threadId, { community: 'side:'+role, label: roleLabels[role], size: 0, hub: false, importance: 0, role,
      reason: role==='unlinked' ? '目前没有足够的关联依据，不代表内容无价值' : source.reason })
  }
  const sideCounts = new Map<string,number>()
  for (const view of views.values()) if (view.role!=='core') sideCounts.set(view.community,(sideCounts.get(view.community) ?? 0)+1)
  for (const view of views.values()) if (view.role!=='core') view.size = sideCounts.get(view.community)!
  // Preserve explicit references and content similarity; sparsify shared-file cliques into a genuine-edge backbone.
  const edges = weighted.filter(item=>item.edge.kind!=='shared-file').map(item=>item.edge), used = new Map<string, number>(), crossPairs = new Set<string>()
  const files = weighted.filter(item=>item.edge.kind==='shared-file').sort((a,b)=> {
    const rank = (item: typeof a) => item.weight + ((views.get(item.edge.source)?.hub || views.get(item.edge.target)?.hub) ? 1 : 0)
    return rank(b)-rank(a) || a.edge.source.localeCompare(b.edge.source) || a.edge.target.localeCompare(b.edge.target)
  })
  for (const {edge} of files) {
    const a=views.get(edge.source)!, b=views.get(edge.target)!, pair=[a.community,b.community].sort().join(':')
    if (a.community!==b.community && crossPairs.has(pair)) continue
    if ((!a.hub && (used.get(edge.source) ?? 0)>=2) || (!b.hub && (used.get(edge.target) ?? 0)>=2)) continue
    edges.push(edge); used.set(edge.source,(used.get(edge.source) ?? 0)+1); used.set(edge.target,(used.get(edge.target) ?? 0)+1)
    if (a.community!==b.community) crossPairs.add(pair)
  }
  return { nodes: nodes.map(node=>({ ...node, view: views.get(node.threadId)! })), edges, groups,
    peripheral: nodes.filter(node=>views.get(node.threadId)!.role!=='core').length, hiddenEdges: sourceEdges.length-edges.length }
}
