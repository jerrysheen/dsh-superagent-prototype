import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ConversationMarkdown } from '../src/client/conversation-markdown.tsx'
import { CodexWorkspacePage } from '../src/client/codex-workspace.tsx'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'

const render = (text: string) => renderToStaticMarkup(createElement(ConversationMarkdown, { text }))
it('renders structured replies with nested lists, fenced code and GFM tables', () => {
  const html = render('## Result\n\n**Ready** and `inline`\n\n- parent\n  - child\n\n```ts\nconst answer = 42\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n> quote\n\n- [x] done\n\n~~removed~~\n\nline  \nbreak')
  expect(html).toMatch(/<h2[^>]*>Result<\/h2>/)
  expect(html).toContain('<strong>Ready</strong>')
  expect(html).toContain('<code>inline</code>')
  expect(html).toMatch(/parent\s*<ul>/)
  expect(html).toContain('<pre><code class="cw-syntax language-ts">')
  expect(html).toContain('<span class="hljs-keyword">const</span>')
  expect(html).toContain('<span class="hljs-number">42</span>')
  expect(html).toContain('class="cw-markdown-table"><table>')
  expect(html).toContain('<td>b</td>')
  expect(html).toContain('<blockquote>')
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('<del>removed</del>')
  expect(html).toContain('line<br/>')
})
it('keeps code literal, omits raw HTML and filters executable links', () => {
  const html = render('[safe](https://example.com) [bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n```html\n<img onerror="alert(1)">\n```')
  expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"')
  expect(html).not.toContain('javascript:')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html.replace(/<[^>]*>/g, '')).toContain('&lt;img onerror=')
})
it('uses Markdown for historical and live assistant messages while preserving user input literally', async () => {
  const store = new CodexWorkspaceStore()
  const thread = { provider: 'codex' as const, threadId: '01a1a0f6-353d-7581-b6dd-077563be0280', title: 'Test', cwd: 'F:/Test', projectName: 'Test', updatedAt: 1 }
  store.select(thread)
  // Inject only synthetic transcript data; never read actual session histories in tests.
  const snapshot = store.getSnapshot()
  snapshot.transcripts[thread.threadId] = { threadId: thread.threadId, loaded: true, loading: false, error: '', nextCursor: null, turns: [
    { id: 'old', startedAt: 1, status: 'completed', messages: [{ id: 'reply', role: 'assistant', text: '## Historical', truncated: false }] },
  ] }
  store.addExchange({ requestId: 'new', threadId: thread.threadId, question: '**literal question**', text: '**Live answer**' })
  const html = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(html).toMatch(/<h2[^>]*>Historical<\/h2>/)
  expect(html).toContain('<strong>Live answer</strong>')
  expect(html).toContain('**literal question**')
  expect(html).not.toContain('<strong>literal question</strong>')
})
