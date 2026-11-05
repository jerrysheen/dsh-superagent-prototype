/** Cooperative native Windows shutdown: authenticate before invoking DSH's own handler.
 * Imported only by the managed process; remove secrets before its plugins spawn children.
 */
import { createServer } from 'node:net'
const pipe=process.env.DSH_SERVICE_PIPE, token=process.env.DSH_SERVICE_TOKEN
delete process.env.DSH_SERVICE_PIPE; delete process.env.DSH_SERVICE_TOKEN
if(pipe && token) {
  const server=createServer(socket=>{
    let input=''
    socket.setTimeout(2000,()=>socket.destroy())
    socket.on('error',()=>{})
    socket.on('data',chunk=>{
      input+=chunk
      if(input.length>1024) {socket.destroy();return}
      if(!input.includes('\n')) return
      let request; try {request=JSON.parse(input)} catch {socket.destroy();return}
      if(request.token!==token || request.pid!==process.pid || !process.listenerCount('SIGINT')) {socket.end('refused\n');return}
      socket.end('ok\n',()=>{process.emit('SIGINT')})
    })
  })
  server.on('error',error=>{console.error('Native service control failed: '+error.message);process.exitCode=1})
  server.listen(pipe); server.unref()
}
