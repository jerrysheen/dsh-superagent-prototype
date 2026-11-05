/** References resolve only permitted current metadata and never infer identity from a title. */
import { expect, it } from 'vitest'
import { workerReferences, resolveWorkerReference } from '../src/app/worker-references.ts'
import { folderReferences, resolveFolderReference } from '../src/app/folder-references.ts'
import type { TargetCard } from '../src/app/context-targets.ts'

const card = (uid: string, title: string, projectName = 'Project'): TargetCard => ({ uid, threadId: uid.slice(uid.indexOf(':') + 1),
  title, projectName, projectId: 'project:' + projectName, workspace: 'F:\\' + projectName, summary: '只读分析进展',
  verified: false, archived: false, updatedAt: 1, kind: 'codex', fingerprint: 'a'.repeat(64) })

it('offers canonical project folders once and excludes archived projects without traversing files', () => {
  const cards = [card('codex:a', 'One', 'A'), card('codex:b', 'Two', 'A'), { ...card('codex:c', 'Old', 'C'), archived: true },
    { ...card('codex:private', 'Private', 'private'), workspace: 'F:\\Repo\\.local\\test' }]
  expect(folderReferences({ cards: () => cards })).toEqual([{ uid: 'project:A', title: 'A', workspace: 'F:\\A' }])
  expect(folderReferences({ cards: () => cards }, 'F:\\A')).toHaveLength(1)
  expect(resolveFolderReference({ cards: () => cards }, 'project:A').workspace).toBe('F:\\A')
  expect(() => resolveFolderReference({ cards: () => cards }, 'project:C')).toThrow('不可用')
  expect(() => resolveFolderReference({ cards: () => cards }, 'project:private')).toThrow('不可用')
})

it('searches the entire catalog before limiting and distinguishes identical titles across projects', () => {
  const cards = [card('codex:one', '同名工作', 'A'), card('codex:two', '同名工作', 'B')]
  expect(workerReferences({ cards: () => cards }, 'B', 1)).toMatchObject({ total: 1, items: [{ uid: 'codex:two', projectName: 'B' }] })
  expect(workerReferences({ cards: () => cards }, '同名工作').items.map(item => item.uid)).toEqual(['codex:one', 'codex:two'])
})
it('excludes archived metadata and fails a deleted or archived submit-time reference', () => {
  const archived = { ...card('codex:old', 'Old'), archived: true }
  expect(workerReferences({ cards: () => [archived] }, '').items).toEqual([])
  expect(() => resolveWorkerReference({ card: () => archived }, archived.uid)).toThrow(/归档/)
  expect(() => resolveWorkerReference({ card: () => undefined }, 'unknown')).toThrow(/不可用/)
})
it('uses canonical Engine identity for a bound Codex alias and keeps DSH workers distinct', () => {
  const canonical = { ...card('engine:task-a', 'Worker'), threadId: 'native-thread', kind: 'engine' as const }
  expect(resolveWorkerReference({ card: () => canonical }, 'codex:native-thread')).toMatchObject({ uid: 'engine:task-a', provider: 'codex' })
  expect(resolveWorkerReference({ card: () => ({ ...canonical, threadId: 'worker-task-a' }) }, canonical.uid).provider).toBe('dsh')
})
