/**
 * Host-half tests for @ruaibeite/dsh-agent-ci.
 *
 * Plain Node (`node test/host.mjs`), zero dependencies, no Harness process, no
 * model and no browser. Every test that writes uses a `mkdtemp` home, so the
 * real `$DSH_HOME` is never touched. The run pipeline is exercised through its
 * dependency-injection seam with fake `agents` / `subprocess` / `sessionQuery`
 * services; the route tests use fake `req`/`res` recorders.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as host from '../index.js'

const {
  MAX_CASES,
  MAX_RUNS,
  ROUTE,
  addCaseRecord,
  appendRun,
  apply,
  coerceStoredCase,
  collectMetrics,
  createCaseRecord,
  createRequestHandler,
  createRunController,
  createSessionReader,
  createSubprocessRunner,
  deleteCaseRecord,
  evaluateAssertions,
  emptyDraft,
  extractSessionSample,
  formatCount,
  loadCases,
  loadRuns,
  matchesPrefix,
  normalizeCaseFields,
  parseCasesDocument,
  parsePorcelain,
  parseRunsDocument,
  persistCases,
  runCase,
  updateCaseRecord,
  sessionIdMatches,
  shortId,
  validateCaseFields,
  waitSubprocess,
  writeJsonAtomic,
  CASES_RELATIVE_PATH,
  RUNS_RELATIVE_PATH,
  PROJCACHE_RELATIVE_PATH,
} = host

// Tiny harness (same style as the sibling plugin host tests).
let passed = 0
const failures = []
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL -', name)
    console.log(error && error.stack ? error.stack : String(error))
  }
}
const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

// ------------------------------------------------------------- temp homes
const tempDirs = []
async function makeHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-test-'))
  tempDirs.push(dir)
  return dir
}
async function cleanupTemps() {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

// --------------------------------------------------------- HTTP recording
function makeRequest(method, url, options = {}) {
  const chunks = []
  if (options.rawBody !== undefined) chunks.push(Buffer.from(options.rawBody))
  else if (options.body !== undefined) chunks.push(Buffer.from(JSON.stringify(options.body)))
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const response = { statusCode: 0, headers: null, body: '' }
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode
    response.headers = headers
    return response
  }
  response.end = (data) => {
    if (data !== undefined) response.body += String(data)
  }
  response.payload = () => (response.body === '' ? null : JSON.parse(response.body))
  return response
}

async function call(handler, method, url, options = {}) {
  const response = makeResponse()
  await handler(makeRequest(method, url, options), response)
  return { status: response.statusCode, headers: response.headers, body: response.payload() }
}

const apiUrl = (query) => `${ROUTE}?${query}`
const post = (handler, body) => call(handler, 'POST', ROUTE, { body })

// ------------------------------------------------------- projection fixtures
function projectionFixture(options = {}) {
  const at = options.at ?? 1700000000000
  return {
    version: 7,
    record: {
      identity: { formatVersion: 7, createdAt: options.createdAt ?? at, cwd: options.cwd ?? '/work/repo', isSeeded: false, inheritedEventCount: 0 },
      rows: {
        title: { ver: 1, seq: 1, val: options.title ?? 'Fixture session' },
        titleInput: { ver: 1, seq: 1, val: { first: { seq: 1, text: options.prompt ?? 'fix the bug' }, count: 1, lastSeq: 1 } },
        workingDirectory: { ver: 1, seq: 1, val: options.cwd ?? '/work/repo' },
        sessionStats: { ver: 1, seq: 1, val: { turns: 1, steps: options.steps ?? 3 } },
        modelSelection: { ver: 1, seq: 1, val: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }, pending: null } },
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: options.at ?? at } },
      },
    },
  }
}

async function seedProjection(home, name, value) {
  const dir = path.join(home, PROJCACHE_RELATIVE_PATH)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  await writeFile(file, JSON.stringify(value), 'utf8')
  return file
}

// ------------------------------------------------------- fake run services
/** Events used by the fake `sessionQuery`: 2 steps, one assistant message. */
const SAMPLE_EVENTS = [
  { type: 'step/start', data: {} },
  { type: 'step/start', data: {} },
  { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } },
  { type: 'assistant/message', data: { turn: 2, step: 2, usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } } },
]

function createFakeServices(options = {}) {
  const calls = {
    create: [], followup: [], whenIdle: 0, dispose: 0, readSession: [], runCommand: [], runShell: [],
  }
  const idle = options.idle
  const services = {
    agents: {
      async create(createOptions) {
        calls.create.push(createOptions)
        if (options.createError) throw new Error('create blew up')
        return {
          agent: {
            async followup(payload) { calls.followup.push(payload) },
            async whenIdle() { calls.whenIdle += 1; if (typeof idle === 'function') await idle() },
            session: { snapshotEvents: () => [] },
          },
          async dispose() { calls.dispose += 1 },
        }
      },
    },
    subprocess: {
      async resolveExecutable(name) { return `/usr/bin/${name}` },
      spawn() { throw new Error('fake subprocess.spawn should not be used when runCommand/runShell are injected') },
    },
    sessionQuery: {
      async readSession(id) {
        calls.readSession.push(id)
        if (options.readSessionError) throw new Error('readSession blew up')
        return { session: { id }, inheritedEventCount: 0, events: options.events ?? SAMPLE_EVENTS }
      },
    },
    runCommand: async (argv, runOptions = {}) => {
      calls.runCommand.push({ argv, cwd: runOptions.cwd })
      if (options.runCommand) return options.runCommand(argv, runOptions)
      if (argv.includes('add')) return { exitCode: 0, stdout: '', stderr: '' }
      if (argv.includes('status')) return { exitCode: 0, stdout: options.statusOutput ?? ' M src/a.ts\n?? docs/new.md\n', stderr: '' }
      if (argv.includes('remove')) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    runShell: async (command, runOptions = {}) => {
      calls.runShell.push({ command, cwd: runOptions.cwd })
      if (options.runShell) return options.runShell(command, runOptions)
      return { exitCode: 0, stdout: 'all good', stderr: '' }
    },
  }
  return { services, calls }
}

function makeCase(options = {}) {
  return createCaseRecord({
    name: options.name ?? 'Fix redirect',
    prompt: options.prompt ?? 'fix the login redirect',
    cwd: options.cwd ?? '/work/repo',
    provider: options.provider ?? null,
    model: options.model ?? null,
    assertions: options.assertions ?? {
      testCommand: 'npm test',
      maxSteps: 10,
      maxTokens: 10000,
    },
  }, { now: () => 1700000000000 })
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

await testAsync('normalizeCaseFields accepts a minimal valid case and derives the name', () => {
  const result = normalizeCaseFields({ prompt: 'fix the login redirect\nmore details', cwd: '/work/repo' })
  assert.equal(result.ok, true)
  assert.equal(result.value.name, 'fix the login redirect')
  assert.equal(result.value.provider, null)
  assert.deepEqual(result.value.assertions, {})
})

await testAsync('normalizeCaseFields rejects empty prompt, relative cwd, one-sided model', () => {
  assert.equal(normalizeCaseFields({ prompt: '', cwd: '/work/repo' }).detail, 'prompt')
  assert.equal(normalizeCaseFields({ prompt: 'x', cwd: 'work/repo' }).detail, 'cwd')
  assert.equal(normalizeCaseFields({ prompt: 'x', cwd: '/work/repo', provider: 'deepseek' }).detail, 'model')
  assert.equal(normalizeCaseFields({ prompt: 'x', cwd: '/work/repo', model: 'deepseek-chat' }).detail, 'model')
})

await testAsync('normalizeCaseFields validates assertion types and caps', () => {
  const base = { prompt: 'x', cwd: '/work/repo' }
  assert.equal(normalizeCaseFields({ ...base, assertions: { testCommand: 42 } }).detail, 'testCommand')
  assert.equal(normalizeCaseFields({ ...base, assertions: { forbiddenPaths: 'src' } }).detail, 'forbiddenPaths')
  assert.equal(normalizeCaseFields({ ...base, assertions: { expectFiles: [1] } }).detail, 'expectFiles')
  assert.equal(normalizeCaseFields({ ...base, assertions: { maxSteps: -1 } }).detail, 'maxSteps')
  assert.equal(normalizeCaseFields({ ...base, assertions: { maxTokens: 1.5 } }).detail, 'maxTokens')
  assert.equal(normalizeCaseFields({ ...base, assertions: { maxSteps: 0 } }).value.assertions.maxSteps, undefined)
  const tooMany = normalizeCaseFields({ ...base, assertions: { forbiddenPaths: Array.from({ length: 51 }, (_, index) => `p${index}`) } })
  assert.equal(tooMany.detail, 'forbiddenPaths')
  const cleaned = normalizeCaseFields({
    ...base,
    assertions: { forbiddenPaths: [' src/ ', 'src', 'docs'], expectFiles: ['./tests/'], testCommand: '  npm test  ' },
  })
  assert.deepEqual(cleaned.value.assertions, {
    testCommand: 'npm test',
    forbiddenPaths: ['src/', 'src', 'docs'],
    expectFiles: ['tests/'],
  })
})

await testAsync('validateCaseFields merges an update patch over the base case', () => {
  const base = makeCase()
  const updated = validateCaseFields({ name: 'Renamed', prompt: 'new prompt' }, { mode: 'update', base })
  assert.equal(updated.ok, true)
  assert.equal(updated.value.name, 'Renamed')
  assert.equal(updated.value.cwd, base.cwd)
  assert.deepEqual(updated.value.assertions, base.assertions)
  assert.equal(validateCaseFields({ cwd: 'relative' }, { mode: 'update', base }).detail, 'cwd')
})

await testAsync('IDs, name derivation and formatting helpers', () => {
  assert.match(shortId('case'), /^case-[a-z0-9]{8}$/)
  assert.match(shortId('run', () => 'ABCDEF12-3456-7890'), /^run-abcdef12$/)
  assert.equal(host.nameFromPrompt('a'.repeat(100)).length, 58)
  assert.equal(host.normalizeRelPath('./src\\\\a.ts'), 'src/a.ts')
  assert.equal(matchesPrefix('src/a.ts', 'src/'), true)
  assert.equal(matchesPrefix('docs/a.ts', 'src/'), false)
  assert.equal(formatCount(1500), '1.5k')
})

// --------------------------------------------------------------------------
// cases.json persistence
// --------------------------------------------------------------------------

await testAsync('addCaseRecord / updateCaseRecord / deleteCaseRecord', () => {
  const added = addCaseRecord({ version: 1, cases: [] }, normalizeCaseFields({ prompt: 'do it', cwd: '/repo' }).value, { now: () => 1000 })
  assert.equal(added.ok, true)
  assert.match(added.case.id, /^case-[a-z0-9]{8}$/)
  assert.equal(added.doc.cases.length, 1)
  const updated = updateCaseRecord(added.doc, added.case.id, { name: 'New name' }, { now: () => 2000 })
  assert.equal(updated.ok, true)
  assert.equal(updated.case.name, 'New name')
  assert.equal(updated.case.createdAt, added.case.createdAt)
  assert.notEqual(updated.case.updatedAt, added.case.updatedAt)
  assert.equal(updateCaseRecord(added.doc, 'case-nope0000', { name: 'x' }).error, 'not-found')
  const deleted = deleteCaseRecord(updated.doc, added.case.id)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.doc.cases.length, 0)
  assert.equal(deleteCaseRecord(deleted.doc, added.case.id).error, 'not-found')
})

await testAsync('addCaseRecord enforces the 100 case cap', () => {
  const cases = Array.from({ length: MAX_CASES }, (_, index) => makeCase({ name: `case ${index}` }))
  const result = addCaseRecord({ version: 1, cases }, normalizeCaseFields({ prompt: 'x', cwd: '/repo' }).value)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'limit-reached')
})

await testAsync('parseCasesDocument skips corrupt entries and unknown versions', () => {
  assert.deepEqual(parseCasesDocument(null), { version: 1, cases: [] })
  assert.deepEqual(parseCasesDocument({ version: 99, cases: [makeCase()] }), { version: 1, cases: [] })
  const valid = makeCase()
  const parsed = parseCasesDocument({ version: 1, cases: [valid, { nope: true }, { ...valid, id: 'bad-id' }] })
  assert.equal(parsed.cases.length, 1)
  assert.equal(parsed.cases[0].id, valid.id)
  assert.equal(coerceStoredCase(null), null)
})

await testAsync('persistCases/loadCases round-trip through a temp home', async () => {
  const home = await makeHome()
  const added = addCaseRecord({ version: 1, cases: [] }, normalizeCaseFields({ prompt: 'persist me', cwd: '/repo' }).value)
  await persistCases(added.doc, { home })
  const loaded = await loadCases({ home })
  assert.equal(loaded.cases.length, 1)
  assert.equal(loaded.cases[0].prompt, 'persist me')
  const raw = JSON.parse(await readFile(path.join(home, CASES_RELATIVE_PATH), 'utf8'))
  assert.equal(raw.version, 1)
  await writeFile(path.join(home, CASES_RELATIVE_PATH), 'not json', 'utf8')
  assert.deepEqual(await loadCases({ home }), { version: 1, cases: [] })
})

await testAsync('writeJsonAtomic leaves no temp files behind', async () => {
  const home = await makeHome()
  const file = path.join(home, 'deep', 'dir', 'value.json')
  await writeJsonAtomic(file, { ok: true })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ok: true })
  const folder = path.dirname(file)
  const host_entries = await readdir(folder)
  assert.deepEqual(host_entries, ['value.json'])
})

await testAsync('runs.json parsing/retention/appending', async () => {
  assert.deepEqual(parseRunsDocument({ version: 2, runs: [] }), { version: 1, runs: [] })
  const parsed = parseRunsDocument({
    version: 1,
    runs: [
      { id: 'run-1', caseId: 'case-1', status: 'passed', reason: 'ok', totalTokens: 5 },
      { id: 'run-2', caseId: 'case-1', status: 'bogus', reason: 'bogus' },
      { broken: true },
    ],
  })
  assert.equal(parsed.runs.length, 2)
  assert.equal(parsed.runs[1].status, 'error')
  assert.equal(parsed.runs[1].reason, 'agent-error')

  const home = await makeHome()
  for (let index = 0; index < MAX_RUNS + 3; index += 1) {
    await appendRun({ id: `run-${index}`, caseId: 'case-1', status: 'passed', reason: 'ok' }, { home })
  }
  const loaded = await loadRuns({ home })
  assert.equal(loaded.runs.length, MAX_RUNS)
  assert.equal(loaded.runs[0].id, `run-${MAX_RUNS + 2}`)
  const raw = JSON.parse(await readFile(path.join(home, RUNS_RELATIVE_PATH), 'utf8'))
  assert.equal(raw.runs.length, MAX_RUNS)
})

// --------------------------------------------------------------------------
// Projection cache / recent sessions
// --------------------------------------------------------------------------

await testAsync('extractSessionSample reads id/title/prompt/cwd/model/steps/at', () => {
  const sample = extractSessionSample(projectionFixture({ title: 'T', prompt: 'P', cwd: '/w/repo', steps: 7, at: 123 }), 'abc-1234.json')
  assert.deepEqual(sample, {
    id: 'abc-1234', title: 'T', prompt: 'P', cwd: '/w/repo',
    provider: 'deepseek', model: 'deepseek-chat', steps: 7, at: 123,
  })
  assert.equal(extractSessionSample(null, 'abc.json'), null)
  assert.equal(extractSessionSample({ version: 7, record: { rows: {} } }, 'abc.json'), null)
  assert.equal(extractSessionSample(projectionFixture(), 'bad name.json'), null)
  assert.equal(sessionIdMatches('abc-1234', 'session-abc-1234'), true)
  assert.equal(sessionIdMatches('abc-1234', 'abc-1234'), true)
})

await testAsync('createSessionReader lists newest first, skips corrupt files, reuses and invalidates', async () => {
  const home = await makeHome()
  await seedProjection(home, 'aaaa-1111', projectionFixture({ prompt: 'older', at: 1000 }))
  await seedProjection(home, 'bbbb-2222', projectionFixture({ prompt: 'newer', at: 3000 }))
  await writeFile(path.join(home, PROJCACHE_RELATIVE_PATH, 'cccc-3333.json'), 'broken', 'utf8')
  const reader = createSessionReader({ home })
  const sessions = await reader.list()
  assert.deepEqual(sessions.map((entry) => entry.id), ['bbbb-2222', 'aaaa-1111'])
  const found = await reader.find('session-aaaa-1111')
  assert.equal(found.prompt, 'older')

  // Rewrite the newer file: size+mtime change must invalidate the cached sample.
  const file = path.join(home, PROJCACHE_RELATIVE_PATH, 'bbbb-2222.json')
  await writeFile(file, JSON.stringify(projectionFixture({ prompt: 'edited prompt', at: 3000, title: 'Edited' })), 'utf8')
  const stamp = new Date(Date.now() + 5000)
  await utimes(file, stamp, stamp)
  const refreshed = await reader.list()
  assert.equal(refreshed[0].prompt, 'edited prompt')
  assert.deepEqual(await createSessionReader({ home: path.join(home, 'missing') }).list(), [])
})

// --------------------------------------------------------------------------
// Pure run helpers
// --------------------------------------------------------------------------

await testAsync('parsePorcelain handles statuses, renames, quoting, deletions and dedupe', () => {
  const text = [
    ' M src/a.ts',
    '?? docs/new.md',
    'R  old/name.ts -> new/name.ts',
    ' D deleted.ts',
    ' M "src/with space.ts"',
    ' M src/a.ts',
    'A  added.ts\n',
  ].join('\n')
  assert.deepEqual(parsePorcelain(text), [
    'src/a.ts', 'docs/new.md', 'new/name.ts', 'deleted.ts', 'src/with space.ts', 'added.ts',
  ])
  assert.deepEqual(parsePorcelain(''), [])
  assert.deepEqual(parsePorcelain(undefined), [])
})

await testAsync('collectMetrics counts steps and folds usage', () => {
  const metrics = collectMetrics(SAMPLE_EVENTS)
  assert.deepEqual(metrics, { steps: 2, inputTokens: 130, outputTokens: 30, totalTokens: 160 })
  // No message usage: attempts are the fallback.
  const attemptOnly = collectMetrics([
    { type: 'step/start' },
    { type: 'assistant/attempt', data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 3 } } },
    { type: 'assistant/attempt', data: { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 4 } } },
  ])
  assert.deepEqual(attemptOnly, { steps: 1, inputTokens: 9, outputTokens: 4, totalTokens: 13 })
  // A message usage for the same step wins over attempts (no double counting).
  const both = collectMetrics([
    { type: 'assistant/attempt', data: { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 4 } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 50, outputTokens: 10 } } },
  ])
  assert.deepEqual(both, { steps: 0, inputTokens: 50, outputTokens: 10, totalTokens: 60 })
  assert.deepEqual(collectMetrics(null), { steps: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
})

await testAsync('evaluateAssertions covers every reason branch', () => {
  const base = { changedFiles: ['src/a.ts'], steps: 3, totalTokens: 100 }
  assert.deepEqual(evaluateAssertions(base, {}), { status: 'passed', reason: 'ok' })
  assert.equal(evaluateAssertions(base, { testCommand: 'npm test' }).reason, 'test-failed')
  assert.deepEqual(evaluateAssertions({ ...base, testExit: 0 }, { testCommand: 'npm test' }), { status: 'passed', reason: 'ok' })
  assert.equal(evaluateAssertions(base, { forbiddenPaths: ['src/'] }).reason, 'forbidden-path')
  assert.equal(evaluateAssertions(base, { forbiddenPaths: ['docs/'] }).reason, 'ok')
  assert.equal(evaluateAssertions(base, { expectFiles: ['docs/'] }).reason, 'expect-file-missing')
  assert.equal(evaluateAssertions(base, { expectFiles: ['src/'] }).reason, 'ok')
  assert.equal(evaluateAssertions(base, { maxSteps: 2 }).reason, 'max-steps')
  assert.equal(evaluateAssertions(base, { maxSteps: 3 }).reason, 'ok')
  assert.equal(evaluateAssertions(base, { maxTokens: 99 }).reason, 'max-tokens')
  assert.equal(evaluateAssertions(base, { maxTokens: 100 }).reason, 'ok')
  const both = evaluateAssertions({ changedFiles: ['src/a.ts'], steps: 99, totalTokens: 1 }, { maxSteps: 1, maxTokens: 1 })
  assert.equal(both.reason, 'max-steps')
})

await testAsync('waitSubprocess accepts done/wait/exitCode shapes and rejects unknown handles', async () => {
  const fromDone = await waitSubprocess({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: { readFrom: () => Buffer.from('hello') }, stderr: '' },
  })
  assert.deepEqual(fromDone, { exitCode: 0, stdout: 'hello', stderr: '' })
  const fromWait = await waitSubprocess({ wait: async () => ({ code: 2, stdout: 'out', stderr: 'err' }) })
  assert.deepEqual(fromWait, { exitCode: 2, stdout: 'out', stderr: 'err' })
  const fromField = await waitSubprocess({ exitCode: 0 })
  assert.equal(fromField.exitCode, 0)
  await assert.rejects(() => waitSubprocess(null), /no handle/)
  await assert.rejects(() => waitSubprocess({}), /unsupported/)
})

await testAsync('createSubprocessRunner maps argv to resolveExecutable/spawn', async () => {
  const spawned = []
  const subprocess = {
    async resolveExecutable(name) { return `/bin/${name}` },
    spawn(options) {
      spawned.push(options)
      return { done: Promise.resolve({ exitCode: 3 }), collected: { stdout: 'x', stderr: 'y' } }
    },
  }
  const runner = createSubprocessRunner(subprocess, { platform: 'linux' })
  const direct = await runner.run(['git', '-C', '/repo', 'status'], { cwd: '/repo' })
  assert.deepEqual(spawned[0].argv, ['/bin/git', '-C', '/repo', 'status'])
  assert.equal(direct.exitCode, 3)
  assert.deepEqual(direct.stdout, 'x')
  await runner.shell('npm test', { cwd: '/repo' })
  assert.deepEqual(spawned[1].argv, ['/bin/sh', '-c', 'npm test'])
})

// --------------------------------------------------------------------------
// runCase orchestration (fake deps)
// --------------------------------------------------------------------------

await testAsync('runCase: passed scenario writes runs.json and disposes the agent', async () => {
  const home = await makeHome()
  const { services, calls } = createFakeServices()
  const testCase = makeCase()
  const run = await runCase({ case: testCase, deps: { ...services, home, tmpDir: home } })
  assert.equal(run.status, 'passed')
  assert.equal(run.reason, 'ok')
  assert.equal(run.steps, 2)
  assert.equal(run.totalTokens, 160)
  assert.deepEqual(run.changedFiles, ['src/a.ts', 'docs/new.md'])
  assert.equal(run.testExit, 0)
  assert.equal(run.worktree, null)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].meta.cwd.includes('dsh-agent-ci'), true)
  assert.deepEqual(calls.create[0].agentOptions, {})
  assert.equal(calls.followup[0].content[0].text, testCase.prompt)
  assert.equal(calls.followup[0].source.kind, 'user')
  assert.equal(calls.whenIdle, 1)
  assert.equal(calls.dispose, 1)
  assert.equal(calls.readSession.length, 1)
  assert.equal(calls.runShell[0].command, 'npm test')
  const runs = await loadRuns({ home })
  assert.equal(runs.runs.length, 1)
  assert.equal(runs.runs[0].id, run.id)
})

await testAsync('runCase: test-failed scenario keeps the output tail', async () => {
  const home = await makeHome()
  const { services, calls } = createFakeServices({
    runShell: () => ({ exitCode: 1, stdout: '1 passing\n', stderr: '2 failing\nAssertionError: boom' }),
  })
  const run = await runCase({ case: makeCase(), deps: { ...services, home, tmpDir: home } })
  assert.equal(run.status, 'failed')
  assert.equal(run.reason, 'test-failed')
  assert.equal(run.testExit, 1)
  assert.match(run.testOutputTail, /AssertionError: boom/)
  assert.equal(calls.dispose, 1)
})

await testAsync('runCase: forbidden path and expect-file assertions short-circuit the test command', async () => {
  const home = await makeHome()
  const { services, calls } = createFakeServices({ statusOutput: ' M secret/key.pem\n' })
  const forbidden = await runCase({
    case: makeCase({ assertions: { forbiddenPaths: ['secret/'], testCommand: 'npm test' } }),
    deps: { ...services, home, tmpDir: home },
  })
  assert.equal(forbidden.reason, 'forbidden-path')
  assert.equal(calls.runShell.length, 0)

  const missing = await runCase({
    case: makeCase({ assertions: { expectFiles: ['tests/'], testCommand: 'npm test' } }),
    deps: { ...services, home, tmpDir: home },
  })
  assert.equal(missing.reason, 'expect-file-missing')
  assert.equal(calls.runShell.length, 0)
})

await testAsync('runCase: no-git / agent-error / service-unavailable are recorded, never thrown', async () => {
  const home = await makeHome()
  const noGit = createFakeServices({ runCommand: (argv) => (argv.includes('add') ? { exitCode: 1, stdout: '', stderr: 'not a git repository' } : { exitCode: 0 }) })
  const gitRun = await runCase({ case: makeCase(), deps: { ...noGit.services, home, tmpDir: home } })
  assert.equal(gitRun.status, 'error')
  assert.equal(gitRun.reason, 'no-git')
  assert.match(gitRun.error, /not a git repository/)
  assert.equal(noGit.calls.create.length, 0)

  const broken = createFakeServices({ createError: true })
  const agentRun = await runCase({ case: makeCase(), deps: { ...broken.services, home, tmpDir: home } })
  assert.equal(agentRun.status, 'error')
  assert.equal(agentRun.reason, 'agent-error')
  assert.match(agentRun.error, /create blew up/)
  assert.equal(broken.calls.dispose, 0)

  const unavailable = await runCase({ case: makeCase(), deps: { home, tmpDir: home } })
  assert.equal(unavailable.status, 'error')
  assert.equal(unavailable.reason, 'service-unavailable')
  assert.match(unavailable.error, /agents/)
  const runs = await loadRuns({ home })
  assert.equal(runs.runs.length, 3)
})

await testAsync('runCase: keeps the worktree path when removal fails', async () => {
  const home = await makeHome()
  const { services } = createFakeServices({
    runCommand: (argv) => {
      if (argv.includes('add')) return { exitCode: 0 }
      if (argv.includes('status')) return { exitCode: 0, stdout: '' }
      if (argv.includes('remove')) return { exitCode: 1, stderr: 'busy' }
      return { exitCode: 0 }
    },
  })
  const run = await runCase({ case: makeCase({ assertions: {} }), deps: { ...services, home, tmpDir: home } })
  assert.equal(run.status, 'passed')
  assert.equal(typeof run.worktree, 'string')
  assert.match(run.worktree, /case-/)
})

await testAsync('runCase: readSession failure falls back to snapshotEvents without failing the run', async () => {
  const home = await makeHome()
  const { services } = createFakeServices({ readSessionError: true })
  services.agents.create = async () => ({
    agent: {
      async followup() {},
      async whenIdle() {},
      session: { snapshotEvents: () => [{ type: 'step/start' }] },
    },
    async dispose() {},
  })
  const run = await runCase({ case: makeCase({ assertions: {} }), deps: { ...services, home, tmpDir: home } })
  assert.equal(run.status, 'passed')
  assert.equal(run.steps, 1)
})

await testAsync('run controller: single concurrency returns run-in-progress', async () => {
  const home = await makeHome()
  let release = null
  const idle = new Promise((resolve) => { release = resolve })
  const { services } = createFakeServices({ idle: () => idle })
  const controller = createRunController({ home, deps: { ...services, home, tmpDir: home } })
  assert.deepEqual(controller.status(), { running: false })
  const first = controller.run(makeCase({ name: 'first' }))
  await flush()
  assert.deepEqual(controller.status().running, true)
  assert.equal(controller.status().caseId.length > 0, true)
  const second = await controller.run(makeCase({ name: 'second' }))
  assert.deepEqual(second, { ok: false, error: 'run-in-progress' })
  release()
  const completed = await first
  assert.equal(completed.ok, true)
  assert.equal(completed.run.status, 'passed')
  assert.deepEqual(controller.status(), { running: false })
})

// --------------------------------------------------------------------------
// HTTP route
// --------------------------------------------------------------------------

function createFakeCtx() {
  const ctx = {
    warnings: [],
    injected: null,
    effects: [],
    registrations: [],
    logger: { warn: (message) => ctx.warnings.push(message) },
    effect(fn, label) {
      ctx.effects.push(label)
      return fn()
    },
    inject(names, callback) {
      ctx.injected = names
      callback(ctx)
    },
    webServer: {
      register: (options) => {
        ctx.registrations.push(options)
        return () => {}
      },
    },
  }
  return ctx
}

function fakeApplyContext(deps) {
  const ctx = createFakeCtx()
  return { ctx, handler: () => {
    apply(ctx, { deps })
    assert.deepEqual(ctx.injected, ['webServer'])
    return ctx.registrations[0].handler
  } }
}

await testAsync('apply registers one exact route and only injects webServer', () => {
  const ctx = createFakeCtx()
  apply(ctx, { deps: createFakeServices().services })
  assert.deepEqual(ctx.injected, ['webServer'])
  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].kind, 'exact')
  assert.equal(ctx.registrations[0].path, ROUTE)
  assert.equal(typeof ctx.registrations[0].handler, 'function')
})

await testAsync('apply never throws on a broken context', () => {
  assert.doesNotThrow(() => apply(null))
  assert.doesNotThrow(() => apply({ inject() { throw new Error('nope') } }))
  const ctx = createFakeCtx()
  ctx.webServer = null
  assert.doesNotThrow(() => apply(ctx, {}))
})

await testAsync('route: report / create / update / get / delete round-trip on a temp home', async () => {
  const home = await makeHome()
  const deps = createFakeServices().services
  const ctx = createFakeCtx()
  apply(ctx, { deps, home })
  const handler = ctx.registrations[0].handler

  const empty = await call(handler, 'GET', apiUrl('action=report'))
  assert.equal(empty.status, 200)
  assert.equal(empty.headers['cache-control'], 'no-store')
  assert.deepEqual(empty.body.cases, [])
  assert.deepEqual(empty.body.runs, [])
  assert.deepEqual(empty.body.status, { running: false })

  const created = await post(handler, {
    action: 'create',
    fields: { prompt: 'fix redirect', cwd: '/repo/app', provider: 'deepseek', model: 'deepseek-chat', assertions: { testCommand: 'npm test' } },
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  assert.match(created.body.case.id, /^case-/)
  const caseId = created.body.case.id

  const fetched = await call(handler, 'GET', apiUrl(`action=case&id=${caseId}`))
  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.case.name, 'fix redirect')
  assert.equal((await call(handler, 'GET', apiUrl('action=case&id=case-nope0000'))).status, 404)

  const updated = await post(handler, { action: 'update', id: caseId, patch: { name: 'Renamed', prompt: 'new prompt' } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.case.name, 'Renamed')
  assert.equal(updated.body.case.cwd, '/repo/app')

  const report = await call(handler, 'GET', apiUrl('action=report'))
  assert.equal(report.body.cases.length, 1)
  assert.equal(report.body.generatedAt.length > 0, true)

  const deleted = await post(handler, { action: 'delete', id: caseId })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.deleted, true)
  assert.equal((await call(handler, 'GET', apiUrl('action=report'))).body.cases.length, 0)
})

await testAsync('route: invalid input gets JSON 400/404/405 without throwing', async () => {
  const home = await makeHome()
  const ctx = createFakeCtx()
  apply(ctx, { deps: createFakeServices().services, home })
  const handler = ctx.registrations[0].handler

  const badCwd = await post(handler, { action: 'create', fields: { prompt: 'x', cwd: 'relative' } })
  assert.equal(badCwd.status, 400)
  assert.equal(badCwd.body.error, 'invalid-case')
  assert.equal(badCwd.body.detail, 'cwd')

  assert.equal((await call(handler, 'GET', apiUrl('action=nope'))).status, 400)
  assert.equal((await call(handler, 'DELETE', ROUTE)).status, 405)
  assert.equal((await call(handler, 'POST', ROUTE, { rawBody: '{oops' })).status, 400)
  assert.equal((await post(handler, { action: 'update', id: 'case-nope0000', patch: {} })).status, 404)
  assert.equal((await post(handler, { action: 'delete', id: 'case-nope0000' })).status, 404)
  assert.equal((await post(handler, { action: 'run', id: 'case-nope0000' })).status, 404)
})

await testAsync('route: create from a projection-cache session prefills prompt/cwd/model', async () => {
  const home = await makeHome()
  await seedProjection(home, 'dddd-4444', projectionFixture({ title: 'Frozen title', prompt: 'the original prompt', cwd: '/work/frozen', at: 9000 }))
  const ctx = createFakeCtx()
  apply(ctx, { deps: createFakeServices().services, home })
  const handler = ctx.registrations[0].handler

  const report = await call(handler, 'GET', apiUrl('action=report'))
  assert.equal(report.body.sessions.length, 1)
  assert.equal(report.body.sessions[0].title, 'Frozen title')

  const created = await post(handler, { action: 'create', sessionId: 'dddd-4444' })
  assert.equal(created.status, 200)
  assert.equal(created.body.case.prompt, 'the original prompt')
  assert.equal(created.body.case.cwd, '/work/frozen')
  assert.equal(created.body.case.provider, 'deepseek')
  assert.equal(created.body.case.model, 'deepseek-chat')
  assert.equal(created.body.case.sourceSessionId, 'dddd-4444')

  const unknown = await post(handler, { action: 'create', sessionId: 'zzzz-9999' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.detail, 'session-not-found')
})

await testAsync('route: create enforces the 100 case limit', async () => {
  const home = await makeHome()
  await persistCases({ version: 1, cases: Array.from({ length: MAX_CASES }, (_, index) => makeCase({ name: `case ${index}` })) }, { home })
  const ctx = createFakeCtx()
  apply(ctx, { deps: createFakeServices().services, home })
  const result = await post(ctx.registrations[0].handler, { action: 'create', fields: { prompt: 'one more', cwd: '/repo' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'limit-reached')
})

await testAsync('route: run executes the fake pipeline and report stops showing running', async () => {
  const home = await makeHome()
  const { services, calls } = createFakeServices()
  const ctx = createFakeCtx()
  apply(ctx, { deps: { ...services, home, tmpDir: home }, home })
  const handler = ctx.registrations[0].handler
  const created = await post(handler, {
    action: 'create',
    fields: { prompt: 'fix redirect', cwd: '/repo/app', assertions: { testCommand: 'npm test', maxSteps: 10 } },
  })
  const caseId = created.body.case.id
  const run = await post(handler, { action: 'run', id: caseId })
  assert.equal(run.status, 200)
  assert.equal(run.body.run.status, 'passed')
  assert.equal(run.body.run.caseId, caseId)
  assert.equal(calls.dispose, 1)
  const report = await call(handler, 'GET', apiUrl('action=report'))
  assert.deepEqual(report.body.status, { running: false })
  assert.equal(report.body.runs.length, 1)
})

await testAsync('route: run with missing services records service-unavailable and returns 200', async () => {
  const home = await makeHome()
  const bare = {}
  const ctx = createFakeCtx()
  apply(ctx, { deps: bare, home })
  const handler = ctx.registrations[0].handler
  const created = await post(handler, { action: 'create', fields: { prompt: 'x', cwd: '/repo' } })
  const run = await post(handler, { action: 'run', id: created.body.case.id })
  assert.equal(run.status, 200)
  assert.equal(run.body.run.status, 'error')
  assert.equal(run.body.run.reason, 'service-unavailable')
})

await testAsync('route: HEAD returns headers and no body', async () => {
  const home = await makeHome()
  const ctx = createFakeCtx()
  apply(ctx, { deps: createFakeServices().services, home })
  const result = await call(ctx.registrations[0].handler, 'HEAD', apiUrl('action=report'))
  assert.equal(result.status, 200)
  assert.equal(result.body, null)
})

await testAsync('route: report reads a seeded cases.json without the source services', async () => {
  const home = await makeHome()
  const added = addCaseRecord({ version: 1, cases: [] }, normalizeCaseFields({ prompt: 'seed', cwd: '/repo' }).value)
  await persistCases(added.doc, { home })
  const ctx = createFakeCtx()
  apply(ctx, { home })
  const report = await call(ctx.registrations[0].handler, 'GET', apiUrl('action=report'))
  assert.equal(report.status, 200)
  assert.equal(report.body.cases.length, 1)
})

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------

await cleanupTemps()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log('-', failure.name)
  process.exitCode = 1
}
