import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { z } from 'zod'

function pngChunk(type: string, data: Buffer) {
  const label = Buffer.from(type), bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); label.copy(bytes, 4); data.copy(bytes, 8)
  let checksum = 0xffffffff
  for (const byte of Buffer.concat([label, data])) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, 8 + data.length)
  return bytes
}

export async function probeVision(ctx: Pick<Context, 'llm'> & { attachments?: Context['attachments'] }, input: unknown) {
  const { confirmed } = z.object({ confirmed: z.literal(true) }).strict().parse(input)
  const provider = 'openai', model = 'gpt-6-luna', signal = AbortSignal.timeout(90000)
  const info = await ctx.llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw Error('Luna 当前有效配置未声明 image 输入；未调用模型。')
  if (!ctx.attachments) throw Error('当前运行实例未加载图片附件服务；未调用模型。')
  const expected = randomInt(2) ? 'RED' : 'BLUE', header = Buffer.alloc(13), pixels = Buffer.alloc(32 * 129)
  header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6
  for (let row = 0; row < 32; row++) for (let column = 0; column < 32; column++) {
    const offset = row * 129 + 1 + column * 4
    pixels[offset + (expected === 'RED' ? 0 : 2)] = 255; pixels[offset + 3] = 255
  }
  const data = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))])
  const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'synthetic-vision-probe.png' })
  let answer = '', completed = false
  for await (const chunk of ctx.llm.stream({ provider, model, system: 'Inspect the attached image. Reply only with the dominant color in uppercase English. Do not use tools.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the dominant color of this image?' }, { type: 'image', attachment }] }],
    tools: [], maxTokens: 2048, signal })) {
    if (chunk.type === 'text-delta') { answer += chunk.text; if (answer.length > 1000) throw Error('Vision probe output limit') }
    if (chunk.type === 'finish') { if (chunk.reason.kind !== 'stop') throw Error('Vision probe did not complete successfully'); completed = true }
    if (chunk.type === 'tool-call-delta') throw Error('Vision probe attempted a tool call')
  }
  signal.throwIfAborted()
  if (!completed) throw Error('Vision probe stream ended without completion')
  return { status: answer.trim() === expected ? 'passed' : 'failed', provider, model, confirmed, completed, inputModalities: info.inputModalities,
    expected, answer: answer.trim(), noUserSessionTouched: true }
}
