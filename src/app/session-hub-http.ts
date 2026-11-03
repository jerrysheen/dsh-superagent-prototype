/** Loopback-only session coordination API, sharing the panel's same-origin request guard. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sameOrigin } from './http.ts'
import { SessionHub } from './session-hub.ts'

export function registerSessionHub(ctx: Context, hub: SessionHub): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Session coordination requires loopback binding')
  return ctx.webServer.register({ kind: 'prefix', path: '/session-hub/api', handler: async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    if (!sameOrigin(req, ctx.webServer.port)) { reply(403, { error: 'Same-origin management request required' }); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/session-hub/api'.length)
    const body = async () => {
      const buffers: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); size += buffer.length
        if (size > 128 * 1024) throw new Error('Request body is too large')
        buffers.push(buffer)
      }
      return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown
    }
    try {
      if (req.method === 'GET' && path === '/snapshot') { reply(200, hub.snapshot()); return }
      if (req.method === 'POST' && path === '/sessions') { reply(200, hub.register(await body())); return }
      if (req.method === 'POST' && path === '/tasks') { reply(200, hub.submit(await body())); return }
      const receipt = /^\/tasks\/([^/]+)\/receipts$/.exec(path)
      if (req.method === 'POST' && receipt) { reply(200, hub.receipt(decodeURIComponent(receipt[1]!), await body())); return }
      if (req.method === 'POST' && path === '/clear-demo') { reply(200, hub.clearDemo()); return }
      reply(404, { error: 'Unknown session operation' })
    } catch (error) {
      if (error instanceof z.ZodError) { reply(400, { error: 'Invalid session data', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); return }
      reply(400, { error: error instanceof Error ? error.message : 'Session operation failed' })
    }
  } })
}
