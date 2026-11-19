/**
 * Offline smoke test: mount the plugin against a fake ctx, then run the four
 * tools through the real python bridge. No LLM, no App.
 *
 *   node test/smoke.mjs            # everything except the browser engine
 *   node test/smoke.mjs --stealth  # also exercise StealthyFetcher once
 */
import { apply, name } from '../lib/index.js'

const tools = new Map()
const disposers = []
const agentHandlers = new Map()

const ctx = {
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.warn('[warn]', m) },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  // Cordis-style dynamic inject: hand the callback a scope that carries `on`.
  inject(_deps, callback) {
    callback({
      on(event, handler) {
        agentHandlers.set(event, handler)
        return () => agentHandlers.delete(event)
      },
      get: () => undefined,
    })
  },
}

apply(ctx, {})
console.log('plugin:', name, '| tools:', [...tools.keys()].join(', '))

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: !!condition, detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- 0. prompt guidance -----------------------------------------------------
try {
  const sections = []
  const sectionAgent = {
    ctx: {
      get: (key) => (key === 'systemPrompt'
        ? { section: (options) => { sections.push(options); return () => {} } }
        : undefined),
      effect: (fn) => { fn() },
    },
  }
  const handler = agentHandlers.get('agent/created')
  check('prompt guide subscribes to agent/created', typeof handler === 'function')
  handler({ agent: sectionAgent })
  const section = sections[0]
  check('prompt guide registers one section', sections.length === 1)
  check('prompt guide names itself', section?.name === 'dsh-scrapling:guide', section?.name)
  const mine = section?.text({ scope: sectionAgent }) ?? ''
  const other = section?.text({ scope: { not: 'you' } }) ?? ''
  check('prompt guide lists all four tools', ['scrape_fetch', 'scrape_extract', 'scrape_batch', 'scrape_site']
    .every((t) => mine.includes(t)), `${mine.length} chars`)
  check('prompt guide stays scoped to its agent', mine.length > 200 && other === '')
} catch (error) {
  check('prompt guide', false, error.message)
}

const signal = new AbortController().signal
const call = async (toolName, args) => {
  const definition = tools.get(toolName)
  if (!definition) throw new Error(`tool ${toolName} is not registered`)
  const started = Date.now()
  const value = await definition.execute(args, { signal })
  const rendered = definition.output.render(args, value)
  return { value, rendered, ms: Date.now() - started }
}

async function expectError(label, pattern, fn) {
  try {
    await fn()
    check(label, false, 'no error thrown')
  } catch (error) {
    check(label, pattern.test(error.message), error.message.slice(0, 160))
  }
}

// --- 1. fetch ---------------------------------------------------------------
try {
  const { value, rendered, ms } = await call('scrape_fetch', { url: 'https://example.com', max_chars: 400 })
  check('fetch returns 200', value.status === 200, `${ms}ms`)
  check('fetch markdown non-empty', value.content.length > 20, `${value.chars} chars`)
  check('fetch render has status line', rendered[0].text.includes('HTTP 200'))
} catch (error) {
  check('fetch returns 200', false, error.message)
}

try {
  const { value } = await call('scrape_fetch', { url: 'https://example.com', format: 'html', max_chars: 200 })
  check('fetch html format', value.format === 'html' && value.content.includes('<'), `${value.chars} chars`)
} catch (error) {
  check('fetch html format', false, error.message)
}

// --- 2. extract: fields, regex, rows ---------------------------------------
try {
  const { value, rendered } = await call('scrape_extract', {
    url: 'https://example.com',
    selectors: { title: 'title::text', body: 'body' },
  })
  const title = value.fields.find((f) => f.field === 'title')
  check('extract title field', title?.values?.[0] === 'Example Domain', JSON.stringify(title?.values))
  check('extract omits null attribute', !('attribute' in value))
  check('extract render lists fields', rendered[0].text.includes('- title:'))
} catch (error) {
  check('extract title field', false, error.message)
}

try {
  const { value } = await call('scrape_extract', {
    url: 'https://example.com',
    selectors: { word: { selector: 'body', regex: '([A-Za-z]+) domain' } },
  })
  check('extract regex capture', value.fields[0]?.values?.[0] === 'This', JSON.stringify(value.fields[0]?.values))
} catch (error) {
  check('extract regex capture', false, error.message)
}

try {
  const { value, rendered } = await call('scrape_extract', {
    url: 'https://www.iana.org/help/example-domains',
    rows: { container: 'a', limit: 4, fields: { href: { attribute: 'href' }, label: {} } },
  })
  check('extract rows count', value.rowCount === 4 && value.rows.length === 4, `rows=${value.rowCount}`)
  check('extract row has href', /^\//.test(value.rows[1]?.href ?? ''), JSON.stringify(value.rows[1]))
  check('extract rows rendered', rendered[0].text.includes('rows (4)'))
} catch (error) {
  check('extract rows count', false, error.message)
}

// --- 3. batch ---------------------------------------------------------------
try {
  const { value, rendered } = await call('scrape_batch', {
    urls: ['https://example.com', 'https://example.org', 'https://www.iana.org/help/example-domains'],
    concurrency: 3,
    max_chars: 300,
  })
  check('batch all succeeded', value.succeeded === 3 && value.failed === 0, `${value.elapsedMs}ms, conc=${value.concurrency}`)
  check('batch render lists every URL', rendered[0].text.split('###').length >= 4)
} catch (error) {
  check('batch all succeeded', false, error.message)
}

// concurrency measured against itself: same two URLs, serial vs parallel
try {
  const pair = ['https://example.com', 'https://www.iana.org/help/example-domains']
  const serial = await call('scrape_batch', { urls: pair, concurrency: 1, max_chars: 200 })
  const parallel = await call('scrape_batch', { urls: pair, concurrency: 2, max_chars: 200 })
  check('batch parallel beats serial', parallel.value.elapsedMs < serial.value.elapsedMs * 0.9,
    `serial=${serial.value.elapsedMs}ms parallel=${parallel.value.elapsedMs}ms`)
} catch (error) {
  check('batch parallel beats serial', false, error.message)
}

try {
  const { value } = await call('scrape_batch', {
    urls: ['https://example.com', 'https://example.org'],
    selectors: { title: 'title::text' },
  })
  const titles = value.results.map((r) => r.fields?.[0]?.values?.[0])
  check('batch applies selectors per URL', titles.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(titles))
} catch (error) {
  check('batch applies selectors per URL', false, error.message)
}

try {
  const { value } = await call('scrape_batch', { urls: ['https://example.com', 'https://nonexistent.invalid'] })
  check('batch isolates per-URL failure', value.failed === 1 && value.succeeded === 1, `ok=${value.succeeded} failed=${value.failed}`)
} catch (error) {
  check('batch isolates per-URL failure', false, error.message)
}

// --- 4. site ----------------------------------------------------------------
try {
  const { value, rendered } = await call('scrape_site', {
    url: 'https://www.iana.org/help/example-domains',
    max_pages: 3,
    max_total_chars: 8000,
    max_chars_per_page: 3000,
    concurrency: 2,
  })
  check('site crawled >= 2 pages', value.pageCount >= 2, `${value.pageCount} pages, ${value.totalChars} chars`)
  check('site pages have markdown', value.pages.every((p) => p.markdown.length > 0))
  check('site render has page headings', rendered[0].text.includes('## '))
  check('site stats exposed', typeof value.stats.requests_count === 'number', JSON.stringify(Object.keys(value.stats).slice(0, 5)))
} catch (error) {
  check('site crawled >= 2 pages', false, error.message)
}

// --- 5. cookie session ------------------------------------------------------
try {
  await call('scrape_fetch', {
    url: 'https://httpbin.org/cookies/set?dsh=42',
    session: 'smoke-jar',
    max_chars: 60,
  })
  const { value } = await call('scrape_fetch', {
    url: 'https://httpbin.org/cookies',
    session: 'smoke-jar',
    format: 'text',
    max_chars: 200,
  })
  check('session cookie replayed', /"dsh"\s*:\s*"42"/.test(value.content), value.content.replace(/\s+/g, ' ').slice(0, 80))
} catch (error) {
  check('session cookie replayed', false, error.message)
}

// --- 6. argument rejection --------------------------------------------------
await expectError('rejects non-http url', /must start with http/, () => call('scrape_fetch', { url: 'ftp://example.com' }))
await expectError('rejects empty selectors', /non-empty object/, () => call('scrape_extract', { url: 'https://example.com', selectors: {} }))
await expectError('rejects bad format', /format.*must be/, () => call('scrape_fetch', { url: 'https://example.com', format: 'pdf' }))
await expectError('rejects unknown option', /unsupported http option/, () => call('scrape_fetch', { url: 'https://example.com', options: { bogus: 1 } }))
await expectError('rejects empty urls', /non-empty array/, () => call('scrape_batch', { urls: [] }))
await expectError('rejects row without fields', /rows\.fields/, () => call('scrape_extract', { url: 'https://example.com', rows: { container: 'a' } }))

// --- 7. optional browser engine --------------------------------------------
if (process.argv.includes('--stealth')) {
  try {
    const { value, ms } = await call('scrape_fetch', {
      url: 'https://example.com',
      mode: 'stealth',
      format: 'text',
      max_chars: 300,
      options: { block_ads: true, hide_canvas: true },
    })
    check('stealth fetch works', value.status === 200 && value.mode === 'stealth', `${ms}ms`)
  } catch (error) {
    check('stealth fetch works', false, error.message)
  }
}

for (const dispose of disposers) dispose?.()
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
