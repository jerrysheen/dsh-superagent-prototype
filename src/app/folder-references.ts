import type { ContextTargets } from './context-targets.ts'

export interface FolderReference { uid: string; title: string; workspace: string }
const publicWorkspace = (workspace: string) => !workspace.split(/[\\/]/).some(part => /^(?:\.local|\.git|\.codex|\.ssh|\.aws|\.azure|\.env(?:\..*)?|node_modules|sessions?)$/i.test(part))

export function folderReferences(targets: Pick<ContextTargets, 'cards'>, query = '', limit = 12): FolderReference[] {
  const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
  const folders = new Map<string, FolderReference>()
  for (const card of targets.cards()) {
    if (card.archived || !publicWorkspace(card.workspace) || !words.every(word => (card.projectName + ' ' + card.workspace).normalize('NFKC').toLowerCase().includes(word))) continue
    folders.set(card.projectId, { uid: card.projectId, title: card.projectName, workspace: card.workspace })
  }
  return [...folders.values()].sort((left, right) => left.workspace.localeCompare(right.workspace)).slice(0, limit)
}

export function resolveFolderReference(targets: Pick<ContextTargets, 'cards'>, uid: string): FolderReference {
  const card = targets.cards().find(card => !card.archived && publicWorkspace(card.workspace) && card.projectId === uid)
  if (!card) throw Error('引用的工程文件夹已不可用，请重新选择。')
  return { uid: card.projectId, title: card.projectName, workspace: card.workspace }
}
