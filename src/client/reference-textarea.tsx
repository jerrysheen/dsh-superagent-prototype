import { useEffect, useId, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type { FolderReference } from '../app/folder-references.ts'

export function ReferenceTextarea({ value, onChange, disabled, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string; onChange(value: string): void
}) {
  const textarea = useRef<HTMLTextAreaElement>(null), id = useId()
  const [caret, setCaret] = useState(0), [dismissed, setDismissed] = useState(''), [items, setItems] = useState<FolderReference[]>([])
  const [selected, setSelected] = useState(0), [error, setError] = useState('')
  const match = /(?:^|\s)@(?:"([^"\r\n]*)|([^\s@"]*))$/.exec(value.slice(0, caret))
  const token = match ? value.slice(0, caret).lastIndexOf('@') : -1
  const query = match ? match[1] ?? match[2] ?? '' : undefined
  const active = !disabled && query !== undefined && dismissed !== value + ':' + caret
  useEffect(() => {
    const controller = new AbortController()
    setItems([]); setError(''); setSelected(0)
    if (active) void fetch('/session-hub/api/context/folders?' + new URLSearchParams({ query: query! }), {
      headers: { 'x-orchestrator-request': '1' }, signal: controller.signal,
    }).then(async response => { const result = await response.json(); if (!response.ok) throw Error(result.error ?? '文件夹查询失败'); if (!controller.signal.aborted) setItems(result.items) })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '文件夹查询失败') })
    return () => controller.abort()
  }, [active, query])
  function pick(item: FolderReference) {
    const mention = '@' + JSON.stringify(item.workspace.replace(/\\/g, '/') + '/') + ' '
    const next = value.slice(0, token) + mention + value.slice(caret), position = token + mention.length
    onChange(next); setCaret(position); setDismissed(next + ':' + position)
    queueMicrotask(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(position, position) })
  }
  return <div className="cw-reference-input">
    <textarea {...props} ref={textarea} role="combobox" aria-autocomplete="list" value={value} disabled={disabled} aria-controls={active && items.length ? id : undefined}
      aria-expanded={active && items.length > 0} aria-activedescendant={active && items.length ? id + '-' + selected : undefined}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart) }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onKeyDown={event => {
        if (active && event.key === 'Escape') { event.preventDefault(); setDismissed(value + ':' + caret) }
        else if (active && items.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Enter') pick(items[selected]!)
          else setSelected(previous => (previous + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        }
        props.onKeyDown?.(event)
      }} />
    {active && items.length > 0 && <div id={id} role="listbox" aria-label="工程文件夹引用">{items.map((item, index) =>
      <button type="button" role="option" aria-selected={index === selected} id={id + '-' + index} key={item.uid}
        onMouseDown={event => event.preventDefault()} onClick={() => pick(item)}>{item.title}<small>{item.workspace}</small></button>)}</div>}
    {active && error && <p role="alert">{error}</p>}
  </div>
}
