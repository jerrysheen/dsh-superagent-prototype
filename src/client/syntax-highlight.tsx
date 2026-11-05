import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { common, createLowlight } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'

const highlighter = createLowlight(common)
highlighter.register('powershell', powershell)
const extensions: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  cs: 'csharp', py: 'python', ps1: 'powershell', sh: 'bash', yml: 'yaml', md: 'markdown', mdx: 'markdown', rs: 'rust', h: 'c', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', scss: 'scss' }
export function fileLanguage(path: string) { const extension = path.split('.').at(-1)?.toLowerCase() ?? ''; return extensions[extension] ?? extension }
type Token = { type: string; value?: string; properties?: { className?: unknown }; children?: Token[] }

/** Highlight the whole file before splitting, so multi-line comments/strings retain their grammar context. */
export function highlightedLines(text: string, language = ''): ReactNode[][] {
  const lines: ReactNode[][] = [[]]
  if (text.length > 120000 || !language || !highlighter.registered(language)) return text.split('\n').map(line => [line])
  try {
    const visit = (node: Token, inherited: string[] = []) => {
      if (node.type === 'text') {
        const pieces = (node.value ?? '').split('\n')
        pieces.forEach((piece, index) => {
          if (index) lines.push([])
          const line = lines.at(-1)!
          if (piece) line.push(inherited.length ? <span key={line.length} className={inherited.join(' ')}>{piece}</span> : piece)
        })
      } else {
        const classes = node.properties?.className
        const next = [...inherited, ...(Array.isArray(classes) ? classes.map(String) : [])]
        for (const child of node.children ?? []) visit(child, next)
      }
    }
    for (const node of highlighter.highlight(language, text).children) visit(node)
    return lines
  } catch { return text.split('\n').map(line => [line]) }
}

export const SyntaxCode = memo(function SyntaxCode({ text, language, className = '' }: { text: string; language?: string; className?: string }) {
  const lines = useMemo(() => highlightedLines(text, language), [text, language])
  return <code className={'cw-syntax ' + className}>{lines.map((line, index) => <Fragment key={index}>{index > 0 ? '\n' : ''}{line}</Fragment>)}</code>
})

export const SourceCode = memo(function SourceCode({ text, path, selectedLine }: { text: string; path: string; selectedLine?: number }) {
  const lines = useMemo(() => highlightedLines(text, fileLanguage(path)), [text, path])
  return <pre className="cw-preview-source"><code className="cw-syntax">{lines.map((line, index) => <span key={index} data-line={index + 1}
    data-selected={selectedLine === index + 1 || undefined}><small aria-hidden="true">{index + 1}</small>{line.length ? line : ' '}</span>)}</code></pre>
})
