/** Bounded, attributed repository evidence; never a task ledger or execution authority. */
import { open, realpath } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { z } from 'zod'
const EvidencePath = z.string().min(1).max(240).refine(value =>
  /^(docs|scripts|sources)\//.test(value) && !value.includes('..') && !/[\\:\x00]/.test(value)
  && !value.split('/').some(part => part.startsWith('.')), 'Repository evidence path required')
const Progress = z.object({ version: z.literal(1), asOf: z.string().max(60),
  coverage: z.string().min(1).max(1000), entries: z.array(z.object({
    id: z.string().min(1).max(80), summary: z.string().min(1).max(1500),
    status: z.enum(['implemented', 'verified', 'pending', 'in-progress']),
    evidence: z.array(EvidencePath).min(1).max(8), limitations: z.string().max(1500),
  }).strict()).max(50),
}).strict()

export async function readProjectProgress(workspace: string) {
  const root = await realpath(workspace), path = join(root, 'docs', 'PROJECT_PROGRESS.json')
  const coverage = { completeProjectHistory: false, authority: 'repository_record_only',
    grantsExecution: false, source: 'docs/PROJECT_PROGRESS.json', workspace }
  let resolved: string
  try { resolved = await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...coverage, available: false,
      reason: 'No maintained progress record; absent records or tickets do not prove no work occurred.' }
    throw error
  }
  if (normalize(resolved).toLowerCase() !== normalize(path).toLowerCase()) throw Error('Progress record must be the fixed repository file, not a redirected path')
  const file = await open(resolved, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 65536) throw Error('Progress record exceeds the bounded file contract')
    const bytes = Buffer.alloc(65537), { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 65536) throw Error('Progress record exceeds the bounded file contract')
    const record = Progress.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
    return { ...coverage, available: true, ...record }
  } finally { await file.close() }
}
