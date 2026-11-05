/** Unwrap only our own reference codec; referenced metadata remains context, never authority. */
export function readableWorkInstruction(text: string) {
  const references = new Set<string>()
  const instruction = text.replace(/\[Project folder reference: path metadata only, not file contents or execution\/write authorization\]\r?\n([^\r\n]+)|\[Worker conversation reference: metadata only; context hint, no send or execution authorization\]\r?\n([^\r\n]+)/g,
    (block, folder: string | undefined, worker: string | undefined) => {
      try {
        const data = JSON.parse(folder ?? worker!)
        if (!data || typeof data.uid !== 'string' || typeof data.title !== 'string' || typeof data.workspace !== 'string') return block
        references.add([data.title, data.workspace, worker ? data.uid : '', worker && typeof data.summary === 'string' ? data.summary : ''].filter(Boolean).join(' · '))
        return ''
      } catch { return block }
    }).trim()
  return { instruction, references: [...references] }
}

export function workTitle(text: string) {
  return readableWorkInstruction(text).instruction.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 60) || '工程工作'
}
