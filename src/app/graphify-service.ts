import { GraphifyCorpus } from './graphify-corpus.ts'
import { GraphifyReview } from './graphify-review.ts'
import { GraphifyExpanded } from './graphify-expanded.ts'
/** Serves Graphify's exported viewer; delegates graph construction and layout to upstream tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { RoleModel } from '../policy.ts'
import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { KnowledgeLibraryReader } from './knowledge-library.ts'
import { GraphifyJobs } from './graphify-jobs.ts'

export class GraphifyService {
  readonly jobs:GraphifyJobs
  readonly expanded:GraphifyExpanded
  readonly corpus:GraphifyCorpus
  readonly review:GraphifyReview
  private corpusSelected=false
  private expandedSelected=false
  private building?:Promise<unknown>
  private directory:string
  constructor(private ctx:Context,private library:KnowledgeLibraryReader,private root:string,model:()=>RoleModel|null,stateDir:string){
    this.directory=join(stateDir,'graphify')
    this.review=new GraphifyReview({llm:ctx.llm,directory:this.directory,build:()=>this.build()})
    this.corpus=new GraphifyCorpus({llm:ctx.llm,directory:this.directory,root,build:()=>this.build()})
    this.corpusSelected=this.corpus.status().status!=='idle'
    this.expanded=new GraphifyExpanded({llm:ctx.llm,directory:this.directory,sample:()=>library.graphifyExpandedSample(),build:()=>this.build()})
    this.jobs=new GraphifyJobs({llm:ctx.llm,model,directory:join(this.directory,'results'),sample:theme=>library.graphifySample(theme),build:()=>this.build()})
  }
  async start(profile?:string,maxBatches?:number){if(this.jobs.status().status==='running'||this.expanded.status().status==='running'||this.corpus.status().status==='running')return this.status().jobs;this.corpusSelected=profile==='deepseek-corpus';this.expandedSelected=profile==='deepseek-50';return this.corpusSelected?await this.corpus.start(maxBatches):this.expandedSelected?this.expanded.start():this.jobs.start()}
  status(){
    let manifest:unknown=null
    const path=join(this.directory,'manifest.json')
    if(existsSync(path)&&!lstatSync(path).isSymbolicLink())try{manifest=JSON.parse(readFileSync(path,'utf8'))}catch{}
    return {available:existsSync(join(this.directory,'graph.html')),manifest,review:this.review.status(),jobs:this.corpusSelected?this.corpus.status():this.expandedSelected?this.expanded.status():this.jobs.status()}
  }
  build(){
    if(this.building)return this.building
    this.building=(async()=>{
      await mkdir(this.directory,{recursive:true})
      await writeFile(join(this.directory,'baseline.json'),JSON.stringify(this.library.graphifyBaseline()))
      const python=join(this.root,'.local','graphify-venv','Scripts','python.exe'),script=join(this.root,'scripts','Build-Graphify.py')
      if(!existsSync(python)||!existsSync(script))throw Error('请先运行 scripts/Setup-Graphify.ps1')
      await new Promise<void>((done,fail)=>{
        const child=spawn(python,[script,'--output',this.directory],{cwd:this.root,windowsHide:true,shell:false,stdio:['ignore','ignore','pipe']})
        let size=0;child.stderr.on('data',chunk=>{size+=chunk.length;if(size>100000)child.kill()})
        const timer=setTimeout(()=>{child.kill();fail(Error('Graphify export timed out'))},900000)
        child.once('error',()=>{clearTimeout(timer);fail(Error('Graphify could not start'))})
        child.once('exit',code=>{clearTimeout(timer);code===0?done():fail(Error('Graphify export failed; previous viewer preserved'))})
      })
      return this.status()
    })().finally(()=>{this.building=undefined})
    return this.building
  }
  registerViewer(){
    return this.ctx.webServer.register({kind:'prefix',path:'/graphify-view',handler:async(req,res)=>{
      const host=req.headers.host,origin='http://'+host
      const trusted=(req.headers.origin===undefined||req.headers.origin===origin)&&(host===`127.0.0.1:${this.ctx.webServer.port}`||host===`localhost:${this.ctx.webServer.port}`)&&
        (req.headers['x-orchestrator-request']==='1'||req.headers['sec-fetch-site']==='same-origin'&&req.headers.referer?.startsWith(origin+'/'))
      if(!trusted){res.writeHead(403);res.end();return}
      if(req.method!=='GET'||!/^\/graphify-view\/(?:graph|community-\d+)\.html$/.test(new URL(req.url??'/',origin).pathname)){res.writeHead(404);res.end();return}
      const file=join(this.directory,new URL(req.url??'/',origin).pathname.split('/').at(-1)!)
      if(!existsSync(file)||lstatSync(file).isSymbolicLink()){res.writeHead(404);res.end('Graphify viewer is not built');return}
      const html=readFileSync(file)
      if(html.length>32*1024*1024){res.writeHead(413);res.end();return}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-ancestors 'self'"})
      res.end(html)
    }})
  }
}
