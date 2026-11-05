import { describe, expect, it } from 'vitest'
import type { SessionCard } from '../src/app/session-hub.ts'
import { codexNativeThreadId, nativeSessionLinks, nativeTaskLinks, nativeWindowsWorkspace } from '../src/client/native-ui-links.ts'

function session(provider: string, threadId: string | null, workspacePath?: string): SessionCard {
  return {
    uid: 'test-uid', provider, surface: provider === 'codex' ? 'codex' : 'other',
    mode: 'work', projectId: 'GIGNew', projectName: 'GIGNew', threadId,
    title: '本地测试', summary: '', scope: 'local', identity: 'operator_confirmed',
    capabilities: { read: 'import', send: 'user' }, evidence: [], origin: 'manual',
    ...(workspacePath ? { workspacePath } : {}),
  }
}
const uuid = '019d25ff-3701-75d1-b331-160b90f8a456'
describe('Native GUI navigation links never auto-send', () => {
  it('opens an exact Codex thread only with a validated UUID', () => {
    expect(codexNativeThreadId(uuid)).toBe(uuid)
    expect(codexNativeThreadId('codex://threads/' + uuid)).toBe(uuid)
    expect(codexNativeThreadId('not-a-uuid')).toBeNull()
    expect(codexNativeThreadId('codex://threads/' + uuid + '?x=1')).toBeNull()
    const link = nativeSessionLinks(session('codex', uuid))[0]!
    expect(link.href).toBe('codex://threads/' + uuid)
    expect(link.semantics).toBe('exact_existing_chat')
    expect(nativeSessionLinks({ ...session('codex', uuid), origin: 'test' })).toHaveLength(0)
  })
  it('supports a new Codex composer with a separately provided Windows workspace', () => {
    const path = 'F:\\ElexGithub\\GIGNew\\client'
    const item = nativeTaskLinks(session('codex', null, path), '检查 GC Profiler & 下一步')[0]!
    expect(item.semantics).toBe('composer_draft')
    expect(item.href).toContain('codex://new?prompt=')
    expect(item.href).toContain('&path=F%3A%5CElexGithub%5CGIGNew%5Cclient')
    expect(decodeURIComponent(item.href)).toContain('检查 GC Profiler & 下一步')
  })
  it('rejects ambiguous paths instead of guessing from project ID', () => {
    expect(nativeWindowsWorkspace('GIGNew')).toBeNull()
    expect(nativeWindowsWorkspace('..\\GIGNew')).toBeNull()
    expect(nativeWindowsWorkspace('\\\\server\\share')).toBeNull()
    expect(nativeTaskLinks(session('codex', null), '检查功能')[0]!.href).not.toContain('path=')
  })
  it('Cursor only prefills text, never claims to open an existing IDE chat', () => {
    const item = nativeTaskLinks(session('cursor', 'unverified-id'), '修复 GC 路由 & 测试')[0]!
    expect(item.href).toBe('cursor://anysphere.cursor-deeplink/prompt?text=%E4%BF%AE%E5%A4%8D%20GC%20%E8%B7%AF%E7%94%B1%20%26%20%E6%B5%8B%E8%AF%95')
    expect(item.semantics).toBe('composer_draft')
    expect(nativeSessionLinks(session('cursor', 'unverified-id'))).toEqual([])
  })
  it('never builds a URL for unrelated bots or excessively long prompts', () => {
    expect(nativeTaskLinks(session('grok', null), 'task')).toEqual([])
    expect(nativeTaskLinks(session('cursor', null), 'x'.repeat(10000))).toEqual([])
    expect(nativeTaskLinks(session('codex', null), '')).toEqual([])
  })
})
