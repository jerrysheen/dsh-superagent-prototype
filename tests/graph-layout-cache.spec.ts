import { expect, it } from 'vitest'
import { readLayoutCache, writeLayoutCache } from '../src/client/graph-layout-cache.ts'
const points = [{ id: 'a', x: 100, y: 200, radius: 2 }, { id: 'b', x: 300, y: 200, radius: 3 }]
it('restores saved coordinates only for the same topology, settings and complete node IDs', () => {
  let value: string | null = null
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
  writeLayoutCache('topology', {}, points, storage)
  expect(readLayoutCache('topology', {}, ['a', 'b'], storage)).toEqual(points)
  expect(readLayoutCache('changed', {}, ['a', 'b'], storage)).toBeNull()
  expect(readLayoutCache('topology', { charge: -80 }, ['a', 'b'], storage)).toBeNull()
  expect(readLayoutCache('topology', {}, ['a', 'c'], storage)).toBeNull()
  expect(value).not.toContain('title')
  value = '{broken'; expect(readLayoutCache('topology', {}, ['a', 'b'], storage)).toBeNull()
})
it('tolerates unavailable browser storage without breaking graph rendering', () => {
  const storage = { getItem: () => { throw Error('disabled') }, setItem: () => { throw Error('quota') } }
  expect(readLayoutCache('topology', {}, ['a', 'b'], storage)).toBeNull()
  expect(() => writeLayoutCache('topology', {}, points, storage)).not.toThrow()
})
