/**
 * @ruaibeite/dsh-agent-ci — host half.
 *
 * Agent CI: freeze a real session into a regression case (prompt + repo + model
 * + assertions), replay it in an isolated git worktree with a fresh DSH agent,
 * then check deterministic assertions (test command, changed files, steps,
 * tokens) and keep a comparable run history.
 *
 * Everything is local: this module reads the projection cache
 * (`$DSH_HOME/storages/session_projcache/sessions/*.json`) only to offer recent
 * sessions, writes its own state to `$DSH_HOME/cache/agent-ci/` (atomic writes),
 * and never writes a session or the user's repository. Runs happen inside a
 * throwaway `git worktree`.
 *
 * The run pipeline is dependency-injected (`runCase({ case, deps })`) so the
 * orchestration is unit-testable with fake `agents` / `subprocess` /
 * `sessionQuery` services; the real services are resolved lazily at run time.
 * Imports are `node:` builtins only — the plugin profile does not carry
 * `@deepseek-ai/*`.
 *
 * Guardrails: `apply` never throws (activation failures only warn), every route
 * failure is a JSON body, and a missing optional service yields
 * `error: 'service-unavailable'` instead of an exception.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Constants (exported for the tests and the docs)
// ---------------------------------------------------------------------------

/** Route served to the browser half. */
export const ROUTE = '/dsh-agent-ci/api'

/** Schema versions of the two cache files. */
export const CASES_VERSION = 1
export const RUNS_VERSION = 1

/** Case/runs retention caps (SPEC §2). */
export const MAX_CASES = 100
export const MAX_RUNS = 50

/** Request body cap for POST. */
export const MAX_BODY_BYTES = 1024 * 1024

/** Tail length kept from the user test command. */
export const MAX_TEST_OUTPUT = 4000

/** Field caps. */
export const MAX_NAME = 120
export const MAX_PROMPT = 20000
export const MAX_TEST_COMMAND = 4096
export const MAX_PATH_ENTRIES = 50
export const MAX_PATH_LENGTH = 512

/** Recent sessions offered by `GET report`. */
export const MAX_SESSIONS = 30

/** Largest projection file read (anything bigger is skipped). */
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024

/** Allowed run statuses / reasons (SPEC §2.2). */
export const STATUSES = ['passed', 'failed', 'error']
export const REASONS = [
  'ok',
  'test-failed',
  'forbidden-path',
  'expect-file-missing',
  'max-steps',
  'max-tokens',
  'agent-error',
  'no-git',
  'service-unavailable',
]

/** Cache paths relative to `$DSH_HOME`. */
export const CASES_RELATIVE_PATH = path.join('cache', 'agent-ci', 'cases.json')
export const RUNS_RELATIVE_PATH = path.join('cache', 'agent-ci', 'runs.json')
export const PROJCACHE_RELATIVE_PATH = path.join('storages', 'session_projcache', 'sessions')

/** Temp root name under `os.tmpdir()`. */
export const WORKTREE_ROOT = 'dsh-agent-ci'

const CASE_ID_PATTERN = /^case-[a-z0-9]{4,32}$/i
const RUN_ID_LENGTH = 8

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Finite number or 0. */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Short human message for a thrown value. */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** Coerce a chunk-ish value to text. */
function toText(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value !== null && value !== undefined && typeof value.toString === 'function') {
    try {
      const text = value.toString()
      if (typeof text === 'string') return text
    } catch {
      /* opaque stream object */
    }
  }
  return ''
}

/** Keep only the last `max` characters (output tails). */
export function tailText(value, max = MAX_TEST_OUTPUT) {
  const text = typeof value === 'string' ? value : toText(value)
  if (text.length <= max) return text
  return text.slice(text.length - max)
}

/** First string value in a list, trimmed; `undefined` when none. */
const firstText = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** `$DSH_HOME`: explicit option, env var, else `~/.dsh`. */
export function resolveHome(options = {}) {
  if (isObject(options) && typeof options.home === 'string' && options.home !== '') return options.home
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  return path.join(homedir(), '.dsh')
}

/** Generate an id like `case-1a2b3c4d` / `run-1a2b3c4d`. */
export function shortId(prefix, randomUUIDFn = randomUUID) {
  let raw = ''
  try {
    raw = String(randomUUIDFn())
  } catch {
    raw = ''
  }
  const compact = raw.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return `${prefix}-${(compact || Math.random().toString(16).slice(2)).slice(0, RUN_ID_LENGTH)}`
}

/** Read a JSON file; any failure returns `null` (missing/corrupt/unknown). */
export async function readJsonFile(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Atomic JSON write: temp file + rename (SPEC §3.3). */
export async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await mkdir(path.dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (error) {
    try {
      await rm(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
    throw error
  }
}

/** Normalize a relative path for prefix matching (slashes, no `./`). */
export function normalizeRelPath(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
}

/** True when `file` equals or starts with `prefix` (SPEC: relative prefix). */
export function matchesPrefix(file, prefix) {
  const target = normalizeRelPath(file)
  const needle = normalizeRelPath(prefix)
  if (target === '' || needle === '') return false
  return target === needle || target.startsWith(needle)
}

/** `1.2k`-style compact number for the UI summary. */
export function formatCount(value) {
  const number = num(value)
  if (number >= 1e6) return `${Math.round(number / 1e5) / 10}m`
  if (number >= 1000) return `${Math.round(number / 100) / 10}k`
  return String(Math.trunc(number))
}

// ---------------------------------------------------------------------------
// Case validation (pure — used by the route and the tests)
// ---------------------------------------------------------------------------

function invalid(detail) {
  return { ok: false, error: 'invalid-case', detail }
}

/** Default display name from the first prompt line. */
export function nameFromPrompt(prompt) {
  const line = typeof prompt === 'string' ? prompt.split(/\r?\n/, 1)[0].trim() : ''
  const short = line.length > 60 ? `${line.slice(0, 57)}…` : line
  return short || 'Untitled case'
}

/**
 * Normalize and validate a full case field set (create or stored record).
 * Returns `{ok:true, value}` or `{ok:false, error:'invalid-case', detail}`.
 */
export function normalizeCaseFields(input) {
  if (!isObject(input)) return invalid('case')
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt === '') return invalid('prompt')
  if (prompt.length > MAX_PROMPT) return invalid('prompt')
  const rawName = typeof input.name === 'string' ? input.name.trim() : ''
  const name = rawName === '' ? nameFromPrompt(prompt) : rawName
  if (name.length > MAX_NAME) return invalid('name')
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  if (cwd === '' || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) return invalid('cwd')

  let provider = null
  let model = null
  if (input.provider !== undefined && input.provider !== null && input.provider !== '') {
    if (typeof input.provider !== 'string') return invalid('provider')
    provider = input.provider.trim()
    if (provider === '' || /\s/.test(provider) || provider.length > 160) return invalid('provider')
  }
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    if (typeof input.model !== 'string') return invalid('model')
    model = input.model.trim()
    if (model === '' || /\s/.test(model) || model.length > 200) return invalid('model')
  }
  if ((provider === null) !== (model === null)) return invalid('model')

  const assertions = normalizeAssertions(input.assertions)
  if (!assertions.ok) return assertions
  const value = { name, prompt, cwd, provider, model, assertions: assertions.value }
  if (typeof input.sourceSessionId === 'string' && input.sourceSessionId !== '') {
    value.sourceSessionId = input.sourceSessionId
  }
  return { ok: true, value }
}

/** Validate the assertions block; only known keys are kept. */
export function normalizeAssertions(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (!isObject(raw)) return invalid('assertions')
  const value = {}
  if (raw.testCommand !== undefined && raw.testCommand !== null && raw.testCommand !== '') {
    if (typeof raw.testCommand !== 'string') return invalid('testCommand')
    const command = raw.testCommand.trim()
    if (command === '' || command.length > MAX_TEST_COMMAND) return invalid('testCommand')
    value.testCommand = command
  }
  for (const key of ['forbiddenPaths', 'expectFiles']) {
    const entries = raw[key]
    if (entries === undefined || entries === null) continue
    if (!Array.isArray(entries)) return invalid(key)
    if (entries.length > MAX_PATH_ENTRIES) return invalid(key)
    const cleaned = []
    for (const entry of entries) {
      if (typeof entry !== 'string') return invalid(key)
      const trimmed = entry.trim()
      if (trimmed === '') continue
      if (trimmed.length > MAX_PATH_LENGTH) return invalid(key)
      const normalized = normalizeRelPath(trimmed)
      if (!cleaned.includes(normalized)) cleaned.push(normalized)
    }
    if (cleaned.length > 0) value[key] = cleaned
  }
  for (const key of ['maxSteps', 'maxTokens']) {
    const rawValue = raw[key]
    if (rawValue === undefined || rawValue === null || rawValue === '') continue
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
      return invalid(key)
    }
    if (rawValue === 0) continue
    if (rawValue > (key === 'maxSteps' ? 1e6 : 1e9)) return invalid(key)
    value[key] = rawValue
  }
  return { ok: true, value }
}

/**
 * Validate a create payload, or an update patch merged over the existing case.
 * For updates, only name/prompt/cwd/provider/model/assertions are considered.
 */
export function validateCaseFields(input, options = {}) {
  if (!isObject(input)) return invalid('case')
  if (options.mode !== 'update') return normalizeCaseFields(input)
  const base = isObject(options.base) ? options.base : null
  if (base === null) return invalid('case')
  const merged = {
    name: input.name === undefined ? base.name : input.name,
    prompt: input.prompt === undefined ? base.prompt : input.prompt,
    cwd: input.cwd === undefined ? base.cwd : input.cwd,
    provider: input.provider === undefined ? base.provider : input.provider,
    model: input.model === undefined ? base.model : input.model,
    assertions: input.assertions === undefined ? base.assertions : input.assertions,
  }
  return normalizeCaseFields(merged)
}

/** Build a persisted case record from validated fields. */
export function createCaseRecord(fields, options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const at = new Date(clock()).toISOString()
  const id = typeof options.id === 'string' && CASE_ID_PATTERN.test(options.id)
    ? options.id
    : shortId('case', options.randomUUID)
  const record = {
    id,
    name: fields.name,
    prompt: fields.prompt,
    cwd: fields.cwd,
    provider: fields.provider ?? null,
    model: fields.model ?? null,
    assertions: fields.assertions ?? {},
    sourceSessionId: typeof options.sourceSessionId === 'string' && options.sourceSessionId !== ''
      ? options.sourceSessionId
      : (typeof fields.sourceSessionId === 'string' ? fields.sourceSessionId : null),
    createdAt: at,
    updatedAt: at,
  }
  return record
}

// ---------------------------------------------------------------------------
// cases.json
// ---------------------------------------------------------------------------

/** Empty cases document. */
export const emptyCasesDocument = () => ({ version: CASES_VERSION, cases: [] })

/** Lenient parse of a stored case (corrupt entries are skipped). */
export function coerceStoredCase(raw) {
  if (!isObject(raw)) return null
  const checked = normalizeCaseFields(raw)
  if (!checked.ok) return null
  const id = typeof raw.id === 'string' && CASE_ID_PATTERN.test(raw.id) ? raw.id : null
  if (id === null) return null
  return {
    id,
    name: checked.value.name,
    prompt: checked.value.prompt,
    cwd: checked.value.cwd,
    provider: checked.value.provider,
    model: checked.value.model,
    assertions: checked.value.assertions,
    sourceSessionId: typeof raw.sourceSessionId === 'string' && raw.sourceSessionId !== '' ? raw.sourceSessionId : null,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt !== '' ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt !== '' ? raw.updatedAt : new Date(0).toISOString(),
  }
}

/** Parse a cases document; unknown versions/corruption fall back to empty. */
export function parseCasesDocument(raw) {
  if (!isObject(raw) || raw.version !== CASES_VERSION || !Array.isArray(raw.cases)) return emptyCasesDocument()
  const cases = []
  for (const entry of raw.cases) {
    const record = coerceStoredCase(entry)
    if (record !== null) cases.push(record)
    if (cases.length >= MAX_CASES) break
  }
  return { version: CASES_VERSION, cases }
}

/** Load `cases.json` (missing/corrupt → empty document). */
export async function loadCases(options = {}) {
  const raw = await readJsonFile(path.join(resolveHome(options), CASES_RELATIVE_PATH))
  return parseCasesDocument(raw)
}

/** Persist `cases.json` atomically. */
export async function persistCases(document, options = {}) {
  const cases = Array.isArray(document?.cases) ? document.cases.slice(0, MAX_CASES) : []
  await writeJsonAtomic(path.join(resolveHome(options), CASES_RELATIVE_PATH), { version: CASES_VERSION, cases })
  return { version: CASES_VERSION, cases }
}

/**
 * Add a validated case to a document (in-memory prepend + limit check).
 * Returns `{ok:true, doc, case}` or `{ok:false, error}`.
 */
export function addCaseRecord(document, fields, options = {}) {
  const doc = parseCasesDocument(document)
  if (doc.cases.length >= MAX_CASES) return { ok: false, error: 'limit-reached' }
  const record = createCaseRecord(fields, options)
  return { ok: true, doc: { version: CASES_VERSION, cases: [record, ...doc.cases] }, case: record }
}

/** Apply an allowed patch to one case. Returns `{ok:true, doc, case}` or `{ok:false,error,detail?}`. */
export function updateCaseRecord(document, id, patch, options = {}) {
  const doc = parseCasesDocument(document)
  const index = doc.cases.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: 'not-found' }
  const base = doc.cases[index]
  const checked = validateCaseFields(patch, { mode: 'update', base })
  if (!checked.ok) return checked
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const record = {
    ...base,
    ...checked.value,
    sourceSessionId: base.sourceSessionId,
    updatedAt: new Date(clock()).toISOString(),
  }
  const cases = doc.cases.slice()
  cases[index] = record
  return { ok: true, doc: { version: CASES_VERSION, cases }, case: record }
}

/** Remove one case. Returns `{ok:true, doc, case}` or `{ok:false,error:'not-found'}`. */
export function deleteCaseRecord(document, id) {
  const doc = parseCasesDocument(document)
  const index = doc.cases.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: 'not-found' }
  const cases = doc.cases.slice()
  const [removed] = cases.splice(index, 1)
  return { ok: true, doc: { version: CASES_VERSION, cases }, case: removed }
}

// ---------------------------------------------------------------------------
// runs.json
// ---------------------------------------------------------------------------

/** Empty runs document. */
export const emptyRunsDocument = () => ({ version: RUNS_VERSION, runs: [] })

/** Lenient parse of one stored run. */
export function coerceStoredRun(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.caseId !== 'string') return null
  const status = STATUSES.includes(raw.status) ? raw.status : 'error'
  const reason = REASONS.includes(raw.reason) ? raw.reason : 'agent-error'
  return {
    id: raw.id,
    caseId: raw.caseId,
    caseName: typeof raw.caseName === 'string' ? raw.caseName : '',
    at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
    durationMs: num(raw.durationMs),
    status,
    reason,
    steps: num(raw.steps),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    totalTokens: num(raw.totalTokens) || num(raw.inputTokens) + num(raw.outputTokens),
    changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles.filter((entry) => typeof entry === 'string') : [],
    testExit: raw.testExit === 0 ? 0 : raw.testExit === 1 ? 1 : null,
    testOutputTail: typeof raw.testOutputTail === 'string' ? raw.testOutputTail : '',
    worktree: typeof raw.worktree === 'string' && raw.worktree !== '' ? raw.worktree : null,
    ...(typeof raw.error === 'string' && raw.error !== '' ? { error: raw.error } : {}),
  }
}

/** Parse a runs document; newest first, capped at {@link MAX_RUNS}. */
export function parseRunsDocument(raw) {
  if (!isObject(raw) || raw.version !== RUNS_VERSION || !Array.isArray(raw.runs)) return emptyRunsDocument()
  const runs = []
  for (const entry of raw.runs) {
    const run = coerceStoredRun(entry)
    if (run !== null) runs.push(run)
    if (runs.length >= MAX_RUNS) break
  }
  return { version: RUNS_VERSION, runs }
}

/** Load `runs.json`. */
export async function loadRuns(options = {}) {
  const raw = await readJsonFile(path.join(resolveHome(options), RUNS_RELATIVE_PATH))
  return parseRunsDocument(raw)
}

/** Persist `runs.json` atomically. */
export async function persistRuns(document, options = {}) {
  const runs = Array.isArray(document?.runs) ? document.runs.slice(0, MAX_RUNS) : []
  await writeJsonAtomic(path.join(resolveHome(options), RUNS_RELATIVE_PATH), { version: RUNS_VERSION, runs })
  return { version: RUNS_VERSION, runs }
}

/** Prepend one run to `runs.json` (retention: newest 50). */
export async function appendRun(run, options = {}) {
  const document = parseRunsDocument(await readJsonFile(path.join(resolveHome(options), RUNS_RELATIVE_PATH)))
  const runs = [run, ...document.runs].slice(0, MAX_RUNS)
  await persistRuns({ version: RUNS_VERSION, runs }, options)
  return run
}

// ---------------------------------------------------------------------------
// Projection cache: recent sessions for "create from session"
// ---------------------------------------------------------------------------

const rowValue = (rows, key) => (isObject(rows[key]) ? rows[key].val : undefined)

/**
 * Extract the small session sample shown by `GET report`.
 * Unknown/corrupt shapes return `null` (caller skips it).
 */
export function extractSessionSample(raw, fileName = '') {
  if (!isObject(raw) || !isObject(raw.record)) return null
  const record = raw.record
  const rows = isObject(record.rows) ? record.rows : {}
  const identity = isObject(record.identity) ? record.identity : {}
  const id = typeof fileName === 'string' ? fileName.replace(/\.json$/i, '') : ''
  if (!isValidSessionId(id)) return null
  const title = firstText(rowValue(rows, 'title'))
  const titleInput = rowValue(rows, 'titleInput')
  const outline = rowValue(rows, 'turnOutline')
  const firstTurn = isObject(outline) && Array.isArray(outline.turns) ? outline.turns[0] : undefined
  const prompt = firstText(
    isObject(titleInput) && isObject(titleInput.first) ? titleInput.first.text : undefined,
    isObject(firstTurn) ? firstTurn.prompt : undefined,
    title,
  )
  const cwd = firstText(rowValue(rows, 'workingDirectory'), identity.cwd)
  if (prompt === undefined || cwd === undefined) return null
  const selection = rowValue(rows, 'modelSelection')
  const lastUsed = isObject(selection) && isObject(selection.lastUsed) ? selection.lastUsed : null
  const stats = rowValue(rows, 'sessionStats')
  const meta = rowValue(rows, 'sessionListMetadata')
  const at = num(isObject(meta) ? meta.lastPromptAt : undefined) || num(identity.createdAt)
  return {
    id,
    title: title ?? prompt.slice(0, 60),
    prompt,
    cwd,
    provider: lastUsed !== null && typeof lastUsed.provider === 'string' ? lastUsed.provider : null,
    model: lastUsed !== null && typeof lastUsed.model === 'string' ? lastUsed.model : null,
    steps: num(isObject(stats) ? stats.steps : undefined),
    at: at > 0 ? at : 0,
  }
}

function isValidSessionId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{3,80}$/i.test(value)
}

/** Match a session by projection basename or `session-<basename>`. */
export function sessionIdMatches(candidate, wanted) {
  if (typeof candidate !== 'string' || typeof wanted !== 'string') return false
  if (candidate === wanted) return true
  return candidate === wanted.replace(/^session-/, '') || `session-${candidate}` === wanted
}

/**
 * Incremental projection-cache scanner.
 *
 * Keyed by path + size + mtimeMs, so repeat reports only `stat` the files and
 * reuse the parsed sample (SPEC §3.1.3: no full scan per request).
 */
export function createSessionReader(options = {}) {
  const cache = new Map()
  const home = typeof options.home === 'function' ? options.home : () => resolveHome(options)
  return {
    /** Most recent sessions, newest first, capped at `limit`. */
    async list(limit = MAX_SESSIONS) {
      const dir = path.join(home(), PROJCACHE_RELATIVE_PATH)
      let names = []
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const next = new Map()
      const samples = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(dir, name)
        let info = null
        try {
          info = await stat(file)
        } catch {
          continue
        }
        if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) continue
        const cached = cache.get(file)
        let sample = null
        if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
          sample = cached.sample
        } else {
          const raw = await readJsonFile(file)
          sample = raw === null ? null : extractSessionSample(raw, name)
        }
        if (sample === null) continue
        next.set(file, { size: info.size, mtimeMs: info.mtimeMs, sample })
        samples.push(sample)
      }
      cache.clear()
      for (const [file, entry] of next) cache.set(file, entry)
      samples.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
      return samples.slice(0, Math.max(1, num(limit) || MAX_SESSIONS))
    },
    /** Look up one sample among the (cached) recent sessions. */
    async find(sessionId) {
      const samples = await this.list(MAX_CASES)
      return samples.find((sample) => sessionIdMatches(sample.id, sessionId)) ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// Run helpers: subprocess adapter, git parsing, metrics, assertions
// ---------------------------------------------------------------------------

/** Read captured output from a subprocess result/handle, defensively. */
function readCaptured(result, handle, name) {
  const candidates = [
    isObject(result) && isObject(result.collected) ? result.collected[name] : undefined,
    isObject(result) ? result[name] : undefined,
    isObject(handle) && isObject(handle.collected) ? handle.collected[name] : undefined,
    isObject(handle) ? handle[name] : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    if (typeof candidate === 'string' || Buffer.isBuffer(candidate)) return toText(candidate)
    if (typeof candidate.readFrom === 'function') {
      try {
        return toText(candidate.readFrom(0))
      } catch {
        /* fall through */
      }
    }
    if (typeof candidate.toString === 'function') {
      const text = toText(candidate)
      if (text !== '') return text
    }
  }
  return ''
}

/**
 * Await a `ctx.subprocess.spawn()` handle across DSH versions.
 * Supports `handle.done`, `handle.wait()` and a plain `exitCode` field.
 */
export async function waitSubprocess(handle) {
  if (!isObject(handle)) throw new Error('subprocess.spawn returned no handle')
  let result = null
  if (handle.done !== undefined && handle.done !== null) {
    result = await handle.done
  } else if (typeof handle.wait === 'function') {
    result = await handle.wait()
  } else if (typeof handle.exitCode === 'number' || handle.exitCode === null) {
    result = {}
  } else {
    throw new Error('unsupported subprocess handle (no done/wait/exitCode)')
  }
  const candidates = [
    isObject(result) ? result.exitCode : undefined,
    isObject(result) ? result.code : undefined,
    handle.exitCode,
  ]
  let exitCode = 1
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      exitCode = candidate
      break
    }
  }
  return {
    exitCode,
    stdout: readCaptured(result, handle, 'stdout'),
    stderr: readCaptured(result, handle, 'stderr'),
  }
}

/**
 * Default command runner over `ctx.subprocess`.
 *
 * `run(argv)` resolves argv[0] with `resolveExecutable` and spawns directly
 * (git); `shell(command)` spawns `sh -c` (`cmd.exe /d /s /c` on win32).
 */
export function createSubprocessRunner(subprocess, options = {}) {
  const platform = options.platform ?? process.platform
  const spawn = (argv, argvCwd, maxBytes) => {
    const handle = subprocess.spawn({
      argv,
      cwd: argvCwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: 5000,
    })
    return waitSubprocess(handle)
  }
  return {
    async run(argv, runOptions = {}) {
      if (!Array.isArray(argv) || argv.length === 0) throw new Error('run(argv) requires argv')
      const exe = await subprocess.resolveExecutable(argv[0])
      return spawn([exe, ...argv.slice(1)], runOptions.cwd, runOptions.maxBytes ?? 256 * 1024)
    },
    async shell(command, shellOptions = {}) {
      const windows = platform === 'win32'
      const exe = await subprocess.resolveExecutable(windows ? 'cmd.exe' : 'sh')
      const argv = windows ? [exe, '/d', '/s', '/c', command] : [exe, '-c', command]
      return spawn(argv, shellOptions.cwd, shellOptions.maxBytes ?? 256 * 1024)
    },
  }
}

/** Strip one layer of C-style quoting from a porcelain path. */
function unquotePorcelain(raw) {
  let value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
    try {
      value = JSON.parse(`"${value.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')}"`)
    } catch {
      /* keep the raw inner text when it is not a valid escape sequence */
    }
  }
  return value
}

/**
 * Parse `git status --porcelain` into unique relative paths.
 * Handles renames (`old -> new`), quoting and deletions (SPEC §3.5).
 */
export function parsePorcelain(text) {
  const files = []
  const seen = new Set()
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : []
  for (const line of lines) {
    if (line.length < 4) continue
    let payload = line.slice(3)
    if (payload.trim() === '') continue
    const arrow = payload.lastIndexOf(' -> ')
    if (arrow >= 0) payload = payload.slice(arrow + 4)
    const normalized = normalizeRelPath(unquotePorcelain(payload))
    if (normalized === '' || seen.has(normalized)) continue
    seen.add(normalized)
    files.push(normalized)
  }
  return files
}

/** Aggregate steps and token usage from a session's events. */
export function collectMetrics(events) {
  const list = Array.isArray(events) ? events : []
  let steps = 0
  /** step key -> {input, output, fromMessage} */
  const perStep = new Map()
  for (const event of list) {
    if (!isObject(event)) continue
    if (event.type === 'step/start') {
      steps += 1
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const data = isObject(event.data) ? event.data : {}
    const usage = resolveUsage(data)
    if (usage === null) continue
    const key = `${num(data.turn)}:${num(data.step)}:${event.type}`
    const current = perStep.get(key)
    const fromMessage = event.type === 'assistant/message'
    // Replacement semantics: a retried attempt/message overwrites the slot.
    if (current === undefined || fromMessage || !current.fromMessage) {
      perStep.set(key, {
        input: Math.max(current?.input ?? 0, usage.input),
        output: Math.max(current?.output ?? 0, usage.output),
        fromMessage: fromMessage || (current?.fromMessage ?? false),
      })
    }
  }
  let inputTokens = 0
  let outputTokens = 0
  const messageKeys = new Set()
  for (const [key, entry] of perStep) {
    if (entry.fromMessage) messageKeys.add(key.replace(/:assistant\/message$/, ''))
  }
  for (const [key, entry] of perStep) {
    const base = key.replace(/:assistant\/(message|attempt)$/, '')
    if (!entry.fromMessage && messageKeys.has(base)) continue // message wins over attempts
    inputTokens += entry.input
    outputTokens += entry.output
  }
  return { steps, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

/** Pull `{input, output}` usage out of an event data block (defensive shapes). */
function resolveUsage(data) {
  const direct = isObject(data.usage) ? data.usage : null
  if (direct !== null) {
    const input = num(direct.inputTokens ?? direct.input)
    const output = num(direct.outputTokens ?? direct.output)
    if (input > 0 || output > 0) return { input, output }
  }
  const message = isObject(data.message) && isObject(data.message.usage) ? data.message.usage : null
  if (message !== null) {
    const input = num(message.inputTokens ?? message.input)
    const output = num(message.outputTokens ?? message.output)
    if (input > 0 || output > 0) return { input, output }
  }
  return null
}

/**
 * Evaluate the deterministic assertions (SPEC §3.6).
 * `result` = `{changedFiles, steps, totalTokens, testExit}`.
 * Returns `{status, reason}` — first failure in spec order, else passed/ok.
 */
export function evaluateAssertions(result, assertions) {
  const outcome = isObject(result) ? result : {}
  const rules = isObject(assertions) ? assertions : {}
  const changedFiles = Array.isArray(outcome.changedFiles) ? outcome.changedFiles : []
  const forbidden = Array.isArray(rules.forbiddenPaths) ? rules.forbiddenPaths : []
  for (const file of changedFiles) {
    for (const prefix of forbidden) {
      if (matchesPrefix(file, prefix)) return { status: 'failed', reason: 'forbidden-path', detail: file }
    }
  }
  const expected = Array.isArray(rules.expectFiles) ? rules.expectFiles : []
  if (expected.length > 0) {
    const hit = changedFiles.some((file) => expected.some((prefix) => matchesPrefix(file, prefix)))
    if (!hit) return { status: 'failed', reason: 'expect-file-missing' }
  }
  const maxSteps = num(rules.maxSteps)
  if (maxSteps > 0 && num(outcome.steps) > maxSteps) return { status: 'failed', reason: 'max-steps' }
  const maxTokens = num(rules.maxTokens)
  if (maxTokens > 0 && num(outcome.totalTokens) > maxTokens) return { status: 'failed', reason: 'max-tokens' }
  if (typeof rules.testCommand === 'string' && rules.testCommand !== '' && outcome.testExit !== 0) {
    return { status: 'failed', reason: 'test-failed' }
  }
  return { status: 'passed', reason: 'ok' }
}

// ---------------------------------------------------------------------------
// Run orchestration (dependency injected)
// ---------------------------------------------------------------------------

/** Extract the events array from whatever `sessionQuery.readSession` returns. */
export function eventsOf(session) {
  if (Array.isArray(session)) return session
  if (isObject(session) && Array.isArray(session.events)) return session.events
  if (isObject(session) && Array.isArray(session.data)) return session.data
  return []
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'case'
}

/**
 * Replay one case in a throwaway git worktree with a fresh DSH agent.
 *
 * @param args.case - persisted case record.
 * @param args.deps - `{agents, subprocess, sessionQuery, runCommand?, runShell?,
 *   home?, tmpDir?, now?, randomUUID?}`; missing services produce a
 *   `service-unavailable` run instead of a rejection.
 * @returns the run record (also appended to `runs.json`).
 */
export async function runCase(args = {}) {
  const testCase = isObject(args.case) ? args.case : null
  const deps = isObject(args.deps) ? args.deps : {}
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const uuid = typeof deps.randomUUID === 'function' ? deps.randomUUID : randomUUID
  const startedAt = clock()
  const run = {
    id: shortId('run', uuid),
    caseId: testCase !== null && typeof testCase.id === 'string' ? testCase.id : '',
    caseName: testCase !== null && typeof testCase.name === 'string' ? testCase.name : '',
    at: new Date(startedAt).toISOString(),
    durationMs: 0,
    status: 'error',
    reason: 'agent-error',
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    changedFiles: [],
    testExit: null,
    testOutputTail: '',
    worktree: null,
  }

  /** Persist the run and return it; persistence failures are recorded, not thrown. */
  const finish = async () => {
    run.durationMs = Math.max(0, clock() - startedAt)
    try {
      await appendRun(run, { home: deps.home })
    } catch (error) {
      run.error = run.error === undefined
        ? `runs.json write failed: ${errorMessage(error)}`
        : `${run.error}; runs.json write failed: ${errorMessage(error)}`
    }
    return run
  }

  if (testCase === null || run.caseId === '') {
    run.error = 'invalid case record'
    return finish()
  }

  const missing = ['agents', 'subprocess', 'sessionQuery'].filter((name) => !deps[name])
  if (missing.length > 0) {
    run.reason = 'service-unavailable'
    run.error = `missing services: ${missing.join(', ')}`
    return finish()
  }

  const runner = {
    run: typeof deps.runCommand === 'function' ? deps.runCommand : createSubprocessRunner(deps.subprocess).run,
    shell: typeof deps.runShell === 'function' ? deps.runShell : createSubprocessRunner(deps.subprocess).shell,
  }

  let worktree = null
  let handle = null
  let worktreeCreated = false
  let removed = false
  const assertions = isObject(testCase.assertions) ? testCase.assertions : {}

  try {
    const baseDir = path.join(typeof deps.tmpDir === 'string' && deps.tmpDir !== '' ? deps.tmpDir : tmpdir(), WORKTREE_ROOT)
    try {
      await mkdir(baseDir, { recursive: true })
    } catch {
      /* the git command below reports the real failure */
    }
    worktree = path.join(baseDir, `case-${sanitizePathSegment(testCase.id)}-${startedAt}`)

    // --- 3. isolated worktree -------------------------------------------
    let add = null
    try {
      add = await runner.run(['git', '-C', testCase.cwd, 'worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: testCase.cwd })
    } catch (error) {
      add = { exitCode: 1, stdout: '', stderr: errorMessage(error) }
    }
    if (num(add.exitCode) !== 0) {
      run.reason = 'no-git'
      run.error = tailText(add.stderr || add.stdout || 'git worktree add failed', 1000)
      return finish()
    }
    worktreeCreated = true

    // --- 4. fresh agent in the worktree --------------------------------
    const sessionId = `session-${uuid()}`
    let agentFailed = false
    try {
      handle = await deps.agents.create({
        sessionId,
        meta: { cwd: worktree },
        agentOptions: testCase.provider && testCase.model
          ? { provider: testCase.provider, model: testCase.model }
          : {},
      })
      if (!isObject(handle) || !isObject(handle.agent)) throw new Error('agents.create returned no agent handle')
      await handle.agent.followup({ content: [{ type: 'text', text: testCase.prompt }], source: { kind: 'user' } })
      await handle.agent.whenIdle()
    } catch (error) {
      agentFailed = true
      run.reason = 'agent-error'
      run.error = errorMessage(error)
    }

    // --- 5. metrics (read BEFORE dispose; dispose drops the session) ----
    if (!agentFailed) {
      let events = []
      try {
        events = eventsOf(await deps.sessionQuery.readSession(sessionId))
      } catch {
        events = []
      }
      if (events.length === 0 && isObject(handle) && isObject(handle.agent)) {
        try {
          const snapshot = handle.agent.session?.snapshotEvents?.(0)
          events = eventsOf(typeof snapshot?.then === 'function' ? await snapshot : snapshot)
        } catch {
          events = []
        }
      }
      const metrics = collectMetrics(events)
      run.steps = metrics.steps
      run.inputTokens = metrics.inputTokens
      run.outputTokens = metrics.outputTokens
      run.totalTokens = metrics.totalTokens

      // --- 5b. changed files ------------------------------------------
      let status = null
      try {
        status = await runner.run(['git', '-C', worktree, 'status', '--porcelain'], { cwd: worktree })
      } catch {
        status = { exitCode: 1, stdout: '', stderr: '' }
      }
      run.changedFiles = parsePorcelain(num(status.exitCode) === 0 ? status.stdout : '')

      // --- 6. deterministic assertions --------------------------------
      const structural = evaluateAssertions(
        { changedFiles: run.changedFiles, steps: run.steps, totalTokens: run.totalTokens, testExit: null },
        { ...assertions, testCommand: undefined },
      )
      let verdict = structural
      if (verdict.reason === 'ok') {
        if (typeof assertions.testCommand === 'string' && assertions.testCommand !== '') {
          try {
            const tested = await runner.shell(assertions.testCommand, { cwd: worktree })
            run.testExit = num(tested.exitCode) === 0 ? 0 : 1
            run.testOutputTail = tailText(`${tested.stdout ?? ''}${tested.stderr ?? ''}`)
          } catch (error) {
            run.testExit = 1
            run.testOutputTail = tailText(`test command failed to start: ${errorMessage(error)}`)
          }
        }
        verdict = evaluateAssertions(
          { changedFiles: run.changedFiles, steps: run.steps, totalTokens: run.totalTokens, testExit: run.testExit },
          assertions,
        )
      }
      run.status = verdict.status
      run.reason = verdict.reason
    }
  } catch (error) {
    run.status = 'error'
    run.reason = 'agent-error'
    run.error = errorMessage(error)
  } finally {
    // --- 7. cleanup: worktree first, then dispose the agent -------------
    if (worktreeCreated) {
      try {
        const removedResult = await runner.run(
          ['git', '-C', (testCase && testCase.cwd) || '.', 'worktree', 'remove', '--force', worktree],
          { cwd: (testCase && testCase.cwd) || '.' },
        )
        removed = num(removedResult.exitCode) === 0
      } catch {
        removed = false
      }
      if (!removed) run.worktree = worktree
    }
    if (handle !== null) {
      try {
        if (typeof handle.dispose === 'function') await handle.dispose()
      } catch (error) {
        run.error = run.error === undefined
          ? `dispose failed: ${errorMessage(error)}`
          : `${run.error}; dispose failed: ${errorMessage(error)}`
      }
    }
  }

  return finish()
}

// ---------------------------------------------------------------------------
// Single-concurrency run controller
// ---------------------------------------------------------------------------

/**
 * Single-flight runner shared by the route: `run()` returns
 * `{ok:false, error:'run-in-progress'}` while another case is running.
 */
export function createRunController(options = {}) {
  const getDeps = typeof options.deps === 'function' ? options.deps : () => (isObject(options.deps) ? options.deps : {})
  let current = null
  return {
    /** `{running, caseId?}` for GET report. */
    status() {
      return current === null ? { running: false } : { running: true, caseId: current.caseId }
    },
    async run(testCase, extraDeps = {}) {
      if (current !== null) return { ok: false, error: 'run-in-progress' }
      current = { caseId: testCase?.id ?? '' }
      try {
        const deps = { ...getDeps(), ...extraDeps }
        if (options.home !== undefined) deps.home = typeof options.home === 'function' ? options.home() : options.home
        const run = await runCase({ case: testCase, deps })
        return { ok: true, run }
      } finally {
        current = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

function sendJson(response, statusCode, payload, headOnly = false) {
  const body = JSON.stringify(payload)
  try {
    if (response !== null && response !== undefined && typeof response.writeHead === 'function') {
      response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      if (typeof response.end === 'function') response.end(headOnly ? undefined : body)
    }
  } catch {
    /* the socket may already be gone */
  }
}

/** Read+parse a JSON request body with a 1 MiB cap. */
export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'body-too-large' }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, status: 400, error: 'invalid-body' }
  }
  if (chunks.length === 0) return { ok: false, status: 400, error: 'invalid-json' }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!isObject(value)) return { ok: false, status: 400, error: 'invalid-json' }
    return { ok: true, value }
  } catch {
    return { ok: false, status: 400, error: 'invalid-json' }
  }
}

const POST_FIELDS = ['name', 'prompt', 'cwd', 'provider', 'model', 'assertions']

function pickDefined(source, keys) {
  const picked = {}
  for (const key of keys) {
    if (source !== null && source !== undefined && source[key] !== undefined) picked[key] = source[key]
  }
  return picked
}

/**
 * Build the `/dsh-agent-ci/api` handler.
 *
 * `options`: `{home | home(), sessionReader, controller, getDeps, now}`. All of
 * them are seams for the unit tests; DSH only supplies `getDeps` (from apply).
 */
export function createRequestHandler(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const home = typeof options.home === 'function' ? options.home : () => (typeof options.home === 'string' ? options.home : resolveHome())
  const reader = options.sessionReader ?? createSessionReader({ home })
  const controller = options.controller ?? createRunController({
    home,
    deps: typeof options.getDeps === 'function' ? options.getDeps : () => ({}),
  })

  return async function handleRequest(request, response) {
    let method = 'GET'
    try {
      method = String(request?.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' }, method === 'HEAD')
        return
      }
      const url = new URL(String(request?.url ?? ROUTE), 'http://localhost')
      const action = url.searchParams.get('action') ?? ''

      if (method !== 'POST') {
        if (action === 'report') {
          const [cases, runs, sessions] = await Promise.all([
            loadCases({ home: home() }),
            loadRuns({ home: home() }),
            reader.list(MAX_SESSIONS).catch(() => []),
          ])
          sendJson(response, 200, {
            ok: true,
            generatedAt: new Date(clock()).toISOString(),
            cases: cases.cases,
            runs: runs.runs,
            sessions,
            status: controller.status(),
          }, method === 'HEAD')
          return
        }
        if (action === 'case') {
          const id = url.searchParams.get('id') ?? ''
          const document = await loadCases({ home: home() })
          const found = document.cases.find((entry) => entry.id === id)
          if (found === undefined) {
            sendJson(response, 404, { ok: false, error: 'not-found' }, method === 'HEAD')
            return
          }
          sendJson(response, 200, { ok: true, case: found }, method === 'HEAD')
          return
        }
        sendJson(response, 400, { ok: false, error: 'unknown-action' }, method === 'HEAD')
        return
      }

      const parsed = await readJsonBody(request)
      if (!parsed.ok) {
        sendJson(response, parsed.status, { ok: false, error: parsed.error })
        return
      }
      const payload = parsed.value
      const requested = typeof payload.action === 'string' ? payload.action : action

      if (requested === 'create') {
        const fields = isObject(payload.fields) ? payload.fields : payload
        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : null
        let prefill = {}
        if (sessionId !== null) {
          const sample = await reader.find(sessionId)
          if (sample === null) {
            sendJson(response, 400, { ok: false, error: 'invalid-case', detail: 'session-not-found' })
            return
          }
          prefill = {
            prompt: sample.prompt,
            cwd: sample.cwd,
            provider: sample.provider,
            model: sample.model,
            name: sample.title,
          }
        }
        const merged = { ...prefill, ...pickDefined(fields, POST_FIELDS) }
        const checked = validateCaseFields(merged)
        if (!checked.ok) {
          sendJson(response, 400, checked)
          return
        }
        const document = await loadCases({ home: home() })
        const added = addCaseRecord(document, checked.value, { now: clock, sourceSessionId: sessionId })
        if (!added.ok) {
          sendJson(response, 400, { ok: false, error: added.error })
          return
        }
        await persistCases(added.doc, { home: home() })
        sendJson(response, 200, { ok: true, case: added.case })
        return
      }

      if (requested === 'update') {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const patch = isObject(payload.patch) ? payload.patch : (isObject(payload.fields) ? payload.fields : {})
        const document = await loadCases({ home: home() })
        const updated = updateCaseRecord(document, id, pickDefined(patch, POST_FIELDS), { now: clock })
        if (!updated.ok) {
          const status = updated.error === 'not-found' ? 404 : 400
          sendJson(response, status, updated)
          return
        }
        await persistCases(updated.doc, { home: home() })
        sendJson(response, 200, { ok: true, case: updated.case })
        return
      }

      if (requested === 'delete') {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const document = await loadCases({ home: home() })
        const deleted = deleteCaseRecord(document, id)
        if (!deleted.ok) {
          sendJson(response, 404, deleted)
          return
        }
        await persistCases(deleted.doc, { home: home() })
        sendJson(response, 200, { ok: true, deleted: true, id })
        return
      }

      if (requested === 'run') {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const document = await loadCases({ home: home() })
        const found = document.cases.find((entry) => entry.id === id)
        if (found === undefined) {
          sendJson(response, 404, { ok: false, error: 'not-found' })
          return
        }
        const result = await controller.run(found)
        if (!result.ok) {
          sendJson(response, 409, { ok: false, error: result.error })
          return
        }
        sendJson(response, 200, { ok: true, run: result.run })
        return
      }

      sendJson(response, 400, { ok: false, error: 'unknown-action' })
    } catch (error) {
      try {
        sendJson(response, 500, { ok: false, error: 'internal', detail: errorMessage(error) }, method === 'HEAD')
      } catch {
        /* the handler must never throw into the web server */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function warnContext(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    /* logging must never break activation */
  }
}

/** Resolve an optional host service without letting a proxy throw. */
function serviceValue(source, name) {
  try {
    const direct = source?.[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    /* a cordis proxy may throw for an unknown service */
  }
  try {
    if (typeof source?.get === 'function') return source.get(name)
  } catch {
    /* service not ready */
  }
  return undefined
}

/** Lazy dependency object handed to {@link runCase} at request time. */
export function createServiceResolver(ctx, options = {}) {
  const override = isObject(options.deps) ? { ...options.deps } : {}
  let hostCtx = null
  const resolve = () => {
    const deps = { ...override }
    for (const name of ['agents', 'subprocess', 'sessionQuery']) {
      if (deps[name] !== undefined && deps[name] !== null) continue
      const value = serviceValue(hostCtx, name) ?? serviceValue(ctx, name)
      if (value !== undefined && value !== null) deps[name] = value
    }
    return deps
  }
  resolve.attachHost = (value) => { hostCtx = value }
  return resolve
}

/**
 * Register the API route. Never throws: every failure is a warning.
 * The route itself reports `service-unavailable` for missing run services.
 */
export function apply(ctx, options = {}) {
  const safeOptions = isObject(options) ? options : {}
  try {
    const home = typeof safeOptions.home === 'function'
      ? safeOptions.home
      : () => (typeof safeOptions.home === 'string' ? safeOptions.home : resolveHome())
    const resolveServices = typeof safeOptions.getDeps === 'function'
      ? safeOptions.getDeps
      : createServiceResolver(ctx, safeOptions)
    const reader = safeOptions.sessionReader ?? createSessionReader({ home })
    const controller = safeOptions.controller ?? createRunController({ home, deps: resolveServices })
    const handler = createRequestHandler({
      ...safeOptions,
      home,
      sessionReader: reader,
      controller,
      getDeps: resolveServices,
    })

    if (ctx === null || ctx === undefined || typeof ctx.inject !== 'function') {
      warnContext(ctx, 'agent-ci: context has no inject(); API route not registered')
      return
    }
    ctx.inject(['webServer'], (hostCtx) => {
      try {
        if (typeof resolveServices.attachHost === 'function') resolveServices.attachHost(hostCtx)
        const effect = typeof hostCtx?.effect === 'function' ? hostCtx.effect.bind(hostCtx) : null
        const register = () => {
          try {
            if (!hostCtx?.webServer || typeof hostCtx.webServer.register !== 'function') {
              warnContext(ctx, 'agent-ci: webServer service unavailable; API route not registered')
              return () => {}
            }
            return hostCtx.webServer.register({ kind: 'exact', path: ROUTE, handler })
          } catch (error) {
            warnContext(ctx, `agent-ci: API route registration failed: ${errorMessage(error)}`)
            return () => {}
          }
        }
        if (effect === null) {
          warnContext(ctx, 'agent-ci: host context lacks effect(); API route not registered')
          register()
          return
        }
        effect(register, 'agent-ci: api route')
      } catch (error) {
        warnContext(ctx, `agent-ci: API route setup failed: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    warnContext(ctx, `agent-ci: activation failed: ${errorMessage(error)}`)
  }
}
