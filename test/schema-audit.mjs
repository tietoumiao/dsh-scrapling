/**
 * Schema audit: mount the plugin against a fake ctx and check every JSON Schema
 * it hands the host against the rules the host's validator enforces.
 *
 * The rule that bit us once: `type` must be ONE type string — `type: ['string',
 * 'null']` is rejected with "unsupported JSON schema". Same check applied to the
 * tool `parameters` (they are projected into the model-facing schema).
 *
 *   node test/schema-audit.mjs
 */
import { apply } from '../lib/index.js'

const tools = new Map()
const ctx = {
  logger: { info: () => {}, warn: (m) => console.warn('[warn]', m) },
  effect: (fn) => fn(),
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
}
apply(ctx, {})

const problems = []
const ALLOWED = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

function walk(node, path) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key
    if (key === 'type') {
      if (Array.isArray(value)) problems.push(`${here}: type is an array ${JSON.stringify(value)} (must be a single string)`)
      else if (typeof value !== 'string') problems.push(`${here}: type is ${typeof value} (must be a string)`)
      else if (!ALLOWED.has(value)) problems.push(`${here}: unknown type ${JSON.stringify(value)}`)
    }
    if (key === 'additionalProperties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      problems.push(`${here}: additionalProperties is a schema (prefer a boolean on this host)`)
    }
    if (['$ref', 'patternProperties', 'if', 'then', 'else', 'not'].includes(key)) {
      problems.push(`${here}: ${key} is not known to be supported`)
    }
    walk(value, here)
  }
}

for (const [name, definition] of tools) {
  walk(definition.parameters, `${name}.parameters`)
  walk(definition.output?.schema, `${name}.output.schema`)
}

if (problems.length === 0) {
  console.log(`PASS  ${tools.size} tool schemas clean (single type strings only)`)
  process.exit(0)
}
console.log(`FAIL  ${problems.length} problem(s):`)
for (const p of problems) console.log('  -', p)
process.exit(1)
