import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConversationMedia } from '../src/app/conversation-media.ts'
it('serves only a selected-message raster capability scoped to its native thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-media-')), path = join(root, 'picture.png')
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  try {
    await writeFile(path, bytes); const media = new ConversationMedia(), src = media.register('thread', path, root)!
    const id = new URL(src, 'http://localhost').searchParams.get('id')!
    expect(await media.read('thread', id)).toMatchObject({ type: 'image/png', bytes })
    await expect(media.read('another-thread', id)).rejects.toThrow(/不属于/)
    await writeFile(path, 'not an image'); await expect(media.read('thread', id)).rejects.toThrow(/不是/)
    expect(media.register('thread', join(root, 'secret.txt'), root)).toBeUndefined()
    expect(media.register('thread', 'javascript:alert(1)', root)).toBeUndefined()
  } finally { if (!resolve(root).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }) }
})
it('validates uploaded image bytes and binds upload IDs to the selected native session', async () => {
  const media = new ConversationMedia(), png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  const image = await media.upload('session-a', png, tmpdir()), path = media.uploads('session-a', [image.id])[0]!
  try {
    expect(image.src).toContain('threadId=session-a')
    expect((await media.read('session-a', image.id)).type).toBe('image/png')
    expect(() => media.uploads('session-b', [image.id])).toThrow(/不属于/)
    await expect(media.upload('session-a', 'data:image/png;base64,aGVsbG8=', tmpdir())).rejects.toThrow(/格式/)
  } finally { if (!resolve(path).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe upload cleanup'); await unlink(path) }
})
