/** Native DSH panel child navigation. This seat is declared by our DSH sidebar fork. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionCard } from '../app/session-hub.ts'
import { getHubNavigation, navigateHub, requestTaskDraft, subscribeHubNavigation } from './hub-navigation.ts'

export interface SessionPanelSubnavProps {
  wide: boolean
  active: boolean
}
function sourceLabel(card: SessionCard): string {
  const value = (card.provider + ' ' + card.surface).toLowerCase()
  if (value.includes('cursor')) return 'Cursor'
  if (value.includes('codex')) return 'Codex'
  if (value.includes('grok')) return 'Grok'
  if (value.includes('chatgpt')) return 'ChatGPT'
  if (value.includes('dsh') || value.includes('deepseek')) return 'DSH'
  return card.provider
}

/** The sidebar shows only registered sessions: no invented conversation history or live execution. */
export function SessionPanelSubnav({ wide, active }: SessionPanelSubnavProps) {
  const navigation = useSyncExternalStore(subscribeHubNavigation, getHubNavigation, getHubNavigation)
  const [sessions, setSessions] = useState<SessionCard[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState(false)
  useEffect(() => {
    if (!wide || !active) return
    let live = true
    const refresh = async () => {
      try {
        const response = await fetch('/session-hub/api/snapshot', { headers: { 'x-orchestrator-request': '1' } })
        if (!response.ok) throw new Error('Cannot load registered sessions')
        const result = await response.json() as { sessions: SessionCard[] }
        if (live) { setSessions(result.sessions); setFailure(false) }
      } catch { if (live) setFailure(true) }
      finally { if (live) setLoading(false) }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 8000)
    return () => { live = false; window.clearInterval(timer) }
  }, [wide, active])
  if (!wide || !active) return null
  const selected = navigation.sessionUid === '__new__' ? null : navigation.sessionUid ?? sessions[0]?.uid
  return <div className="hub-native-subnav" aria-label="SuperAgent 会话">
    <div className="hub-native-subnav-heading"><span>会话</span>
      <button type="button" title="创建 SuperAgent 任务" aria-label="创建 SuperAgent 任务" onClick={requestTaskDraft}>＋</button>
    </div>
    <div className="hub-native-subnav-list">
      {sessions.length ? sessions.map(card => <button key={card.uid} type="button"
        className={'hub-native-subnav-row' + (navigation.view === 'workspace' && selected === card.uid ? ' hub-native-subnav-selected' : '')}
        aria-current={navigation.view === 'workspace' && selected === card.uid ? 'page' : undefined}
        onClick={() => navigateHub({ view: 'workspace', sessionUid: card.uid })}>
        <span className="hub-native-subnav-bullet" aria-hidden="true" />
        <span className="hub-native-subnav-title">{card.title}<small>{sourceLabel(card)}</small></span>
      </button>) : <p className="hub-native-subnav-empty">{loading ? '读取会话…' : failure ? '会话加载失败' : '暂无已登记会话'}</p>}
    </div>
    <button type="button" className="hub-native-subnav-all" onClick={() => navigateHub({ view: 'tasks' })}>任务列表 ↗</button>
  </div>
}
