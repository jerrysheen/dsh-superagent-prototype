// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReferenceTextarea } from '../src/client/reference-textarea.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('inserts a canonical project folder with keyboard selection without sending or opening files', async () => {
  const fetch = vi.fn(async () => Response.json({ items: [{ uid: 'project:one', title: 'Project A', workspace: 'F:\\Project A' }] }))
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  function Editor() { const [value, setValue] = useState(''); return <ReferenceTextarea value={value} onChange={setValue} aria-label="Test input" /> }
  try {
    await act(async () => root.render(<Editor />))
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelector('[role=option]')?.textContent).toContain('Project A')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(textarea.value).toBe('@"F:/Project A/" ')
    expect(host.querySelector('[role=listbox]')).toBeNull()
    expect(fetch.mock.calls.every((call: unknown[]) => String(call[0]).includes('/context/folders?'))).toBe(true)
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
