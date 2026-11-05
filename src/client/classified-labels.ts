import type { ClassifiedNode } from '../app/classified-knowledge.ts'
import type { ClassifiedPoint } from './classified-layout.ts'
import type { Camera } from './graph-camera.ts'
import { graphVisualMetrics } from './graph-raster.ts'

export function classifiedLabelLines(node:ClassifiedNode){
  const limit=node.kind==='domain'?12:18
  const title=node.title.length>limit*2?node.title.slice(0,limit*2-1)+'…':node.title
  const lines=title.length>limit?[title.slice(0,limit),title.slice(limit)]:[title]
  if(node.kind!=='source')lines.push(node.sources+' 条来源')
  return lines
}

/** The original graph's fixed-pixel marks and density-controlled zoom labels. */
export function classifiedLabels(points:ClassifiedPoint[],names:Map<string,ClassifiedNode>,camera:Camera,width:number,height:number,focus:string,expanded:boolean){
  const base=Math.max(.0001,Math.min(width/1000,height/540)),scale=base*camera.zoom
  const ranked=[...points].sort((a,b)=>Number(b.id===focus)-Number(a.id===focus)||({domain:0,topic:1,source:2}[a.kind]-{domain:0,topic:1,source:2}[b.kind]))
  const placed:{id:string;x:number;y:number;left:number;top:number;width:number;height:number}[]=[]
  for(const point of ranked){
    const node=names.get(point.id)!,forced=point.id===focus
    if(!forced&&node.kind==='topic'&&!expanded&&camera.zoom<1.6)continue
    if(!forced&&node.kind==='source'&&camera.zoom<3)continue
    const x=(point.x-camera.x)*scale+(width-1000*base)/2,y=(point.y-camera.y)*scale+(height-540*base)/2
    if(x<0||x>width||y<0||y>height)continue
    const font=node.kind==='domain'?12:11
    const lines=classifiedLabelLines(node),labelWidth=Math.min(220,Math.max(...lines.map(line=>Array.from(line).reduce((n,c)=>n+(/[\u0000-\u007f]/.test(c)?font*.58:font),0)))+8),labelHeight=lines.length*14
    const radius=graphVisualMetrics(point.r,1,scale).radiusPx
    const center=Math.max(labelWidth/2+4,Math.min(width-labelWidth/2-4,x))
    const top=Math.max(4,Math.min(height-labelHeight-4,node.kind==='domain'?y-radius-labelHeight-6:y+radius+6))
    const left=center-labelWidth/2
    if(!forced&&placed.some(p=>left<p.left+p.width+6&&left+labelWidth+6>p.left&&top<p.top+p.height+4&&top+labelHeight+4>p.top))continue
    placed.push({id:point.id,x:(center-x)/scale,y:(top+11-y)/scale,left,top,width:labelWidth,height:labelHeight})
    if(placed.length>=(camera.zoom<3?40:100))break
  }
  return {scale,placed}
}
