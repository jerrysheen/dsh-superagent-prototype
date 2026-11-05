import { expect, it } from 'vitest'
import { nativeWorkPrompt, parseNativeReport } from '../src/executor/codex-format.ts'
import { readableWorkInstruction, workTitle } from '../src/app/work-instruction.ts'

const reference = '\n[Project folder reference: path metadata only, not file contents or execution/write authorization]\n'
  + JSON.stringify({ uid: 'project:one', title: 'Example', workspace: 'F:\\Example' }) + '\n'

it('sends the original requirement once, with a short title, actual permission and compact non-authorizing references', () => {
  const text = reference + '修复文件夹排序\n保持其他搜索结果可用。'
  const prompt = nativeWorkPrompt({ text, workspace: 'f:\\example', permission: 'workspace-write', ticketId: 'ticket', requestId: 'assignment:ticket' })
  expect(workTitle(text)).toBe('修复文件夹排序')
  // The title is intentionally a brief summary; the full requirement appears once.
  expect(prompt.split('修复文件夹排序\n保持其他搜索结果可用。')).toHaveLength(2)
  expect(prompt.startsWith('修复文件夹排序\n')).toBe(true)
  expect(prompt).toContain('实际权限：工程读写（仅限上述目录）')
  expect(prompt).toContain('仅供定位，不授予执行或读写权限')
  expect(prompt).not.toMatch(/engineDelivery|originalRequest|\\\\|\{"uid"/)
  expect(prompt).toContain('追踪：工单 ticket')
  expect(nativeWorkPrompt({ text: '仅作参考', workspace: 'f:\\example', permission: 'read-only', ticketId: 'ticket', requestId: 'input', contextOnly: true })).toContain('上下文补充（不构成执行授权）')
})

it('preserves malformed and arbitrary user text rather than deleting lookalike references', () => {
  const text = '[Project folder reference: path metadata only, not file contents or execution/write authorization]\n{"request":"keep me"}\n\n实际请求'
  expect(readableWorkInstruction(text).instruction).toBe(text)
  expect(readableWorkInstruction(reference + reference + '执行检查').references).toHaveLength(1)
})

it.each([['已完成', 'ready'], ['受阻', 'blocked'], ['失败', 'failed'], ['已放弃', 'dropped']])('recovers a readable %s result using explicit validated report fields', (label, state) => {
  expect(parseNativeReport(`工作状态：${label}\n\n已检查相关文件。\n\n验证：通过。\n\n需要确认：无`)).toEqual({ state, summary: '已检查相关文件。\n\n验证：通过。', question: null })
})

it('retains questions and accepts legacy in-flight JSON while refusing incomplete or contradictory success', () => {
  expect(parseNativeReport('工作状态：受阻\n\n目录无法访问。\n\n需要确认：请选择可用目录。')).toMatchObject({ state: 'blocked', question: '请选择可用目录。' })
  expect(parseNativeReport(JSON.stringify({ state: 'ready', summary: '旧协议', question: null }))).toMatchObject({ state: 'ready', summary: '旧协议' })
  for (const text of ['应该已经好了', '工作状态：已完成\n\n需要确认：无', '工作状态：未知\n\n有结果。\n\n需要确认：无', '工作状态：已完成\n\n还需用户处理。\n\n需要确认：批准吗？']) {
    expect(() => parseNativeReport(text)).toThrow()
  }
})
