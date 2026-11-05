import { expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { DesktopActivityClient, DesktopActivityObserver, DesktopChatClient, DesktopProjectClient, DesktopWorkClient, desktopActivityPipe } from '../src/app/desktop-activity.ts'
import { SessionActivities } from '../src/app/session-activity.ts'
import type { ContextTargets } from '../src/app/context-targets.ts'
const id = '01a1a4a1-9b15-7202-9b2e-36a217f5535d', other = '01a1a48d-7bad-7cc0-8a09-a957b900fe30'
const workspace = 'f:\\github\\dshsuperagent'
it('uses the supported desktop project creation and progress tools with the requested Sol medium default', async () => {
  const reader = { initialize: vi.fn(async () => {}), close: vi.fn(), request: vi.fn(async () => ({ data: [{ id: 'turn', status: 'inProgress', items: [] }] })) }
  const client = new DesktopWorkClient('\\\\.\\pipe\\dsh-desktop-test-' + randomUUID(), id, () => reader)
  const call = vi.spyOn(client as unknown as { callTool(name: string, args: unknown, callId?: string): Promise<any> }, 'callTool')
  const response = (value: unknown) => ({ contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })
  try {
    call.mockResolvedValueOnce(response({ threadId: other, hostId: 'local' }))
    expect(await client.create('project', '修复入口', '明确的用户需求', 'receipt')).toEqual({ threadId: other, hostId: 'local' })
    expect(call).toHaveBeenLastCalledWith('create_thread', { target: { type: 'project', projectId: 'project', environment: { type: 'local' } }, title: '修复入口', prompt: '明确的用户需求', model: 'gpt-6.1-sol', thinking: 'medium' }, 'receipt')
    call.mockResolvedValueOnce(response({ threads: [{ id: other, hostId: 'local', status: 'active' }] }))
    expect(await client.snapshot(other)).toMatchObject({ thread: { id: other }, latestTurn: { status: 'inProgress' } })
    expect(reader.request).toHaveBeenCalledWith('thread/turns/list', { threadId: other, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
  } finally { call.mockRestore(); client.close() }
})
it('reads only the current dispatched turn result, discards user messages and never takes a writer', async () => {
  const reader = { initialize: vi.fn(async () => {}), close: vi.fn(), request: vi.fn(async (method: string, _args: unknown): Promise<any> => method === 'thread/turns/list'
    ? { data: [{ id: 'current-turn', status: 'completed', completedAt: 123, items: [] }] }
    : { data: [{ turnId: 'current-turn', item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'not exported' }] } },
      { turnId: 'current-turn', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'current work result' } }] }) }
  const client = new DesktopWorkClient('\\\\.\\pipe\\dsh-result-test-' + randomUUID(), id, () => reader)
  const call = vi.spyOn(client as unknown as { callTool(name: string, args: unknown): Promise<any> }, 'callTool')
    .mockResolvedValue({ contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [{ id: other, hostId: 'local', status: 'idle' }] }) }] })
  try {
    expect(await client.snapshot(other)).toMatchObject({ latestAssistantMessage: { id: 'final', text: 'current work result' } })
    expect(reader.request.mock.calls).toEqual([
      ['thread/turns/list', { threadId: other, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }],
      ['thread/items/list', { threadId: other, turnId: 'current-turn', limit: 100, sortDirection: 'asc' }],
    ])
  } finally { client.close(); call.mockRestore() }
})
it('registers a native Engine thread in the exact local desktop project and requires independent metadata proof', async () => {
  const client = new DesktopProjectClient('\\\\.\\pipe\\dsh-project-test-' + randomUUID(), id)
  const call = vi.spyOn(client as unknown as { callTool(name: string, args: unknown): Promise<unknown> }, 'callTool')
  const response = (value: unknown) => ({ contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })
  const projects = [{ projectId: 'project', projectKind: 'local', label: 'DSHSuperAgent', path: workspace, hostId: 'local' }]
  call.mockImplementation(async name => name === 'list_projects' ? response({ projects })
    : name === 'list_threads' ? response({ threads: [{ id: other, cwd: workspace, projectId: 'project', hostId: 'local' }] }) : response({}))
  try {
    await expect(client.publish(other, workspace)).resolves.toMatchObject({ projectId: 'project', projectName: 'DSHSuperAgent' })
    expect(call).toHaveBeenCalledWith('move_thread_to_project', { threadId: other, projectId: 'project', source: 'codex', hostId: 'local' })
    expect(call.mock.calls.every(([name]) => ['list_projects', 'move_thread_to_project', 'list_threads'].includes(name))).toBe(true)
    call.mockImplementation(async name => name === 'list_projects' ? response({ projects }) : name === 'list_threads'
      ? response({ threads: [{ id: other, cwd: workspace, projectId: null, hostId: 'local' }] }) : response({}))
    await expect(client.publish(other, workspace)).rejects.toThrow('归属尚未得到')
    call.mockResolvedValue(response({ projects: [...projects, { ...projects[0], projectId: 'duplicate' }] }))
    await expect(client.publish(other, workspace)).rejects.toThrow('唯一匹配')
  } finally { call.mockRestore(); client.close() }
})
it('requires an exact cloud target receipt and never sends model or reasoning overrides', async () => {
  const client = new DesktopChatClient('\\\\.\\pipe\\dsh-cloud-test-' + randomUUID(), id)
  const call = vi.spyOn(client as unknown as { callTool(name: string, args: unknown, callId: string): Promise<unknown> }, 'callTool')
  try {
    call.mockResolvedValue({ contentItems: [] })
    await expect(client.send(other, '问题', 'receipt', true)).rejects.toThrow(/匹配的目标回执/)
    call.mockResolvedValue({ contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: id }) }] })
    await expect(client.send(other, '问题', 'receipt', true)).rejects.toThrow('Desktop target mismatch')
    call.mockResolvedValue({ contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: other }) }] })
    await expect(client.send(other, '问题', 'receipt', true)).resolves.toMatchObject({ receiptId: 'receipt' })
    expect(call).toHaveBeenLastCalledWith('send_message_to_thread', { threadId: other, prompt: '问题' }, 'receipt')
  } finally { call.mockRestore(); client.close() }
})
it('rediscovers a restarted desktop endpoint but never guesses between multiple desktops', () => {
  const prefix = '\\\\.\\pipe\\', prior = 'codex-app-tools-' + id, next = 'codex-app-tools-' + other
  expect(desktopActivityPipe(prefix + prior, [next])).toBe(prefix + next)
  expect(desktopActivityPipe(prefix + prior, [next, 'codex-app-tools-' + randomUUID()])).toBe(prefix + prior)
  expect(desktopActivityPipe(prefix + 'other-service', [next])).toBe(prefix + 'other-service')
})
it('uses only readonly thread-list calls over fragmented Windows pipe frames and discards summaries', async () => {
  const path = '\\\\.\\pipe\\dsh-activity-test-' + randomUUID(), requests: any[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let bytes = Buffer.alloc(0)
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data])
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
        const size = bytes.readUInt32LE(0), request = JSON.parse(bytes.subarray(4, size + 4).toString()); bytes = bytes.subarray(size + 4); requests.push(request)
        const result = request.method === 'tools/list' ? { tools: [{ name: 'list_threads', namespace: 'codex-app' }] }
          : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [{ id, cwd: workspace, status: 'active', summary: 'DO NOT EXPORT', title: 'private' }], nextCursor: 'next' }) }] }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })), frame = Buffer.alloc(payload.length + 4)
        frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  const client = new DesktopActivityClient(path, id)
  try {
    expect(await client.read()).toEqual({ threads: [{ id, cwd: workspace, status: 'active', title: 'private' }], nextCursor: 'next' })
    client.close(); expect((await client.read('next')).threads[0]?.status).toBe('active')
    expect(requests.every(r => r.method === 'tools/list' || r.method === 'tools/call' && r.params.tool === 'list_threads')).toBe(true)
    expect(requests.filter(r => r.method === 'tools/call').map(r => r.params.arguments)).toEqual([{ mode: 'history', limit: 50 }, { mode: 'history', limit: 50, cursor: 'next' }])
  } finally { client.close(); sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('continuously observes both sessions, follows pagination and reconnects without losing a running indicator', async () => {
  const targets = { cards: () => [id, other].map(threadId => ({ threadId, workspace, archived: false })), card: (uid: string) => [id, other].some(value => uid === 'codex:' + value) ? { workspace, archived: false } : undefined } as unknown as ContextTargets
  const activities = new SessionActivities({ targets })
  activities.snapshot([id, other])
  const read = vi.fn().mockResolvedValueOnce({ threads: [{ id, cwd: workspace, status: 'active' }], nextCursor: 'second' })
    .mockResolvedValueOnce({ threads: [{ id: other, cwd: workspace, status: 'notLoaded' }] })
    .mockRejectedValueOnce(Error('Disconnected')).mockResolvedValue({ threads: [{ id, cwd: workspace, status: 'idle' }, { id: other, cwd: workspace, status: 'idle' }] })
  const close = vi.fn(), observer = new DesktopActivityObserver({ client: { read, close }, targets, activities })
  await observer.tick()
  expect(activities.snapshot([id, other]).map(row => row.state)).toEqual(['running', 'idle'])
  expect(read.mock.calls[1]).toEqual(['second'])
  await observer.tick(); expect(close).toHaveBeenCalledOnce()
  expect(activities.snapshot([id])[0]?.state).toBe('running')
  await observer.tick(); expect(activities.snapshot([id])[0]?.state).toBe('idle')
  await observer.stop()
})
it('sends an explicit selected-session message through the desktop owner without model or permission overrides', async () => {
  const path = '\\\\.\\pipe\\dsh-chat-test-' + randomUUID(), calls: any[] = [], sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let bytes = Buffer.alloc(0)
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data])
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
        const size = bytes.readUInt32LE(0), request = JSON.parse(bytes.subarray(4, size + 4).toString()); bytes = bytes.subarray(size + 4); calls.push(request)
        const result = request.method === 'tools/list' ? { tools: [{ name: 'send_message_to_thread', namespace: 'codex-app' }] }
          : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: other, accepted: true }) }] }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })), frame = Buffer.alloc(payload.length + 4)
        frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve)); const client = new DesktopChatClient(path, id)
  try {
    await expect(client.send(other, 'explicit typed question', 'request-id')).resolves.toMatchObject({ receiptId: 'request-id', transport: 'desktop_app' })
    expect(calls.filter(call => call.method === 'tools/call')[0].params).toMatchObject({ tool: 'send_message_to_thread', arguments: { threadId: other, prompt: 'explicit typed question' } })
    expect(Object.keys(calls[1].params.arguments)).toEqual(['threadId', 'prompt'])
  } finally { client.close(); sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('treats neither missing rows nor an invalid response as proof that a running worker stopped', async () => {
  const targets = { cards: () => [{ threadId: id, workspace, archived: false }], card: () => ({ workspace, archived: false }) } as unknown as ContextTargets
  const activities = new SessionActivities({ targets })
  activities.publish({ observedAt: new Date().toISOString(), sessions: [{ threadId: id, workspace, state: 'running' }] })
  const read = vi.fn(async () => ({ threads: [] })), observer = new DesktopActivityObserver({ targets, activities, client: { read, close: vi.fn() } })
  await observer.tick(); expect(activities.snapshot([id])[0]?.state).toBe('running'); await observer.stop()
})
