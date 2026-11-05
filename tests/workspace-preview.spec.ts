import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readWorkspacePreview } from '../src/app/workspace-preview.ts'
import { fileLink, previewTarget } from '../src/client/workspace-link.ts'

const directories: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'workspace-preview-')); directories.push(root); return root }
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('recognizes Windows/relative links and line suffixes without accepting executable or UNC links', () => {
  expect(fileLink('/F:/Project/docs/Guide.md:12')).toEqual({ kind: 'file', path: 'F:/Project/docs/Guide.md', line: 12 })
  expect(fileLink('file:///F:/Project/Guide%20One.md#L4')).toEqual({ kind: 'file', path: 'F:/Project/Guide One.md', line: 4 })
  expect(fileLink('./src/main.ts#L6-L10')).toEqual({ kind: 'file', path: './src/main.ts', line: 6 })
  expect(fileLink('guide.md#details')).toEqual({ kind: 'file', path: 'guide.md', anchor: 'details' })
  expect(fileLink('F:\\Project\\main.ts:7:2')?.line).toBe(7)
  for (const href of ['javascript:run.md', 'data:text/plain,a.md', 'file://server/share/a.md', '//server/a.md', '#title']) expect(fileLink(href)).toBeNull()
  expect(previewTarget('https://example.com/doc')).toEqual({ kind: 'web', url: 'https://example.com/doc' })
  expect(previewTarget('https://user:pass@example.com')).toBeNull()
})
it('reads only a requested bounded project text file and reports Markdown rendering capability', async () => {
  const root = fixture(); writeFileSync(join(root, 'guide.md'), '# Synthetic guide\n\nText')
  expect(await readWorkspacePreview(root, 'guide.md')).toMatchObject({ name: 'guide.md', markdown: true, text: '# Synthetic guide\n\nText' })
  await expect(readWorkspacePreview(root, '../outside.md')).rejects.toThrow('项目内')
  await expect(readWorkspacePreview(root, 'Z:/outside.md')).rejects.toThrow('项目内')
  await expect(readWorkspacePreview(root, '.local/state.json')).rejects.toThrow('不支持')
  await expect(readWorkspacePreview(root, 'credentials.json')).rejects.toThrow('不支持')
  await expect(readWorkspacePreview(root, 'guide.md:stream')).rejects.toThrow('项目内')
})
it('rejects binary/oversize files and junctions escaping the project', async () => {
  const root = fixture(), outside = fixture()
  writeFileSync(join(root, 'binary.txt'), Buffer.from([0, 1, 2]))
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 97))
  writeFileSync(join(outside, 'guide.md'), 'Synthetic outside fixture')
  symlinkSync(outside, join(root, 'linked'), 'junction')
  mkdirSync(join(root, 'folder.md'))
  await expect(readWorkspacePreview(root, 'binary.txt')).rejects.toThrow('普通文本')
  await expect(readWorkspacePreview(root, 'large.txt')).rejects.toThrow('512 KB')
  await expect(readWorkspacePreview(root, 'linked/guide.md')).rejects.toThrow('项目之外')
  await expect(readWorkspacePreview(root, 'folder.md')).rejects.toThrow('普通文本')
})
