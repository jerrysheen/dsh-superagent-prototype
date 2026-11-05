// @vitest-environment jsdom
/** Native @ source, reference serialization and revision-guarded drag insertion. */
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatContent } from '../src/client/agent-chat.tsx'
import { WORKER_REFERENCE_MIME, workerReferenceSource, folderReferenceSource, referenceChip, readWorkerDrag, writeWorkerDrag } from '../src/client/worker-references.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const item = { uid: 'codex:worker-one', threadId: 'worker-one', provider: 'codex' as const, title: '资源分析',
  projectName: 'Project A', workspace: 'F:\\Project A', summary: '已确定问题范围' }
const request = { query: '资源', position: 'inline' as const, drilled: false, signal: new AbortController().signal }
afterEach(() => vi.unstubAllGlobals())

it('offers folder chips to the master and serializes path metadata without authority or file contents', async () => {
  const folder = { uid: 'project:one', title: 'Project A', workspace: 'F:\\Project A' }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/state') ? { masterId: 'master' }
    : url.includes('/folders?') ? { items: [folder] } : { reference: folder })))
  const source = folderReferenceSource()
  expect(await source.candidates({ sessionId: 'other' as never }, request)).toEqual([])
  const rows = await source.candidates({ sessionId: 'master' as never }, request)
  expect(rows[0]).toMatchObject({ section: '工程文件夹', icon: 'folder', description: folder.workspace })
  expect(await source.codec!.serialize(folder.uid, request.signal)).toContain('not file contents or execution/write authorization')
})

it('adds external Workers only to the master @ menu and serializes fresh metadata as a hint', async () => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith('/state') ? { masterId: 'master' }
    : url.includes('/references?') ? { items: [item] } : { reference: item }))
  vi.stubGlobal('fetch', fetch)
  const source = workerReferenceSource()
  expect(await source.candidates({ sessionId: 'other' as never }, request)).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
  const rows = await source.candidates({ sessionId: 'master' as never }, request)
  expect(rows[0]).toMatchObject({ label: item.title, section: 'Worker 对话', description: expect.stringContaining('Project A') })
  const picked = source.onPick!({ candidate: rows[0]!, session: { sessionId: 'master' as never }, position: 'inline', via: 'menu',
    action: 'pick', span: { start: 2, end: 5, draftRev: 3 } })
  expect(picked).toEqual({ insert: referenceChip(item) })
  const serialized = await source.codec!.serialize(item.uid, request.signal)
  expect(serialized).toContain('no send or execution authorization')
  expect(serialized).toContain(item.uid)
  expect(serialized).toContain('catalog_metadata_and_summary')
  expect(fetch.mock.calls.every(call => !(call[1] as RequestInit | undefined)?.method)).toBe(true)
})

it('blocks submission when the selected Worker is no longer available', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '会话已归档' }, { status: 400 })))
  await expect(workerReferenceSource().codec!.serialize(item.uid, request.signal)).rejects.toThrow('会话已归档')
})

it('accepts only versioned source-owned session drags and preserves identity independently of title', () => {
  const values = new Map<string, string>()
  const data = { setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? '', effectAllowed: 'copy' as DataTransfer['effectAllowed'] }
  writeWorkerDrag(data, item.uid, '同名工作')
  expect(readWorkerDrag(data)).toBe(item.uid)
  expect(readWorkerDrag({ getData: () => 'F:\\some-file' })).toBeUndefined()
  expect(readWorkerDrag({ getData: () => JSON.stringify({ version: 2, uid: item.uid }) })).toBeUndefined()
})

it('drops a canonical reference through native input actions without submitting or overwriting a newer draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ reference: item })))
  const span = { start: 4, end: 4, draftRev: 7 }
  const insertReference = vi.fn(() => false)
  const inputActions = { captureInsertion: () => span, persistDraft: vi.fn(), submit: vi.fn() }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    const props = { useSession: (select: (value: unknown) => unknown) => select({ blank: false, running: false, openState: 'open' }),
      useConversation: (select: (value: unknown) => unknown) => select({ activeTargets: new Set() }),
      renderFactorySlot: () => <div>Native composer</div>, inputActions, insertReference }
    await act(async () => root.render(<AgentChatContent {...props as unknown as ComponentProps<typeof AgentChatContent>} />))
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: [WORKER_REFERENCE_MIME], getData: () => JSON.stringify({ version: 1, uid: item.uid }) } })
    await act(async () => container.querySelector('.sa-reference-chat')!.dispatchEvent(drop))
    expect(insertReference).toHaveBeenCalledWith(referenceChip(item), span)
    expect(container.textContent).toContain('输入内容已变化')
    expect(inputActions.submit).not.toHaveBeenCalled()
    expect(inputActions.persistDraft).not.toHaveBeenCalled()
    insertReference.mockReturnValue(true)
    await act(async () => container.querySelector('.sa-reference-chat')!.dispatchEvent(drop))
    expect(container.textContent).toContain('已引用')
    expect(inputActions.persistDraft).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})
