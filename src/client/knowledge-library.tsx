import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeLibraryReader } from '../app/knowledge-library.ts'
import type { KnowledgeNode } from '../app/knowledge-graph.ts'
import { Button, Input } from './controls.tsx'
import STYLES from './knowledge-library.css?raw'

type Overview = ReturnType<KnowledgeLibraryReader['overview']>
type Entries = ReturnType<KnowledgeLibraryReader['entries']>
type Threads = ReturnType<KnowledgeLibraryReader['threads']>
type Entry = Entries['entries'][number]
type Source = { threadId: string; turnId: string; answerAvailable: boolean; messages: { id: string; role: 'user' | 'assistant'; text: string }[] }
const kinds = { discussion: '主讨论', review: '子任务与审查', test: '测试记录', digest: '每日总结' }
const answerStates = { historical_answer: '历史答复', proposal: '方案待验证', open_question: '开放问题', failed_attempt: '失败尝试', insufficient_evidence: '证据不足' }
const scans = { pending: '待读取', complete: '已遍历', partial: '部分读取', failed: '读取失败' }
async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch('/session-hub/api/knowledge-library' + path, { headers: { 'x-orchestrator-request': '1' }, signal })
  const value = await r.json()
  if (!r.ok) throw Error(value.error ?? '知识入口暂不可用。')
  return value as T
}

export function KnowledgeLibraryWindow({ onOpenThread }: { onOpenThread?: (thread: KnowledgeNode) => void }) {
  const [data, setData] = useState<Overview>(), [error, setError] = useState('')
  const [view, setView] = useState<'knowledge' | 'directory' | 'pending'>('knowledge')
  const [topic, setTopic] = useState(''), [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [kind, setKind] = useState('discussion'), [thread, setThread] = useState(''), [insight, setInsight] = useState(''), [offset, setOffset] = useState(0)
  const [entries, setEntries] = useState<Entries>(), [threads, setThreads] = useState<Threads>(), [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Entry>(), [source, setSource] = useState<Source>(), [sourceError, setSourceError] = useState('')
  const [readSource, setReadSource] = useState(false), [sourceLoading, setSourceLoading] = useState(false)
  useEffect(() => { const c = new AbortController(); void get<Overview>('', c.signal).then(setData, e => { if (!c.signal.aborted) setError(e.message) }); return () => c.abort() }, [])
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setOffset(0) }, 180); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (!data?.available) return
    const c = new AbortController(); setLoading(true); setError(''); setEntries(undefined); setThreads(undefined)
    const params = new URLSearchParams({ topic: view === 'directory' ? '' : topic, q: search, kind, thread, insight, offset: String(offset), limit: '25', pending: view === 'pending' ? 'true' : 'false' })
    const p = view === 'directory' ? get<Threads>('/threads?' + params, c.signal).then(setThreads) : get<Entries>('/entries?' + params, c.signal).then(setEntries)
    void p.catch(e => { if (!c.signal.aborted) setError(e.message) }).finally(() => { if (!c.signal.aborted) setLoading(false) })
    return () => c.abort()
  }, [data, view, topic, search, kind, thread, insight, offset])
  useEffect(() => { setSource(undefined); setReadSource(false); setSourceError(''); setSourceLoading(false) }, [selected?.id])
  useEffect(() => {
    if (!readSource || !selected) return
    const c = new AbortController(); setSourceLoading(true)
    void get<Source>('/source?' + new URLSearchParams({ id: selected.id }), c.signal).then(value => { if (!c.signal.aborted) setSource(value) }, e => { if (!c.signal.aborted) setSourceError(e.message) })
      .finally(() => { if (!c.signal.aborted) setSourceLoading(false) })
    return () => c.abort()
  }, [readSource, selected?.id])
  const topics = useMemo(() => data?.domains.flatMap(d => d.topics) ?? [], [data])
  const current = topics.find(t => t.id === topic), page = view === 'directory' ? threads : entries
  function reset() { setThread(''); setInsight(''); setOffset(0); setSelected(undefined) }
  function selectTopic(id: string) { reset(); setTopic(id); setView('knowledge') }
  function selectView(value: typeof view) { reset(); setTopic(''); setView(value); setKind(value === 'knowledge' ? 'discussion' : 'all') }
  return <section className="kl-window" aria-label="知识入口"><style>{STYLES}</style>
    <header className="kl-heading"><div><span className="kl-eyebrow">知识库 · 本地与云端</span><h1>把讨论串成知识主线</h1><p>从专题找到问题、历史答复和原始来源。</p></div>
      {data && <div className="kl-counts"><strong>{data.stats.threads.toLocaleString()}<small>会话</small></strong><strong>{data.stats.pairs.toLocaleString()}<small>问答</small></strong><strong>{topics.filter(t => t.pairs).length}<small>专题簇</small></strong></div>}</header>
    <div className="kl-toolbar"><nav aria-label="知识入口视图">{([['knowledge','知识概览'],['directory','历史目录'],['pending','待整理']] as const).map(([id,label]) => <Button size="sm" key={id} aria-pressed={view === id} onClick={() => selectView(id)}>{label}</Button>)}</nav>
      <Input aria-label="搜索知识与历史问答" placeholder="搜索专题、问题、答复或工程…" value={query} onChange={e => { setQuery(e.target.value); setInsight('') }} />
      <select aria-label="记录类型" value={kind} onChange={e => { setKind(e.target.value); setOffset(0); setSelected(undefined) }}><option value="all">全部记录</option>{Object.entries(kinds).map(([id,label]) => <option value={id} key={id}>{label}</option>)}</select></div>
    {error && <p role="alert" className="kl-error">{error}</p>}{!data && !error && <p role="status" className="kl-empty">正在读取知识目录…</p>}
    {data && !data.available && <div className="kl-empty"><h2>知识入口已就绪，等待本地整理结果</h2><p>{data.error || '整理后可在这里浏览专题、问答与历史来源。'}</p></div>}
    {data?.available && <div className="kl-body"><aside className="kl-navigation" aria-label="知识主线"><button type="button" className={!topic ? 'kl-active' : ''} onClick={() => selectTopic('')}>全部知识主线<span>{data.domains.length}</span></button>
      {data.domains.map(d => <details key={d.id} open={d.topics.some(t => t.id === topic)}><summary>{d.name}</summary>{d.topics.map(t => <button type="button" key={t.id} className={topic === t.id ? 'kl-active' : ''} onClick={() => selectTopic(t.id)}>{t.name}<span>{t.pairs}</span></button>)}</details>)}
      <div className="kl-coverage"><strong>整理覆盖</strong><p>{data.stats.complete} / {data.stats.threads} 条会话已遍历</p><p>{data.stats.incomplete} 条未读完 · {data.stats.truncated} 条含截断内容</p><p>{data.stats.noReadablePairs} 条暂无可读问答 · {data.stats.unassigned} 条问答待归类</p><small>问答为压缩摘要；历史答复中的完成声明尚未单独验收。</small></div></aside>
      <main className="kl-main">{view === 'knowledge' && !topic && !search && !thread && <div className="kl-domains">{data.domains.map((d,i) => <section key={d.id}><span className="kl-domain-number">{String(i+1).padStart(2,'0')}</span><div><h2>{d.name}</h2><p>{d.summary}</p><div className="kl-topic-links">{d.topics.map(t => <button type="button" key={t.id} onClick={() => selectTopic(t.id)}>{t.name}<span>{t.pairs}</span></button>)}</div></div></section>)}</div>}
        {current && <header className="kl-topic-heading"><span className="kl-eyebrow">专题簇</span><h2>{current.name}</h2><p>{current.summary}</p><div className="kl-related"><span>相关专题</span>{current.related.map(id => { const other = topics.find(t => t.id === id); return other && <button type="button" key={id} onClick={() => selectTopic(id)}>{other.name} ↗</button> })}</div>
          {current.insights.map(item => <article className="kl-insight" key={item.id}><small>历史归纳 · 结果未单独验收</small><h3>{item.title}</h3><p>{item.summary}</p><Button size="sm" onClick={() => { setInsight(item.id); setThread(''); setKind('all'); setQuery(''); setSearch(''); setOffset(0); setSelected(undefined) }}>回查 {item.entryIds.length} 条支撑问答 ↗</Button></article>)}</header>}
        {view === 'pending' && <div className="kl-topic-heading"><h2>待整理与证据缺口</h2><p>保留未归类、缺少答复、内容截断或尚未读完的问答。没有可读问答的会话仍在历史目录中保留。</p><Button size="sm" onClick={() => selectView('directory')}>查看完整历史目录 ↗</Button></div>}
        {(view !== 'knowledge' || topic || search || thread) && <section className="kl-results" aria-label={view === 'directory' ? '历史会话列表' : '专题问答列表'}><header><h2>{view === 'directory' ? '历史会话' : '问题与历史答复'}</h2><span>{page?.total ?? '…'} 条</span>{insight && <Button size="sm" onClick={() => { setInsight(''); setOffset(0) }}>查看专题全部问答</Button>}{thread && <Button size="sm" onClick={() => { setThread(''); setOffset(0) }}>取消会话筛选</Button>}</header>
          {loading && <p role="status">读取中…</p>}{!loading && page?.total === 0 && <p className="kl-empty">当前范围暂无记录，可以调整搜索或记录类型。</p>}
          {view === 'directory' ? threads?.threads.map(t => <article className="kl-thread" key={t.threadId}><div><h3>{t.title}</h3><p>{t.projectName} · {kinds[t.kind]} · {t.sourceKind === 'chatgpt' ? 'ChatGPT 云端' : 'Codex 本地'} · {scans[t.scan.state]} · {t.pairs} 条问答{t.archived && ' · 已归档'}</p></div><Button size="sm" onClick={() => { reset(); setThread(t.threadId); setView('knowledge'); setTopic('') }}>浏览问答</Button><a href={t.sourceKind === 'chatgpt' ? 'https://chatgpt.com/c/'+t.threadId : 'codex://threads/'+t.threadId}>原会话 ↗</a></article>) : entries?.entries.map(e => <article className="kl-entry" key={e.id}>
            <div className="kl-entry-meta"><span>{e.thread.projectName} · {e.evidence?.provider === 'chatgpt' ? 'ChatGPT 云端' : 'Codex 本地'} · {kinds[e.thread.kind]}</span><span>{e.startedAt ? new Date(e.startedAt).toLocaleDateString('zh-CN') : '时间未知'}</span></div><button type="button" className="kl-question" onClick={() => setSelected(e)}>{e.question}</button><p>{e.answer || '此处尚未读到对应答复，不能推定已有结论。'}</p><div className="kl-entry-bottom"><div>{e.topics.map(t => <button type="button" key={t.id} onClick={() => selectTopic(t.id)}>{topics.find(item => item.id === t.id)?.name}</button>)}{!e.topics.length && <span>待归类</span>}{e.evidence?.answerState && <span>{answerStates[e.evidence.answerState]}</span>}{e.truncated && <span>内容有截断</span>}</div><Button size="sm" onClick={() => setSelected(e)}>问答与来源 ↗</Button></div></article>)}
          {page && page.total > 25 && <div className="kl-pagination"><Button size="sm" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-25))}>上一页</Button><span>{Math.floor(offset/25)+1} / {Math.ceil(page.total/25)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset ?? offset)}>下一页</Button></div>}</section>}
      </main>{selected && <aside className="kl-inspector" aria-label="问答来源详情"><header><h2>问答与来源</h2><Button size="sm" aria-label="关闭问答来源" onClick={() => setSelected(undefined)}>×</Button></header><h3>{selected.question}</h3><p>{selected.answer || '未读到答复。'}</p><small>历史答复摘要 · 执行结果未经本次验收</small><dl><dt>来源会话</dt><dd>{selected.thread.title}</dd><dt>工程</dt><dd>{selected.thread.cwd}</dd><dt>轮次</dt><dd>{selected.evidence?.turnIds.join('、') || selected.turnId}</dd><dt>归类依据</dt><dd>{selected.topics.some(t => t.basis === 'question-answer') ? '当前问答内容，待语义复核' : '会话标题上下文，待复核'}</dd></dl>
        <div className="kl-source-actions"><Button size="sm" disabled={readSource || selected.method === 'model-extraction'} onClick={() => setReadSource(true)}>读取这一轮原文</Button>{onOpenThread && selected.evidence?.provider !== 'chatgpt' && <Button size="sm" onClick={() => onOpenThread({ ...selected.thread, provider: 'codex', messages: selected.thread.scan.turns, partial: selected.thread.scan.state !== 'complete' || selected.thread.scan.truncated })}>在工作区打开</Button>}<a href={selected.evidence?.provider === 'chatgpt' ? 'https://chatgpt.com/c/'+selected.threadId : 'codex://threads/'+selected.threadId}>打开原会话 ↗</a>{selected.method === 'model-extraction' && <small>提炼产物保留轮次引用，请在原会话核对。</small>}</div>
        {sourceLoading && <p role="status">读取对应轮次…</p>}{sourceError && <p role="alert">{sourceError}</p>}{source && <div className="kl-source">{source.messages.map(m => <section key={m.id}><h4>{m.role === 'user' ? '原始提问' : '原始答复'}</h4><pre>{m.text}</pre></section>)}{selected.answered && !source.answerAvailable && <p>原始答复当前不可用，不能用其他轮次替代。</p>}</div>}</aside>}
    </div>}
  </section>
}
