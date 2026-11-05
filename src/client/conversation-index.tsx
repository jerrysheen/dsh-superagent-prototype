import { useEffect, useState, type RefObject } from 'react'

export function ConversationIndex({ items, container }: { items: { id: string; label: string }[]; container: RefObject<HTMLDivElement> }) {
  const [active, setActive] = useState('')
  const ids = items.map(item => item.id).join('\n')
  useEffect(() => {
    const root = container.current
    if (!root) return
    const update = () => {
      const top = root.getBoundingClientRect().top + 80
      const sections = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')]
      let current = sections[0]?.dataset.turnId ?? ''
      for (const section of sections) {
        if (section.getBoundingClientRect().top > top) break
        current = section.dataset.turnId ?? current
      }
      if (root.scrollHeight > root.clientHeight && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = sections.at(-1)?.dataset.turnId ?? current
      setActive(current)
    }
    update(); root.addEventListener('scroll', update, { passive: true })
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    resize?.observe(root)
    return () => { root.removeEventListener('scroll', update); resize?.disconnect() }
  }, [container, ids])
  if (!items.length) return null
  return <nav className="cw-conversation-index" aria-label="会话消息导航">{items.map((item, index) =>
    <button key={item.id} type="button" title={item.label} aria-label={'跳到第 ' + (index + 1) + ' 轮：' + item.label}
      aria-current={active === item.id ? 'location' : undefined} onClick={() => {
        const section = [...container.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? []].find(node => node.dataset.turnId === item.id)
        section?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(item.id)
      }}><span aria-hidden="true" /><span className="cw-index-tooltip">{index + 1}. {item.label}</span></button>)}</nav>
}
