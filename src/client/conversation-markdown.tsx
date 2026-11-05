import { memo, useId, useMemo, useRef } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fileLink, previewTarget } from './workspace-link.ts'
import { SyntaxCode } from './syntax-highlight.tsx'
import { ConversationImage } from './conversation-image.tsx'

const plugins = [remarkGfm]
const slug = (text: string) => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')
function nodeText(node: { value?: string; children?: unknown[] }): string {
  return node.value ?? node.children?.map(child => nodeText(child as Parameters<typeof nodeText>[0])).join('') ?? ''
}

/** Shared by historical replies and newly received desktop replies. */
export const ConversationMarkdown = memo(function ConversationMarkdown({ text, onLink }: { text: string; onLink?: (href: string) => void }) {
  const scope = useId(), root = useRef<HTMLDivElement>(null)
  const components = useMemo<Components>(() => {
    const result: Components = {
      img: ({ src, alt }) => src ? <ConversationImage src={src} alt={alt} /> : <span>图片不可用</span>,
      pre: ({ node, children, ...props }) => {
        const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
        if (!code || code.type !== 'element') return <pre {...props}>{children}</pre>
        const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : []
        const language = classes.find(value => value.startsWith('language-'))?.slice(9)
        return <pre {...props}><SyntaxCode text={nodeText(code)} language={language} className={classes.join(' ')} /></pre>
      },
      a: ({ node: _node, href, ...props }) => <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer"
        onClick={event => {
          if (!href || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
          if (href.startsWith('#')) {
            event.preventDefault()
            let fragment = href.slice(1)
            try { fragment = decodeURIComponent(fragment) } catch { /* use literal fragment */ }
            const heading = [...root.current?.querySelectorAll<HTMLElement>('[data-heading]') ?? []].find(node => node.dataset.heading === fragment)
            heading?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          } else if (onLink && previewTarget(href)) { event.preventDefault(); onLink(href) }
        }} />,
      table: ({ node: _node, ...props }) => <div className="cw-markdown-table"><table {...props} /></div>,
    }
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const Heading = tag
      result[tag] = ({ node, ...props }) => <Heading {...props} id={scope + '-' + node?.position?.start.offset}
        data-heading={node ? slug(nodeText(node)) : undefined} data-source-line={node?.position?.start.line} />
    }
    return result
  }, [onLink, scope])
  return <div className="cw-markdown" ref={root}><ReactMarkdown remarkPlugins={plugins} components={components} skipHtml
    urlTransform={(url, key) => key === 'href' && onLink && (fileLink(url) || /^codex:\/\/threads\/[a-f\d-]{36}$/i.test(url)) ? url : defaultUrlTransform(url)}>{text}</ReactMarkdown></div>
})
