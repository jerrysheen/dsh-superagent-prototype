import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SessionHubPage } from '../src/client/session-hub.tsx'

it('renders one native-feeling conversation workspace without a nested session rail', () => {
  const html = renderToStaticMarkup(createElement(SessionHubPage))
  expect(html).toContain('SuperAgent')
  expect(html).toContain('当前会话')
  expect(html).toContain('新任务 / 智能推荐')
  expect(html).toContain('给 SuperAgent 输入任务')
  expect(html).toContain('Ctrl / ⌘ + Enter')
  expect(html).toContain('准备分派')
  expect(html).toContain('外部发送')
  for (const name of ['ChatGPT', 'Cursor', 'Codex', 'Grok bot', 'DSH Worker']) expect(html).toContain(name)
  expect(html).not.toContain('hub-rail')
  expect(html).not.toContain('hub-inspector')
  expect(html).not.toContain('ROUTING PIPELINE')
})
