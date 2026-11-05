import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force'
import type { KnowledgeEdge, KnowledgeNode } from '../app/knowledge-graph.ts'
import { nodeView, organizeKnowledgeGraph, type PresentedNode } from './knowledge-communities.ts'
export interface GraphPoint { id: string; x: number; y: number; radius: number }
export interface LayoutSettings { charge?: number; distance?: number; center?: number; linkStrength?: number }
/** Only geometry-affecting inputs invalidate layout; polling metadata does not. */
export function layoutTopology(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): string {
  return JSON.stringify(['communities-v1', nodes.map(node => { const view=nodeView(node); return [node.threadId,view?.community ?? node.topics?.[0]?.label ?? node.projectName,view?.role,view?.hub,view ? Math.round(view.importance*1000) : undefined] }).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))), edges.map(edge => [edge.source, edge.target]).sort((a,b)=>a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!))])
}
function layoutJob(nodes: KnowledgeNode[], edges: KnowledgeEdge[], settings: LayoutSettings) {
  const presented: PresentedNode[] = nodes.every(node=>nodeView(node)) ? nodes as PresentedNode[] : organizeKnowledgeGraph(nodes,edges).nodes
  const views = new Map(presented.map(node=>[node.threadId,node.view])), grouped = new Map<string,PresentedNode[]>()
  for (const node of presented) if(node.view.role==='core') grouped.set(node.view.community,[...grouped.get(node.view.community) ?? [],node])
  const peripheral = presented.filter(node=>node.view.role!=='core')
  const circles = [...grouped].sort((a,b)=>b[1].length-a[1].length || a[0].localeCompare(b[0])).map(([id,members],index)=>({ id, x: Math.cos(index*2.399963)*Math.sqrt(index)*100,
    y:Math.sin(index*2.399963)*Math.sqrt(index)*100, radius:Math.max(14,Math.sqrt(members.length)*7) }))
  forceSimulation(circles).stop().force('collide',forceCollide((circle:any)=>circle.radius+10).iterations(2))
    .force('x',forceX(0).strength(.025)).force('y',forceY(0).strength(.025)).tick(100)
  const left = Math.min(...circles.map(c=>c.x-c.radius),0), right=Math.max(...circles.map(c=>c.x+c.radius),1)
  const top=Math.min(...circles.map(c=>c.y-c.radius),0), bottom=Math.max(...circles.map(c=>c.y+c.radius),1)
  const packingScale=Math.min((peripheral.length?690:870)/(right-left),420/(bottom-top),2)
  const offsetX=65+((peripheral.length?690:870)-(right-left)*packingScale)/2,offsetY=50+(420-(bottom-top)*packingScale)/2
  const centers=new Map(circles.map(c=>[c.id,{x:offsetX+(c.x-left)*packingScale,y:offsetY+(c.y-top)*packingScale,radius:c.radius*packingScale}]))
  const points = presented.filter(node=>node.view.role==='core').map(node=>{
    const view=node.view, members=grouped.get(view.community)!, index=members.indexOf(node), center=centers.get(view.community)!
    const angle=index*2.399963, distance=view.hub?0:center.radius*.65*Math.sqrt((index+1)/members.length)
    return {id:node.threadId,x:center.x+Math.cos(angle)*distance,y:center.y+Math.sin(angle)*distance,cx:center.x,cy:center.y,
      cluster:view.community,fx:view.hub?center.x:undefined,fy:view.hub?center.y:undefined,radius:view.hub?5+Math.min(4,Math.log2(members.length+1)*.5):1.3+view.importance*1.2}
  })
  const links=edges.filter(edge=>views.get(edge.source)?.role==='core' && views.get(edge.source)?.community===views.get(edge.target)?.community).map(edge=>({source:edge.source,target:edge.target}))
  const simulation = forceSimulation(points).stop()
    .force('charge', forceManyBody().strength((settings.charge ?? -35)*.16).theta(.95))
    .force('link', forceLink(links).id((node: any) => node.id).distance((settings.distance ?? 60)*.4).strength((settings.linkStrength ?? .15)*2))
    .force('collide', forceCollide((node: any) => node.radius + 1))
    .force('x', forceX((node: any) => node.cx).strength(.05+(settings.center ?? .025)*2))
    .force('y', forceY((node: any) => node.cy).strength(.05+(settings.center ?? .025)*2))
  return { simulation, finish: (): GraphPoint[] => {
    const extents=new Map<string,number>()
    for(const point of points)extents.set(point.cluster,Math.max(extents.get(point.cluster) ?? 1,Math.hypot(point.x-point.cx,point.y-point.cy)+point.radius+4))
    const result:GraphPoint[]=points.map(point=>{const center=centers.get(point.cluster)!, fit=center.radius/extents.get(point.cluster)!
      return {id:point.id,x:center.x+(point.x-point.cx)*fit,y:center.y+(point.y-point.cy)*fit,radius:point.radius}})
    const roles=['test','routine','pending','unlinked'], columns=Math.max(5,Math.ceil(Math.sqrt(peripheral.length*.8)))
    const rows=roles.reduce((sum,role)=>sum+Math.ceil(peripheral.filter(node=>node.view.role===role).length/columns)+2,0), dy=Math.min(8,200/Math.max(1,rows)), dx=Math.min(9,155/Math.max(1,columns-1))
    let row=0
    for(const role of roles){const members=peripheral.filter(node=>node.view.role===role).sort((a,b)=>a.threadId.localeCompare(b.threadId));if(!members.length)continue
      row+=2;members.forEach((node,index)=>result.push({id:node.threadId,x:810+(index%columns)*dx,y:300+(row+Math.floor(index/columns))*dy,radius:1}))
      row+=Math.ceil(members.length/columns)
    }
    const order=new Map(nodes.map((node,index)=>[node.threadId,index]));return result.sort((a,b)=>order.get(a.id)!-order.get(b.id)!)
  } }
}
/** Quadtree forces keep full-catalog layouts practical. Inputs are never mutated. */
export function knowledgeLayout(nodes: KnowledgeNode[], edges: KnowledgeEdge[], settings: LayoutSettings = {}): GraphPoint[] {
  const job = layoutJob(nodes, edges, settings)
  job.simulation.tick(nodes.length > 500 ? 90 : 140)
  return job.finish()
}
/** Yield after at most four ticks / 5ms; stale jobs never publish results. */
export function scheduleKnowledgeLayout(nodes: KnowledgeNode[], edges: KnowledgeEdge[], settings: LayoutSettings, publish: (points: GraphPoint[]) => void,
  schedule = requestAnimationFrame, cancel = cancelAnimationFrame) {
  const job = layoutJob(nodes, edges, settings)
  let remaining = nodes.length > 500 ? 90 : 140, stopped = false, frame: number
  const step = () => {
    if (stopped) return
    const start = performance.now()
    for (let ticks = 0; remaining && ticks < 4; ticks++) {
      job.simulation.tick(); remaining--
      if (performance.now() - start >= 5) break
    }
    if (remaining) frame = schedule(step)
    else publish(job.finish())
  }
  frame = schedule(step)
  return () => { stopped = true; cancel(frame); job.simulation.stop() }
}
