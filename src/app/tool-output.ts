type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function jsonValue(value: unknown, ancestors: Set<object>, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || !value) throw Error('Unsupported tool output at ' + path)
  if (ancestors.has(value)) throw Error('Cyclic tool output at ' + path)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw Error('Non-JSON tool output at ' + path)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw Error('Non-dense tool output at ' + path)
      return value.map((item, index) => jsonValue(item, ancestors, path + '[' + index + ']'))
    }
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, jsonValue(item, ancestors, path + '.' + key)]))
  } finally { ancestors.delete(value) }
}

export function toolOutput(value: unknown): Record<string, JsonValue> {
  const projected = jsonValue(value, new Set(), '$')
  return Array.isArray(projected) ? { items: projected }
    : projected !== null && typeof projected === 'object' ? projected : { value: projected }
}
