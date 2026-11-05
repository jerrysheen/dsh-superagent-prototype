import { expect, it, vi } from 'vitest'
import { probeVision } from '../src/app/vision-probe.ts'

function fixture(modalities = ['text', 'image'], finish = true) {
  const saveImage = vi.fn(async (_input: { data: Buffer; mediaType: string }) => ({ id: 'synthetic-image' }))
  const stream = vi.fn(async function* (request) {
    expect(request.messages[0].content[1]).toEqual({ type: 'image', attachment: { id: 'synthetic-image' } })
    expect(request.tools).toEqual([])
    yield { type: 'text-delta', text: 'RED' }
    if (finish) yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const host = { llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: modalities })), stream }, attachments: { saveImage } }
  return { host: host as never, stream, saveImage }
}
it('requires explicit confirmation and rejects text-only metadata before inference', async () => {
  const { host, stream, saveImage } = fixture(['text'])
  await expect(probeVision(host, {})).rejects.toThrow()
  await expect(probeVision(host, { confirmed: true })).rejects.toThrow('未声明 image')
  expect(stream).not.toHaveBeenCalled(); expect(saveImage).not.toHaveBeenCalled()
})
it('sends actual image content with no tools or private session reads', async () => {
  const { host, stream, saveImage } = fixture()
  const result = await probeVision(host, { confirmed: true })
  expect(result).toMatchObject({ model: 'gpt-6-luna', completed: true, noUserSessionTouched: true })
  expect(result.status).toBe(result.expected === 'RED' ? 'passed' : 'failed')
  expect(saveImage.mock.calls[0]?.[0]).toMatchObject({ mediaType: 'image/png' })
  expect(stream).toHaveBeenCalledTimes(1)
})
it('never treats an interrupted stream as a completed test', async () => {
  const { host } = fixture(['text', 'image'], false)
  await expect(probeVision(host, { confirmed: true })).rejects.toThrow('without completion')
})
