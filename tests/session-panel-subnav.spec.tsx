import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SessionPanelSubnav } from '../src/client/session-panel-subnav.tsx'
import { getHubNavigation, navigateHub, requestTaskDraft, subscribeHubNavigation } from '../src/client/hub-navigation.ts'

it('only renders the session submenu while its DSH panel is selected and expanded', () => {
  expect(renderToStaticMarkup(createElement(SessionPanelSubnav, { wide: false, active: true }))).toBe('')
  expect(renderToStaticMarkup(createElement(SessionPanelSubnav, { wide: true, active: false }))).toBe('')
  const html = renderToStaticMarkup(createElement(SessionPanelSubnav, { wide: true, active: true }))
  expect(html).toContain('SuperAgent 会话')
  expect(html).toContain('会话')
  expect(html).toContain('任务列表')
  expect(html).toContain('读取会话')
})

it('publishes navigation changes to both the sidebar and the main page', () => {
  const old = getHubNavigation()
  let calls = 0
  const unlisten = subscribeHubNavigation(() => { calls++ })
  navigateHub({ view: 'tasks', sessionUid: 'session-1' })
  expect(getHubNavigation().sessionUid).toBe('session-1')
  expect(getHubNavigation().view).toBe('tasks')
  requestTaskDraft()
  expect(getHubNavigation().view).toBe('workspace')
  expect(getHubNavigation().sessionUid).toBe('__new__')
  expect(getHubNavigation().focusKey).toBe(old.focusKey + 1)
  expect(calls).toBe(2)
  unlisten()
  navigateHub(old)
})
