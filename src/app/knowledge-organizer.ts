/** Local-only extraction. Incoming conversation text is evidence, never executable instructions. */
import { createHash } from 'node:crypto'
import type { CodexTranscript, TranscriptMessage } from './codex-transcript.ts'
import { classifyKnowledge } from './knowledge-taxonomy.ts'

export interface LibraryThread {
  threadId: string; title: string; cwd: string; projectName: string; updatedAt: number; archived: boolean; sourceKind: string
  kind: 'discussion' | 'review' | 'test' | 'digest'
  scan: { state: 'pending' | 'complete' | 'partial' | 'failed'; pages: number; turns: number; truncated: boolean; cursor?: string; failure?: string }
}
export interface LibraryEntry {
  id: string; threadId: string; turnId: string; questionMessageIds: string[]; answerMessageIds: string[]
  question: string; answer: string; startedAt: number; answered: boolean; truncated: boolean
  topics: { id: string; score: number; basis: 'question-answer' | 'conversation-title' }[]
  method: 'local-condensation' | 'model-extraction'; review: 'source-not-verified'
  evidence?: { provider: 'codex' | 'chatgpt'; turnIds: string[]; needsReview: boolean; answerState?: 'historical_answer' | 'proposal' | 'open_question' | 'failed_attempt' | 'insufficient_evidence' }
}
export interface LibraryInsight { id: string; topicId: string; title: string; summary: string; entryIds: string[]; status: 'historical-summary' }
export interface KnowledgeLibrary {
  version: 1; taxonomyVersion: 1 | 2; builtAt: string; inventoryAt: string
  status: 'processing' | 'ready' | 'partial'; threads: LibraryThread[]; entries: LibraryEntry[]; insights: LibraryInsight[]
  policy: { rawTranscriptsPersisted: false; modelCalls: boolean; agentIntegration: boolean }
}

export function safeKnowledgeText(text: string): string {
  return text.replace(/sk-(?:proj-|ant-)?[a-z0-9_-]{12,}/gi, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|ACCESS_TOKEN|PASSWORD|SECRET)\b\s*[=:]\s*[^\s,;]+/gi, '[已隐藏认证字段]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏认证]@')
    .replace(/([?&](?:token|api[_-]?key|access[_-]?token|auth|password)=)[^\s&#)]+/gi, '$1[已隐藏]')
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=]+/gi, '[媒体附件]')
    .replace(/[A-Za-z0-9+/=_-]{160,}/g, '[长编码内容]')
}

export function conversationBody(text: string): string {
  let value = text.replace(/<(environment_context|INSTRUCTIONS|permissions[^>]*|system_reminder|external_codex_apps_open_page|image|attachment)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' [代码或数据片段] ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' [图片附件] ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  if (value.includes('## My request:')) value = value.split('## My request:').slice(1).join(' ')
  if (/^\s*# AGENTS\.md instructions\b/i.test(value) || /^\s*<environment_context>/.test(value)) return ''
  return safeKnowledgeText(value).replace(/<[^>]+>/g, ' ').replace(/^\s*[#>*-]+\s*/gm, '').replace(/\s+/g, ' ').trim()
}

function condense(text: string, max: number, answer: boolean): string {
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g) ?? [text]
  const selected = sentences.map((value, index) => ({ value: value.trim(), index,
    score: (index === 0 ? 4 : 0) + (index === sentences.length - 1 ? 1 : 0)
      + (answer && /原因|结果|结论|修复|通过|失败|尚未|建议|因为|需要|确认|验证|风险|限制|不能|root cause|fixed|result/i.test(value) ? 3 : 0) }))
    .filter(item => item.value).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, answer ? 4 : 2).sort((a, b) => a.index - b.index)
  const result = selected.map(item => item.value).join(' ')
  return result.length > max ? result.slice(0, max - 1) + '…' : result
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
export function recordKind(title: string, sourceKind: string): LibraryThread['kind'] {
  if (/每日.*总结|daily.*digest|昨日学习/i.test(title)) return 'digest'
  if (/^subAgent/i.test(sourceKind) || /^(review\b|guardian review|子任务|审查.*(?:规格|合规|质量))/i.test(title)) return 'review'
  if (/^(hello world|test$|测试.*(?:接口|连通)|.*最小连通性|.*多轮接续测试)/i.test(title)) return 'test'
  return 'discussion'
}

export function extractKnowledgeEntries(thread: Pick<LibraryThread, 'threadId' | 'title'>, page: CodexTranscript): LibraryEntry[] {
  if (thread.threadId !== page.threadId) throw Error('Knowledge thread mismatch')
  const result: LibraryEntry[] = []
  for (const turn of page.turns) {
    let questions: TranscriptMessage[] = [], answers: TranscriptMessage[] = []
    const flush = () => {
      if (!questions.length) { answers = []; return }
      const questionText = questions.map(message => conversationBody(message.text)).filter(Boolean).join(' ')
      const answerText = answers.map(message => conversationBody(message.text)).filter(Boolean).join(' ')
      if (!questionText) { questions = []; answers = []; return }
      const question = condense(questionText, 240, false), answer = condense(answerText, 420, true)
      result.push({ id: hash(thread.threadId + ':' + turn.id + ':' + questions.map(message => message.id).join(',')), threadId: thread.threadId,
        turnId: turn.id, questionMessageIds: questions.map(message => message.id), answerMessageIds: answers.map(message => message.id),
        question, answer, startedAt: turn.startedAt, answered: !!answerText, truncated: [...questions, ...answers].some(message => message.truncated),
        topics: classifyKnowledge(questionText, answerText, thread.title), method: 'local-condensation', review: 'source-not-verified' })
      questions = []; answers = []
    }
    for (const message of turn.messages) {
      if (message.role === 'user') { if (answers.length) flush(); if (conversationBody(message.text)) questions.push(message) }
      else answers.push(message)
    }
    flush()
  }
  return result
}
