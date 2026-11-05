import { forceSimulation, forceCollide, forceX, forceY } from 'd3-force'
import type { ClassifiedNode } from '../app/classified-knowledge.ts'

export interface ClassifiedPoint { id: string; x: number; y: number; r: number; kind: ClassifiedNode['kind']; domainId: string }
type Disk = { id: string; x: number; y: number; radius: number }
function pack(disks: Disk[], wide = false) {
  disks.forEach((disk,i)=>{ disk.x=Math.cos(i*2.399963)*Math.sqrt(i)*25; disk.y=Math.sin(i*2.399963)*Math.sqrt(i)*25 })
  forceSimulation(disks).stop().force('collide',forceCollide<Disk>(d=>d.radius+7).iterations(3))
    .force('x',forceX(0).strength(wide ? .006 : .025)).force('y',forceY(0).strength(wide ? .07 : .025)).tick(180)
  return disks
}
/** Stable hierarchy geometry; no browser layout cache from the old graph can be reused. */
export function classifiedLayout(nodes: ClassifiedNode[], expanded = true): ClassifiedPoint[] {
  const groups = [...new Set(nodes.filter(n=>n.kind!=='source').map(n=>n.domainId))]
  const local = new Map<string,ClassifiedPoint[]>(), disks: Disk[] = []
  for (const id of groups) {
    const topics = nodes.filter(n=>n.kind==='topic'&&n.domainId===id)
    const packed = pack(topics.map(t=>({ id:t.id,x:0,y:0,radius:expanded ? 16+Math.sqrt(nodes.filter(n=>n.kind==='source'&&n.topicId===t.topicId).length)*3.2 : 21 })))
    const points: ClassifiedPoint[] = []
    for (const disk of packed) {
      points.push({id:disk.id,x:disk.x,y:disk.y,r:4.5,kind:'topic',domainId:id})
      if (expanded) {
        const topic = topics.find(t=>t.id===disk.id)!
        const children = nodes.filter(n=>n.kind==='source'&&n.topicId===topic.topicId).sort((a,b)=>a.id.localeCompare(b.id))
        children.forEach((child,i)=>{
          const angle=i*2.399963, radius=13+(disk.radius-18)*Math.sqrt((i+.5)/Math.max(1,children.length))
          points.push({id:child.id,x:disk.x+Math.cos(angle)*radius,y:disk.y+Math.sin(angle)*radius,r:1.5,kind:'source',domainId:id})
        })
      }
    }
    const top=Math.min(...packed.map(d=>d.y-d.radius),0)
    const root=nodes.find(n=>n.kind==='domain'&&n.domainId===id)
    if(root) points.push({id:root.id,x:0,y:top-22,r:8,kind:'domain',domainId:id})
    const left=Math.min(...packed.map(d=>d.x-d.radius),-20),right=Math.max(...packed.map(d=>d.x+d.radius),20)
    const bottom=Math.max(...packed.map(d=>d.y+d.radius),10),cy=(top-35+bottom)/2,cx=(left+right)/2
    points.forEach(p=>{p.x-=cx;p.y-=cy})
    local.set(id,points)
    disks.push({id,x:0,y:0,radius:Math.max(...packed.map(d=>Math.hypot(d.x-cx,d.y-cy)+d.radius),root?Math.hypot(cx,top-22-cy)+25:0,30)+15})
  }
  pack(disks,true)
  if(!disks.length)return []
  const left=Math.min(...disks.map(d=>d.x-d.radius)),right=Math.max(...disks.map(d=>d.x+d.radius))
  const top=Math.min(...disks.map(d=>d.y-d.radius)),bottom=Math.max(...disks.map(d=>d.y+d.radius))
  const scale=Math.min(900/Math.max(1,right-left),440/Math.max(1,bottom-top))
  return disks.flatMap(d=>(local.get(d.id) ?? []).map(p=>({...p,x:500+(d.x+p.x-(left+right)/2)*scale,y:285+(d.y+p.y-(top+bottom)/2)*scale,
    r:p.kind==='source'?Math.max(.85,1.5*scale):p.r})))
}
