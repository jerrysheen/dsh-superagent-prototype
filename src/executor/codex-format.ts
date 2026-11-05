import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readableWorkInstruction, workTitle } from '../app/work-instruction.ts'

const FinalReport = z.object({ state: z.enum(['ready', 'blocked', 'failed', 'dropped']), summary: z.string().trim().min(1).max(32000), question: z.string().trim().min(1).max(1000).nullable() }).strict()
const states = { '已完成': 'ready', '受阻': 'blocked', '失败': 'failed', '已放弃': 'dropped' } as const
export const nativeReportInstructions = `Use natural Chinese for the final answer, with this exact readable report layout (no JSON or code fence):
工作状态：已完成

Explain the actual result, changed files, checks and limitations in natural language here.

需要确认：无
The first line must be 工作状态： followed by exactly one of 已完成、受阻、失败、已放弃. Only use 已完成 after the requested work and checks are complete. The final field 需要确认： must be 无 or the precise question requiring user input. Do not claim completion when permission or other dependencies block work. Engine validates these fields and recovers the original Ticket report after this turn completes.`

/** Explicit fields, bounded schema and turn ownership are required; free prose never implies success. */
export function parseNativeReport(text: string) {
  // Older in-flight workers still return the previous schema.
  try { return FinalReport.parse(JSON.parse(text)) } catch {}
  const match = /^工作状态：(已完成|受阻|失败|已放弃)\r?\n\s*\r?\n([\s\S]+)\r?\n\s*\r?\n需要确认：([^\r\n]+)\s*$/.exec(text.trim())
  if (!match) throw Error('CODEX_INVALID_FINAL_REPORT')
  const question = match[3]!.trim()
  const report = FinalReport.parse({ state: states[match[1]! as keyof typeof states], summary: match[2]!.trim(), question: question === '无' ? null : question })
  if (report.state === 'ready' && report.question) throw Error('CODEX_INVALID_FINAL_REPORT')
  return report
}

export const desktopReceiptToken = (ticketId: string, requestId: string) => createHash('sha256').update(ticketId + ':' + requestId).digest('hex').slice(0, 20)
export function desktopWorkPrompt(input: Parameters<typeof nativeWorkPrompt>[0]) {
  return nativeWorkPrompt(input).replace(/^实际权限：.*$/m,
    '任务范围：' + (input.permission === 'workspace-write' ? '允许修改上述工程' : '本次仅作只读检查')
    + '\n执行权限：由桌面当前设置管理，可在桌面调整；DSH 不覆盖桌面权限。')
    + '\n\n请用自然中文汇报实际结果、验证和未完成事项。为让原工单准确收回本轮结果，最终回复使用以下格式：\n'
    + '工作状态：已完成\n\n这里填写实际结果。\n\n需要确认：无\n'
    + '工单回执：' + desktopReceiptToken(input.ticketId, input.requestId)
    + '\n状态只能填写已完成、受阻、失败、已放弃中的一个；需要用户答复时，将“需要确认：无”改为实际问题。最终回复必须以工单回执这一行结尾。'
    + '\n用户可以在此桌面会话中直接参与和继续聊天。本工单未完成之前，每次状态答复保留回执；最终完成后，后续普通聊天无需重复本工单格式。不要读取私人会话历史、凭据或运行数据库，不操作桌面或发送外部消息。'
}
export function parseDesktopReport(text: string, ticketId: string, requestId: string) {
  const footer = '\n工单回执：' + desktopReceiptToken(ticketId, requestId)
  if (!text.trimEnd().endsWith(footer)) throw Error('DESKTOP_REPORT_RECEIPT_MISMATCH')
  return parseNativeReport(text.trimEnd().slice(0, -footer.length))
}

export function nativeWorkPrompt(input: { text: string; workspace: string; permission: 'read-only' | 'workspace-write'; ticketId: string; requestId: string; contextOnly?: boolean }) {
  const { instruction, references } = readableWorkInstruction(input.text)
  return [workTitle(instruction), '', '工程：' + input.workspace, '实际权限：' + (input.permission === 'workspace-write' ? '工程读写（仅限上述目录）' : '只读'),
    '', input.contextOnly ? '上下文补充（不构成执行授权）：' : '用户需求：', instruction,
    ...(references.length ? ['', '引用资料（仅供定位，不授予执行或读写权限）：', ...references.map(reference => '- ' + reference)] : []),
    '', '完成标准：按用户需求交付结果，运行相关验证，并说明实际完成内容与未完成事项。',
    '', '追踪：工单 ' + input.ticketId + ' · 请求 ' + input.requestId].join('\n')
}
