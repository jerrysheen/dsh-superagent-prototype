/** Metadata-only references to catalogued external conversations and existing Engine workers. */
import type { ContextTargets, TargetCard } from './context-targets.ts'

export interface WorkerReference {
  uid: string; threadId: string; provider: 'codex' | 'dsh' | 'chatgpt'; scope?: 'local' | 'cloud'; title: string
  projectName: string; workspace: string; summary: string
}
const reference = (card: TargetCard): WorkerReference => ({
  uid: card.uid, threadId: card.threadId, provider: card.kind === 'codex' || !card.threadId.startsWith('worker-') ? 'codex' : 'dsh',
  title: card.title.slice(0, 500), projectName: card.projectName.slice(0, 200), workspace: card.workspace,
  summary: card.summary.slice(0, 1200),
})

/** Search all permitted metadata before limiting the menu; no transcript or task mutation. */
export function workerReferences(targets: Pick<ContextTargets, 'cards'>, query: string, limit = 12) {
  const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
  const cards = targets.cards().filter(card => !card.archived && words.every(word =>
    [card.title, card.projectName, card.workspace, card.summary, card.threadId].join(' ').normalize('NFKC').toLowerCase().includes(word)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.uid.localeCompare(b.uid))
  return { items: cards.slice(0, limit).map(reference), total: cards.length }
}

/** Resolve again at submit time so deletion/archival cannot silently become a stale reference. */
export function resolveWorkerReference(targets: Pick<ContextTargets, 'card'>, uid: string): WorkerReference {
  const card = targets.card(uid)
  if (!card || card.archived) throw new Error('引用的 Worker 对话已删除、归档或不可用，请重新选择。')
  return reference(card)
}
