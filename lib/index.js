/**
 * dsh-scrapling — Scrapling web fetching for DSH.
 *
 * WHY THIS FILE HAS NO `@deepseek-ai/*` IMPORT
 * --------------------------------------------
 * The host accepts a PLAIN tool definition at `ctx.tools.register(...)`
 * (`@deepseek-ai/dsh-tools` README, "扩展点": 工具插件调用
 * `ctx.tools.register()`，其 schema 会自动流入提示词组装). A plain definition
 * is validated only against `output.schema`; model arguments reach `execute`
 * verbatim. Staying import-free keeps this package installable without a
 * peer-dependency version gate — the same choice `dsh-ops` documents in
 * `lib/shells/tool.js` ("no `@deepseek-ai/*` value import, at load time or
 * later").
 *
 * WHAT IT REGISTERS (4 tools, 4 python ops in bridge/scrape.py)
 * ------------------------------------------------------------
 *   scrape_fetch   op fetch    one URL -> markdown / text / html
 *   scrape_extract op extract  one URL -> named fields, or rows x fields
 *   scrape_batch   op batch    N URLs -> per-URL fetch/extract, concurrent
 *   scrape_site    op site     crawl a site -> per-page markdown (ContentSpider)
 *
 * Capability surface, mapped to scrapling:
 *   engines    Fetcher (impersonating HTTP) / StealthyFetcher (real browser)
 *   verbs      GET, POST (http only — stealth has no POST path)
 *   knobs      `options` passthrough, whitelisted per engine to exactly the
 *              JSON-representable keys of GetRequestParams / DataRequestParams /
 *              StealthSession. Callables (page_action, page_setup), live objects
 *              (proxy_rotator, selector_config, additional_args) cannot cross a
 *              JSON boundary and are rejected with the supported list.
 *   parsing    css / xpath, `::text` pseudo, per-field attribute, per-field
 *              regex (first group), per-field limit, `adaptive` (auto_save)
 *   session    named cookie jar on disk: cookies set on any hop of a redirect
 *              chain persist and are replayed by later calls
 *   crawl      ContentSpider with max_pages, allowed_domains, main_content_only,
 *              css_selector, robots_txt_obey, concurrency, download_delay
 *
 * ORDER OF OPERATIONS IN ONE CALL
 * -------------------------------
 * spawn python -> write one JSON request on stdin -> read one JSON line from
 * stdout (scrapling's own logs go to stderr, so stdout stays parseable) ->
 * kill the process tree on timeout or caller abort -> return/render.
 *
 * @module dsh-scrapling
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-scrapling'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'bridge', 'scrape.py')

/** Where the interpreter and its browser payload live by default. */
const DEFAULT_ROOT = 'D:/deepseekharness workspace/_tools/scrapling'
const DEFAULT_PYTHON = 'D:/deepseekharness workspace/_tools/scrapling/.venv/Scripts/python.exe'

const DEFAULT_FETCH_TIMEOUT_MS = 30000
const DEFAULT_MAX_CHARS = 20000
const DEFAULT_CALL_TIMEOUT_MS = 120000
/** Head-room over the fetch budget: browser start-up is not the page's timeout. */
const KILL_GRACE_MS = 45000
/** Tail of stderr kept for an unparseable failure. */
const STDERR_TAIL = 1200

// ---------------------------------------------------------------------------
// output schemas — must stay inside the host subset: single type strings only,
// no nullable unions (absent keys are omitted by the bridge instead), and only
// type/properties/required/additionalProperties/items/enum/const + annotations.
// ---------------------------------------------------------------------------
const FETCH_OUTPUT = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    status: { type: 'integer' },
    mode: { type: 'string' },
    format: { type: 'string' },
    title: { type: 'string' },
    chars: { type: 'integer' },
    truncated: { type: 'boolean' },
    elapsedMs: { type: 'integer' },
    content: { type: 'string' },
  },
  required: ['url', 'status', 'content'],
  additionalProperties: true,
}

const EXTRACT_OUTPUT = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    status: { type: 'integer' },
    mode: { type: 'string' },
    title: { type: 'string' },
    adaptive: { type: 'boolean' },
    count: { type: 'integer' },
    rowCount: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['field', 'values'],
        additionalProperties: true,
      },
    },
    rows: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['url', 'status', 'fields', 'rows'],
  additionalProperties: true,
}

const BATCH_OUTPUT = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    concurrency: { type: 'integer' },
    count: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          status: { type: 'integer' },
          title: { type: 'string' },
          finalUrl: { type: 'string' },
          chars: { type: 'integer' },
          truncated: { type: 'boolean' },
          content: { type: 'string' },
          error: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['field', 'values'],
              additionalProperties: true,
            },
          },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['url'],
        additionalProperties: true,
      },
    },
  },
  required: ['count', 'results'],
  additionalProperties: true,
}

const SITE_OUTPUT = {
  type: 'object',
  properties: {
    startUrl: { type: 'string' },
    allowedDomains: { type: 'array', items: { type: 'string' } },
    paused: { type: 'boolean' },
    pageCount: { type: 'integer' },
    totalChars: { type: 'integer' },
    stoppedByCharBudget: { type: 'boolean' },
    elapsedMs: { type: 'integer' },
    stats: { type: 'object', additionalProperties: true },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          chars: { type: 'integer' },
          truncated: { type: 'boolean' },
          markdown: { type: 'string' },
        },
        required: ['url', 'markdown'],
        additionalProperties: true,
      },
    },
  },
  required: ['startUrl', 'pageCount', 'pages'],
  additionalProperties: true,
}

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* the process is already gone; nothing to clean up */
  }
}

/** Last parseable JSON object on stdout; scrapling logs never land here. */
function parseResponse(stdout) {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* keep looking upwards */
    }
  }
  return undefined
}

/**
 * One bridge round-trip.
 * @param {Record<string, unknown>} request - the JSON request (has `op`).
 * @param {{python: string, root: string, timeoutMs: number, signal?: AbortSignal}} options
 * @returns {Promise<Record<string, unknown>>} the bridge's JSON response.
 */
function runBridge(request, options) {
  const { python, root, timeoutMs, signal } = options
  if (!existsSync(BRIDGE)) {
    return Promise.reject(new Error(`bridge script is missing: ${BRIDGE}`))
  }
  if (!existsSync(python)) {
    return Promise.reject(new Error(`python interpreter not found: ${python} (set "python" on the dsh-scrapling row in cordis.patch.yml)`))
  }
  const temp = path.join(root, '.tmp')
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let child
    try {
      child = spawn(python, [BRIDGE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch (cause) {
      reject(new Error(`could not start python (${python}): ${cause?.message ?? cause}`, { cause }))
      return
    }

    let stdout = ''
    let stderr = ''
    let killedBy = ''

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    const onAbort = () => {
      killedBy = 'aborted'
      killTree(child.pid)
    }

    const timer = setTimeout(() => {
      killedBy = 'timeout'
      killTree(child.pid)
      finish(reject, new Error(`scrapling call exceeded ${timeoutMs} ms and was killed`))
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (cause) => {
      finish(reject, new Error(`could not start python (${python}): ${cause.message}`, { cause }))
    })

    child.on('close', (code) => {
      if (killedBy === 'timeout' || killedBy === 'aborted') {
        finish(reject, new Error(killedBy === 'timeout'
          ? `scrapling call exceeded ${timeoutMs} ms and was killed`
          : 'scrapling call was cancelled'))
        return
      }
      const parsed = parseResponse(stdout)
      if (parsed === undefined) {
        const tail = stderr.trim().split('\n').slice(-6).join('\n').slice(-STDERR_TAIL)
        finish(reject, new Error(`scrapling bridge produced no JSON (exit ${code})`
          + (tail ? `\n${tail}` : '') + (stdout.trim() ? `\nstdout:\n${stdout.trim().slice(-600)}` : '')))
        return
      }
      if (parsed.ok === false) {
        const kind = typeof parsed.kind === 'string' && parsed.kind !== 'error' ? ` [${parsed.kind}]` : ''
        finish(reject, new Error(`scrapling${kind}: ${parsed.error ?? 'unknown failure'}`))
        return
      }
      finish(resolve, parsed)
    })

    child.stdin.on('error', () => { /* python died before reading; close handles it */ })
    child.stdin.end(JSON.stringify(request))
  })
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------
function positiveInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return fallback
  return max !== undefined && i > max ? fallback : i
}

function requireUrl(args) {
  const url = typeof args?.url === 'string' ? args.url.trim() : ''
  if (!url) throw new Error('`url` is required (absolute http/https URL)')
  if (!/^https?:\/\//i.test(url)) throw new Error(`\`url\` must start with http:// or https://, got ${JSON.stringify(url)}`)
  return url
}

function modeOf(args) {
  const mode = typeof args?.mode === 'string' ? args.mode.toLowerCase() : 'http'
  if (mode !== 'http' && mode !== 'stealth') throw new Error(`\`mode\` must be "http" or "stealth", got ${JSON.stringify(args?.mode)}`)
  return mode
}

function sharedRequest(args, mode, timeoutMs) {
  const request = {
    url: requireUrl(args),
    mode,
    timeout_ms: timeoutMs,
  }
  const waitMs = positiveInt(args?.wait_ms, 0, 0, 60000)
  if (waitMs > 0) request.wait_ms = waitMs
  if (typeof args?.wait_selector === 'string' && args.wait_selector.trim()) request.wait_selector = args.wait_selector.trim()
  if (typeof args?.proxy === 'string' && args.proxy.trim()) request.proxy = args.proxy.trim()
  if (typeof args?.session === 'string' && args.session.trim()) request.session = args.session.trim()
  if (args?.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) request.headers = args.headers
  if (args?.options && typeof args.options === 'object' && !Array.isArray(args.options)) request.options = args.options
  return request
}

// ---------------------------------------------------------------------------
// renderers — what the model reads
// ---------------------------------------------------------------------------
function headerLine(result) {
  const bits = [result.finalUrl ?? result.url]
  if (result.status) bits.push(`HTTP ${result.status}`)
  if (result.mode) bits.push(result.mode)
  if (result.elapsedMs) bits.push(`${(result.elapsedMs / 1000).toFixed(1)}s`)
  return bits.join(' · ')
}

function renderFields(fields) {
  const lines = []
  for (const field of fields ?? []) {
    if (field.error) {
      lines.push(`- ${field.field}: ! ${field.error}`)
      continue
    }
    const values = field.values ?? []
    lines.push(`- ${field.field}: ${values.length === 0 ? '(no match)' : values.join(' | ')}`)
  }
  return lines
}

function renderRows(rows, limit) {
  const shown = (rows ?? []).slice(0, limit)
  const lines = []
  for (const row of shown) {
    const pairs = Object.entries(row).map(([key, value]) => `${key}=${value === undefined ? '' : JSON.stringify(value)}`)
    lines.push(`- ${pairs.join(' ')}`)
  }
  if ((rows ?? []).length > shown.length) lines.push(`- … ${rows.length - shown.length} more rows`)
  return lines
}

function renderFetch(_args, value) {
  const title = value.title ? `# ${value.title}\n` : ''
  const size = `${value.format} · ${value.chars} chars${value.truncated ? ' (truncated)' : ''}`
  return [{ type: 'text', text: `${title}${headerLine(value)} · ${size}\n\n${value.content}` }]
}

function renderExtract(args, value) {
  const lines = [`${value.title ? `# ${value.title}\n` : ''}${headerLine(value)} · ${value.count} values`]
  if (value.adaptive) lines.push('(adaptive selectors: matches allowed to drift from the stored fingerprint)')
  if ((value.fields ?? []).length > 0) lines.push(...renderFields(value.fields))
  if ((value.rows ?? []).length > 0) {
    lines.push(`rows (${value.rowCount}):`)
    lines.push(...renderRows(value.rows, positiveInt(args?.limit, 20, 1, 200)))
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderBatch(args, value) {
  const lines = [`${value.count} URL(s) · ${value.succeeded} ok · ${value.failed} failed · ${value.mode} · ${(value.elapsedMs / 1000).toFixed(1)}s`]
  const perItem = positiveInt(args?.max_chars, 4000, 500, 400000)
  for (const item of value.results ?? []) {
    if (item.error) {
      lines.push(`\n### ${item.url}\n! ${item.error}`)
      continue
    }
    const bits = [`### ${item.url}`]
    const meta = []
    if (item.status) meta.push(`HTTP ${item.status}`)
    if (item.title) meta.push(item.title)
    if (item.chars) meta.push(`${item.chars} chars${item.truncated ? '+' : ''}`)
    if (meta.length) bits.push(`(${meta.join(' · ')})`)
    lines.push(`\n${bits.join('\n')}`)
    if (Array.isArray(item.fields) && item.fields.length) lines.push(...renderFields(item.fields))
    if (Array.isArray(item.rows) && item.rows.length) lines.push(...renderRows(item.rows, 10))
    if (typeof item.content === 'string') {
      const content = item.content.length > perItem
        ? `${item.content.slice(0, perItem)}\n...[that URL's content truncated]`
        : item.content
      lines.push('', content)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderSite(args, value) {
  const lines = [
    `crawled ${value.pageCount} page(s) from ${value.startUrl}`
      + ` (domains: ${(value.allowedDomains ?? []).join(', ') || '—'} · ${value.totalChars} chars · ${(value.elapsedMs / 1000).toFixed(1)}s)`,
  ]
  if (value.stoppedByCharBudget) lines.push('(stopped early: max_total_chars reached; raise it or narrow max_pages)')
  for (const page of value.pages ?? []) {
    lines.push(`\n## ${page.title || page.url}\n${page.url} · ${page.chars} chars${page.truncated ? ' (truncated)' : ''}\n\n${page.markdown}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// system-prompt section — the cross-tool "when to use which" guidance that no
// single tool description can carry (each tool only knows itself). Mounted per
// agent through the `systemPrompt` service; every step is defensive so a host
// version without that service loses the guidance, never the tools.
// ---------------------------------------------------------------------------
const PROMPT_GUIDE = `## Web fetching (dsh-scrapling)

Four tools share one Scrapling backend. Pick by shape of the task:

- \`scrape_fetch\` — read one page as markdown (default) / text / html.
- \`scrape_extract\` — get specific values from one page: named CSS/XPath fields, or \`rows\` for lists and tables (one object per item — prefer this over parallel arrays you would align by index).
- \`scrape_batch\` — the same work over up to 50 URLs at once, failures isolated per URL.
- \`scrape_site\` — crawl a section of a site (ContentSpider), one markdown item per page; bounded by max_pages and max_total_chars.

Engine choice: \`mode: "http"\` is an impersonating HTTP client (1–3 s, no JavaScript, supports POST). Try it first. Escalate to \`mode: "stealth"\` (a real browser, 6–10 s start-up) when the page comes back empty, blocked (403/429/503), or as a JS stub; add \`options.solve_cloudflare\` for Cloudflare interstitials and \`wait_selector\` for late-rendered content.

Before concluding a page has no data, check the returned \`status\`, \`chars\` and title: a near-empty markdown usually means "needs stealth", not "no content". Use \`session\` to keep cookies across calls when a site needs a login or a consent step. Respect the sites you do not own: keep \`max_pages\` small on a first crawl and set \`robots_txt_obey\` for third-party sites.`

/**
 * Mount the guidance section on every agent. Best effort: a host that exposes
 * no `systemPrompt` service (or a different `section` shape) silently keeps the
 * tools working without the section.
 */
function mountPromptGuide(ctx, logger) {
  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      const attach = (agent) => {
        try {
          const prompt = agent?.ctx?.get?.('systemPrompt')
          if (!prompt || typeof prompt.section !== 'function') return
          const stop = prompt.section({
            name: 'dsh-scrapling:guide',
            order: 60,
            interpolate: false,
            text: (context) => (context?.scope === agent ? PROMPT_GUIDE : ''),
          })
          if (typeof stop === 'function') agent.ctx.effect?.(() => stop)
        } catch (error) {
          logger?.warn?.(`${name}: could not add the web-fetching prompt section: ${error?.message ?? error}`)
        }
      }
      scoped.on('agent/created', ({ agent }) => attach(agent))
      for (const agent of scoped.get?.('agents')?.list?.() ?? []) attach(agent)
    })
  } catch (error) {
    logger?.warn?.(`${name}: prompt guidance not mounted (${error?.message ?? error}); the scrape tools are unaffected`)
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const python = typeof config.python === 'string' && config.python.trim() ? config.python.trim() : DEFAULT_PYTHON
  const root = typeof config.root === 'string' && config.root.trim() ? config.root.trim() : DEFAULT_ROOT
  const hardCapMs = positiveInt(config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, 5000, 900000)
  const defaultMaxChars = positiveInt(config.maxChars, DEFAULT_MAX_CHARS, 500, 400000)
  const sessionDir = path.join(root, '.sessions')

  if (!existsSync(python)) {
    ctx.logger?.warn?.(`${name}: python interpreter not found at ${python}; the scrape tools will fail until "python" is corrected`)
  }

  const call = (request, timeoutMs, signal) => {
    request.cache_dir = sessionDir
    return runBridge(request, {
      python,
      root,
      timeoutMs: Math.min(hardCapMs, timeoutMs + KILL_GRACE_MS),
      signal,
    })
  }

  ctx.effect(() => ctx.tools.register({
    name: 'scrape_fetch',
    description: 'Fetch one web page with Scrapling and return it as markdown (default), plain text, or raw HTML, plus status,'
      + ' final URL after redirects, and title.'
      + ' `mode: "http"` is an impersonating HTTP client (fast, no JavaScript, supports POST); `mode: "stealth"` drives a'
      + ' real browser (JavaScript, anti-bot, Cloudflare via options.solve_cloudflare) at several seconds of start-up cost.'
      + ' `session` keeps cookies across calls. Use `options` for engine knobs (impersonate, http3, retries, real_chrome, '
      + 'locale, useragent, wait_selector_state, ...); an unsupported key fails with the supported list.'
      + ' For reading specific fields rather than the whole page, prefer scrape_extract.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to fetch.' },
        mode: {
          type: 'string',
          enum: ['http', 'stealth'],
          description: '"http" (default, no browser) or "stealth" (real browser). Use stealth when http returns an empty, blocked or JS-stub page.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'text', 'html'],
          description: 'Output shape: "markdown" (default), "text" (visible text only), "html" (raw markup).',
        },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP verb. Default GET; POST is http-mode only.' },
        body: { type: 'string', description: 'POST body, sent form-encoded (http mode only).' },
        json_body: { type: 'object', description: 'POST body sent as JSON (http mode only; takes precedence over body).' },
        max_chars: { type: 'integer', description: `Cap on returned characters. Default ${DEFAULT_MAX_CHARS}.` },
        timeout_ms: { type: 'integer', description: `Page budget in milliseconds. Default ${DEFAULT_FETCH_TIMEOUT_MS}.` },
        wait_ms: { type: 'integer', description: 'Stealth only: extra milliseconds after load before reading the DOM.' },
        wait_selector: { type: 'string', description: 'Stealth only: CSS selector to wait for before reading the DOM.' },
        headers: { type: 'object', description: 'Extra request headers as a flat object of string values.' },
        proxy: { type: 'string', description: 'Proxy URL (http:// or socks5://).' },
        session: { type: 'string', description: 'Named cookie jar. Cookies set by the response (and by any redirect hop) are saved and replayed by later calls with the same name.' },
        options: {
          type: 'object',
          description: 'Engine knobs, passed through to scrapling. http: impersonate, http3, stealthy_headers, proxies, proxy_auth, retries, retry_delay, follow_redirects, max_redirects, verify, cert, params, auth. stealth: headless, disable_resources, network_idle, load_dom, pierce_shadow, wait_selector_state, google_search, timezone_id, init_script, user_data_dir, locale, useragent, extra_flags, blocked_domains, block_ads, record_requests, max_recorded_requests, executable_path, dns_over_https, real_chrome, allow_webgl, hide_canvas, block_webrtc, solve_cloudflare, retries, retry_delay, extra_headers.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: FETCH_OUTPUT, render: renderFetch },
    async execute(args, exec) {
      const mode = modeOf(args)
      const timeoutMs = positiveInt(args?.timeout_ms, DEFAULT_FETCH_TIMEOUT_MS, 1000, 180000)
      const format = typeof args?.format === 'string' ? args.format.toLowerCase() : 'markdown'
      if (!['markdown', 'text', 'html'].includes(format)) {
        throw new Error(`\`format\` must be "markdown", "text" or "html", got ${JSON.stringify(args?.format)}`)
      }
      const request = sharedRequest(args, mode, timeoutMs)
      request.op = 'fetch'
      request.format = format
      request.max_chars = positiveInt(args?.max_chars, defaultMaxChars, 200, 400000)
      if (typeof args?.method === 'string') request.method = args.method.toUpperCase()
      if (typeof args?.body === 'string' && args.body.length > 0) request.body = args.body
      if (args?.json_body && typeof args.json_body === 'object') request.json_body = args.json_body
      return call(request, timeoutMs, exec?.signal)
    },
  }), `${name} scrape_fetch`)

  ctx.effect(() => ctx.tools.register({
    name: 'scrape_extract',
    description: 'Fetch one page with Scrapling and pull structured data out of it.'
      + ' `selectors` maps field name -> CSS selector (or XPath when it starts with "/"), and returns every match;'
      + ' a field may instead be an object {"selector", "attribute", "regex", "limit", "all"} for one attribute (href/src),'
      + ' a regex capture over the matched text, a cap, or all matches.'
      + ' `rows` is for lists and tables: {"container": selector, "fields": {name: spec}} returns ONE OBJECT PER ITEM'
      + ' (e.g. every search result as {title, href, price}) instead of parallel arrays you would have to align by index.'
      + ' `adaptive: true` lets a selector keep matching after the site changes its markup (fingerprints are saved by'
      + ' scrapling, keyed to the page). Same engine and session options as scrape_fetch.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to fetch.' },
        selectors: {
          type: 'object',
          additionalProperties: true,
          description: 'Field name -> selector string, or -> {selector, attribute, regex, limit, all}. CSS by default, XPath when it starts with "/".',
        },
        rows: {
          type: 'object',
          additionalProperties: true,
          description: 'Row extraction: {"container": "css or xpath of one item", "limit": 20, "fields": {name: <same spec shape as selectors>}}. Each field selector is resolved INSIDE the item node.',
        },
        attribute: { type: 'string', description: 'Default attribute for every plain-string selector (e.g. "href"). Per-field "attribute" overrides it.' },
        limit: { type: 'integer', description: 'Default matches kept per field (and per row container). Default 20.' },
        adaptive: { type: 'boolean', description: 'Enable scrapling adaptive selectors so fields survive markup changes. Slower on first use; needs the page to be fetched again later with the same field names to matter.' },
        mode: { type: 'string', enum: ['http', 'stealth'], description: '"http" (default) or "stealth" (real browser).' },
        timeout_ms: { type: 'integer', description: `Page budget in milliseconds. Default ${DEFAULT_FETCH_TIMEOUT_MS}.` },
        wait_ms: { type: 'integer', description: 'Stealth only: extra wait after load, in milliseconds.' },
        wait_selector: { type: 'string', description: 'Stealth only: CSS selector to wait for before reading the DOM.' },
        headers: { type: 'object', description: 'Extra request headers as a flat object of string values.' },
        proxy: { type: 'string', description: 'Proxy URL.' },
        session: { type: 'string', description: 'Named cookie jar; cookies from any redirect hop are saved and replayed by later calls.' },
        options: { type: 'object', additionalProperties: true, description: 'Engine knobs passed to scrapling (same whitelist as scrape_fetch).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: EXTRACT_OUTPUT, render: renderExtract },
    async execute(args, exec) {
      const mode = modeOf(args)
      const selectors = args?.selectors
      const rows = args?.rows
      if (selectors && (typeof selectors !== 'object' || Array.isArray(selectors) || Object.keys(selectors).length === 0)) {
        throw new Error('`selectors` must be a non-empty object of field name -> selector')
      }
      if (!selectors && !rows) throw new Error('pass `selectors` (named fields) or `rows` (one object per item)')
      if (rows && (typeof rows !== 'object' || Array.isArray(rows))) throw new Error('`rows` must be an object {container, fields}')
      const timeoutMs = positiveInt(args?.timeout_ms, DEFAULT_FETCH_TIMEOUT_MS, 1000, 180000)
      const request = sharedRequest(args, mode, timeoutMs)
      request.op = 'extract'
      if (selectors) request.selectors = selectors
      if (rows) request.rows = rows
      request.limit = positiveInt(args?.limit, 20, 1, 200)
      if (args?.adaptive === true) request.adaptive = true
      if (typeof args?.attribute === 'string' && args.attribute.trim()) request.attribute = args.attribute.trim()
      return call(request, timeoutMs, exec?.signal)
    },
  }), `${name} scrape_extract`)

  ctx.effect(() => ctx.tools.register({
    name: 'scrape_batch',
    description: 'Fetch up to 50 URLs in one call, concurrently. Without selectors each URL comes back as its own truncated page'
      + ' (status, title, content); with the same `selectors`/`rows` shape as scrape_extract, the extraction is applied to'
      + ' every URL. Per-URL failures are reported per item instead of failing the call.'
      + ' Concurrency defaults to 4 and is ignored (forced to 1) in stealth mode, where each worker costs a browser.',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Absolute http/https URLs. Max 50 per call.' },
        mode: { type: 'string', enum: ['http', 'stealth'], description: '"http" (default) or "stealth".' },
        concurrency: { type: 'integer', description: 'Parallel workers. Default 4, max 16; forced to 1 in stealth mode.' },
        format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Per-URL output shape. Default markdown.' },
        selectors: { type: 'object', additionalProperties: true, description: 'Optional: extract these fields from every URL instead of returning whole pages.' },
        rows: { type: 'object', additionalProperties: true, description: 'Optional: row extraction applied to every URL.' },
        attribute: { type: 'string', description: 'Default attribute for plain-string selectors.' },
        limit: { type: 'integer', description: 'Default matches kept per field. Default 20.' },
        max_chars: { type: 'integer', description: 'Per-URL character cap. Default 4000 (batch results are rendered together).' },
        timeout_ms: { type: 'integer', description: 'Per-URL page budget in milliseconds. Default 30000.' },
        headers: { type: 'object', description: 'Extra request headers applied to every URL.' },
        proxy: { type: 'string', description: 'Proxy URL applied to every URL.' },
        session: { type: 'string', description: 'Named cookie jar shared by every URL in this call.' },
        options: { type: 'object', additionalProperties: true, description: 'Engine knobs passed to scrapling.' },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    output: { schema: BATCH_OUTPUT, render: renderBatch },
    async execute(args, exec) {
      const urls = args?.urls
      if (!Array.isArray(urls) || urls.length === 0) throw new Error('`urls` must be a non-empty array of http(s) URLs')
      const clean = urls.map((u) => {
        if (typeof u !== 'string' || !/^https?:\/\//i.test(u.trim())) {
          throw new Error(`\`urls\` contains a non-http(s) entry: ${JSON.stringify(u)}`)
        }
        return u.trim()
      })
      const mode = modeOf(args)
      const concurrency = positiveInt(args?.concurrency, 4, 1, 16)
      const timeoutMs = positiveInt(args?.timeout_ms, DEFAULT_FETCH_TIMEOUT_MS, 1000, 180000)
      const workers = mode === 'stealth' ? 1 : concurrency
      const request = {
        op: 'batch',
        urls: clean,
        mode,
        concurrency,
        timeout_ms: timeoutMs,
        max_chars: positiveInt(args?.max_chars, 4000, 200, 400000),
        limit: positiveInt(args?.limit, 20, 1, 200),
      }
      if (typeof args?.session === 'string' && args.session.trim()) request.session = args.session.trim()
      if (args?.headers && typeof args.headers === 'object') request.headers = args.headers
      if (typeof args?.proxy === 'string' && args.proxy.trim()) request.proxy = args.proxy.trim()
      if (args?.options && typeof args.options === 'object') request.options = args.options
      if (typeof args?.attribute === 'string' && args.attribute.trim()) request.attribute = args.attribute.trim()
      if (args?.selectors) request.selectors = args.selectors
      if (args?.rows) request.rows = args.rows
      if (typeof args?.format === 'string') request.format = args.format.toLowerCase()
      const budget = timeoutMs * Math.ceil(clean.length / workers) + 15000
      return call(request, budget, exec?.signal)
    },
  }), `${name} scrape_batch`)

  ctx.effect(() => ctx.tools.register({
    name: 'scrape_site',
    description: 'Crawl a site starting from one URL and return each page as clean markdown, using Scrapling\'s ContentSpider'
      + ' (links inside the allowed domains are followed breadth-first, duplicates are dropped by the engine).'
      + ' Returns {url, title, markdown} per page plus crawl stats. Bounded by max_pages and by max_total_chars, so it is'
      + ' safe to call on an unknown site: the budget cuts the result, not the crawl.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL; its host becomes the default allowed domain.' },
        max_pages: { type: 'integer', description: 'Page cap. Default 10, max 500; 0 means no cap (pair it with max_total_chars).' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Hosts the crawl may stay inside. Defaults to the start URL host.' },
        css_selector: { type: 'string', description: 'Convert only the elements matching this selector instead of the whole page.' },
        main_content_only: { type: 'boolean', description: 'Convert only <body> content. Default true; false keeps head/boilerplate too.' },
        robots_txt_obey: { type: 'boolean', description: 'Respect robots.txt. Default false — set true for third-party sites you do not own.' },
        concurrency: { type: 'integer', description: 'Parallel requests. Default 4, max 16.' },
        download_delay: { type: 'number', description: 'Seconds between requests to the same host. Default 0; raise it for a polite crawl.' },
        max_chars_per_page: { type: 'integer', description: 'Per-page markdown cap. Default 12000.' },
        max_total_chars: { type: 'integer', description: 'Total markdown budget across pages. Default 60000.' },
        session: { type: 'string', description: 'Named cookie jar; its cookies are sent as a Cookie header on every crawl request.' },
        headers: { type: 'object', description: 'Extra request headers for every crawl request.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: SITE_OUTPUT, render: renderSite },
    async execute(args, exec) {
      const url = requireUrl(args)
      const request = {
        op: 'site',
        url,
        max_pages: positiveInt(args?.max_pages, 10, 0, 500),
        concurrency: positiveInt(args?.concurrency, 4, 1, 16),
        max_chars_per_page: positiveInt(args?.max_chars_per_page, 12000, 500, 400000),
        max_total_chars: positiveInt(args?.max_total_chars, 60000, 1000, 2000000),
        main_content_only: args?.main_content_only !== false,
        robots_txt_obey: args?.robots_txt_obey === true,
      }
      if (Array.isArray(args?.allowed_domains) && args.allowed_domains.length) request.allowed_domains = args.allowed_domains
      if (typeof args?.css_selector === 'string' && args.css_selector.trim()) request.css_selector = args.css_selector.trim()
      if (Number.isFinite(Number(args?.download_delay))) request.download_delay = Number(args.download_delay)
      if (typeof args?.session === 'string' && args.session.trim()) request.session = args.session.trim()
      if (args?.headers && typeof args.headers === 'object') request.headers = args.headers
      return call(request, hardCapMs, exec?.signal)
    },
  }), `${name} scrape_site`)

  ctx.logger?.info?.(`${name}: registered scrape_fetch, scrape_extract, scrape_batch, scrape_site (python: ${python})`)
  if (config.promptGuide !== false) mountPromptGuide(ctx, ctx.logger)
}
