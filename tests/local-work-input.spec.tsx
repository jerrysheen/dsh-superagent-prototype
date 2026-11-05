import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LocalWorkInput } from '../src/client/local-work-input.tsx'
it('shows original Engine input with an explicit work identity and a disabled execution gate', () => {
  const html = renderToStaticMarkup(createElement(LocalWorkInput, { enabled: false, paused: true }))
  expect(html).toContain('工作标识')
  expect(html).toContain('工作目录')
  expect(html).toContain('disabled')
  expect(html).toContain('原版 Engine')
  expect(html).not.toContain('verified_done')
})
