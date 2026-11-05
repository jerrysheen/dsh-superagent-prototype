// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SourceCode, SyntaxCode, fileLanguage } from '../src/client/syntax-highlight.tsx'
const render = (element: React.ReactElement) => { const host = document.createElement('div'); host.innerHTML = renderToStaticMarkup(element); return host }
it('colors keywords, strings and numbers while preserving the exact code including blank lines', () => {
  const text = 'const greeting = "hello"\n\nconst value = 42\n'
  const host = render(<SyntaxCode text={text} language="ts" />)
  expect(host.textContent).toBe(text)
  expect(host.querySelector('.hljs-keyword')!.textContent).toBe('const')
  expect(host.querySelector('.hljs-string')!.textContent).toBe('"hello"')
  expect(host.querySelector('.hljs-number')!.textContent).toBe('42')
})
it('retains multi-line grammar context, source line numbers and the selected target line', () => {
  const text = '/* first\nsecond */\nconst count = 2;\n'
  const host = render(<SourceCode text={text} path="F:/Project/main.ts" selectedLine={2} />)
  expect(host.querySelectorAll('[data-line]')).toHaveLength(4)
  expect(host.querySelector('[data-line="2"] .hljs-comment')!.textContent).toBe('second */')
  expect(host.querySelector('[data-selected]')!.getAttribute('data-line')).toBe('2')
  expect(host.querySelector('[data-line="3"] .hljs-keyword')!.textContent).toBe('const')
  expect(fileLanguage('F:/Project/SCRIPT.PS1')).toBe('powershell')
  expect(fileLanguage('guide.md')).toBe('markdown')
})
it('keeps unknown grammars and HTML-looking code literal, with a bounded large-file fallback', () => {
  const text = '<img src=x onerror="boom()">\n'
  const unknown = render(<SyntaxCode text={text} language="unregistered-language" />)
  const html = render(<SyntaxCode text={text} language="html" />)
  expect(unknown.textContent).toBe(text); expect(html.textContent).toBe(text)
  expect(html.querySelector('img')).toBeNull()
  expect(unknown.querySelector('[class^="hljs-"]')).toBeNull()
  const largeText = 'const value = 1;\n'.repeat(8000)
  const large = render(<SyntaxCode text={largeText} language="javascript" />)
  expect(large.textContent).toBe(largeText)
  expect(large.querySelector('[class^="hljs-"]')).toBeNull()
})
