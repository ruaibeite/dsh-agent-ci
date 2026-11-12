/**
 * Browser-half tests for @ruaibeite/dsh-agent-ci — no browser, no network.
 *
 * A tiny React stand-in runs the real `client.js` inside `node:vm`: hook state
 * survives render passes, effects actually run with dependency checks and
 * cleanups, timers are recorded instead of fired. Tests cover the four UI
 * states, case list badges, create-form validation, the run-result panel
 * (including raw test output escaping), polling start/stop, and the zh/en
 * dictionary parity. The only files read are this repo's `client.js` and
 * `locale/*.json`.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const LOCALE_DIR = path.join(ROOT, 'locale')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

// ---------------------------------------------------------------- harness

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

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}

/** One mini React runtime: per-component hook slots, effects with deps. */
function createRuntime() {
  const runtime = {
    slots: new Map(),
    currentKey: null,
    hookCursor: 0,
    dirty: false,
    pendingEffects: [],
  }
  const slotFor = (key) => {
    let slot = runtime.slots.get(key)
    if (slot === undefined) {
      slot = { hooks: [], effects: [] }
      runtime.slots.set(key, slot)
    }
    return slot
  }
  const currentSlot = () => slotFor(runtime.currentKey)
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.hooks[index]) : next
        if (!Object.is(value, slot.hooks[index])) {
          slot.hooks[index] = value
          runtime.dirty = true
        }
      }
      return [slot.hooks[index], setState]
    },
    useEffect(fn, deps) {
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      runtime.pendingEffects.push({ key: runtime.currentKey, index, fn, deps: deps === undefined ? undefined : [...deps] })
    },
    useRef(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = { current: initial }
      return slot.hooks[index]
    },
    useMemo(fn, deps) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      const record = slot.hooks[index]
      const wanted = deps === undefined ? undefined : [...deps]
      if (record !== undefined && sameDeps(record.deps, wanted)) return record.value
      const value = fn()
      slot.hooks[index] = { deps: wanted, value }
      return value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    memo: (component) => component,
    Fragment: 'fragment',
  }
  runtime.React = React
  return runtime
}

function expand(node, runtime, treePath, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, runtime, `${treePath}.${index}`, depth))
  if (depth > 120) throw new Error('render tree too deep')
  const { type, props, children } = node
  if (typeof type === 'function') {
    const key = `${treePath}#${type.name || 'Anonymous'}`
    const previousKey = runtime.currentKey
    const previousCursor = runtime.hookCursor
    runtime.currentKey = key
    runtime.hookCursor = 0
    let output
    try {
      const merged = { ...props }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      output = type(merged)
    } finally {
      runtime.currentKey = previousKey
      runtime.hookCursor = previousCursor
    }
    return expand(output, runtime, treePath, depth + 1)
  }
  const renderedChildren = children.flatMap((child, index) => expand(child, runtime, `${treePath}.${index}`, depth + 1))
  return [{ tag: type, props, children: renderedChildren }]
}

async function commitEffects(runtime) {
  const pending = runtime.pendingEffects
  runtime.pendingEffects = []
  for (const effect of pending) {
    const slot = runtime.slots.get(effect.key)
    const record = slot.effects[effect.index]
    if (record !== undefined && sameDeps(record.deps, effect.deps)) continue
    if (record !== undefined && typeof record.cleanup === 'function') {
      try {
        record.cleanup()
      } catch {
        /* cleanups must not fail the harness */
      }
    }
    const cleanup = effect.fn()
    slot.effects[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Collect host nodes, text and handy lookups from a rendered tree. */
function collect(tree) {
  const out = { nodes: [], text: [], joined: '', tags: [], classes: new Set(), data: [], buttons: [] }
  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        out.text.push(node)
        continue
      }
      const { tag, props, children } = node
      out.nodes.push(node)
      out.tags.push(tag)
      if (typeof props.className === 'string') for (const cls of props.className.split(/\s+/)) if (cls !== '') out.classes.add(cls)
      for (const key of Object.keys(props)) if (key.startsWith('data-')) out.data.push([key, String(props[key])])
      if (tag === 'button') out.buttons.push(node)
      if (tag === 'style') continue
      walk(children)
    }
  }
  walk(tree)
  out.joined = out.text.join(' ')
  const dataName = (key) => (key.startsWith('data-') ? key : `data-${key}`)
  out.dataValue = (key) => {
    const hit = out.data.find(([name]) => name === dataName(key))
    return hit === undefined ? undefined : hit[1]
  }
  out.dataValues = (key) => out.data.filter(([name]) => name === dataName(key)).map(([, value]) => value)
  out.byClass = (cls) => out.nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(cls))
  out.byTag = (tag) => out.nodes.filter((node) => node.tag === tag)
  out.textOf = (node) => {
    const parts = []
    const visit = (current) => {
      if (typeof current === 'string') parts.push(current)
      else if (Array.isArray(current)) for (const child of current) visit(child)
      else if (current !== null && current !== undefined && typeof current === 'object') visit(current.children)
    }
    visit(node)
    return parts.join('')
  }
  out.contains = (needle) => out.joined.includes(needle)
  out.buttonByText = (label) => out.buttons.find((button) => out.textOf(button) === label)
  return out
}

/**
 * Mount a component: settle every state/effect pass, then expose the tree.
 * Returns `{view, rerender, unmount, runtime}`.
 */
async function mount(React, component, props) {
  const runtime = React.__runtime ?? createRuntime()
  let tree = null
  const renderPass = () => {
    runtime.dirty = false
    runtime.pendingEffects = []
    tree = expand(React.createElement(component, props), runtime, 'r')
  }
  const settle = async () => {
    for (let pass = 0; pass < 40; pass += 1) {
      renderPass()
      await commitEffects(runtime)
      await tick()
      if (!runtime.dirty) return
    }
    throw new Error('component did not settle')
  }
  const unmount = () => {
    for (const slot of runtime.slots.values()) {
      for (const record of slot.effects) {
        if (record !== undefined && typeof record.cleanup === 'function') {
          try {
            record.cleanup()
          } catch {
            /* ignore */
          }
          record.cleanup = undefined
        }
      }
    }
  }
  await settle()
  return {
    runtime,
    view: () => collect(tree),
    rerender: settle,
    unmount,
  }
}

// ---------------------------------------------------------- client loader

function loadClient(options = {}) {
  let factory = null
  let moduleId = null
  const lang = options.lang || 'zh-CN'
  const fetchCalls = []
  const intervalCalls = []
  const clearedIntervals = []

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          moduleId = spec.id
          factory = spec.factory
        },
      },
    },
    document: {
      documentElement: { lang },
      baseURI: 'http://127.0.0.1:49269/',
      visibilityState: 'visible',
      createElement() {
        return { href: '', download: '', click() {} }
      },
    },
    navigator: { language: lang },
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init })
      if (typeof options.fetchImpl === 'function') return options.fetchImpl(String(url), init)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    },
    setInterval: (fn, ms) => {
      const id = intervalCalls.length + 1
      intervalCalls.push({ id, ms, fn })
      return id
    },
    clearInterval: (id) => {
      clearedIntervals.push(id)
    },
    setTimeout: (...args) => {
      const timer = setTimeout(...args)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return timer
    },
    clearTimeout,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  if (factory === null) throw new Error('client.js did not register a __ModuleLoader__ factory')

  const runtime = createRuntime()
  runtime.React.__runtime = runtime
  const moduleExports = factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`unexpected require: ${name}`)
  })
  return { moduleId, moduleExports, model: moduleExports.__model, React: runtime.React, fetchCalls, intervalCalls, clearedIntervals, sandbox }
}

/** Load the client and run its `apply()` against a fake ctx. */
function loadWithContext(options = {}) {
  const load = loadClient(options)
  const slotRegistrations = []
  const localeRegistrations = []
  const effectLabels = []
  const ctx = {
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    locale: {
      getLocale: () => ({ active: options.activeLocale || 'zh' }),
      getSnapshot: () => ({ active: options.activeLocale || 'zh' }),
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        return callback()
      },
      register(slotOptions, component) {
        slotRegistrations.push({ slotOptions, component })
        return () => {}
      },
    },
  }
  load.moduleExports.apply(ctx)
  return { load, model: load.model, moduleId: load.moduleId, slotRegistrations, localeRegistrations, effectLabels }
}

// ------------------------------------------------------------- fixtures

const tr = (() => {
  const load = loadClient({})
  return load.model.textOf(null, true)
})()

function makeReport(overrides = {}) {
  return {
    ok: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
    cases: [],
    runs: [],
    sessions: [],
    status: { running: false },
    ...overrides,
  }
}

function makeCase(overrides = {}) {
  return {
    id: 'case-1a2b3c4d',
    name: 'Fix redirect',
    prompt: 'fix the login redirect',
    cwd: '/work/repo',
    provider: 'deepseek',
    model: 'deepseek-chat',
    assertions: { testCommand: 'npm test', maxSteps: 10, maxTokens: 50000 },
    sourceSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeRun(overrides = {}) {
  return {
    id: 'run-1a2b3c4d',
    caseId: 'case-1a2b3c4d',
    caseName: 'Fix redirect',
    at: '2026-01-01T00:10:00.000Z',
    durationMs: 4200,
    status: 'passed',
    reason: 'ok',
    steps: 6,
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    changedFiles: ['src/login.ts'],
    testExit: 0,
    testOutputTail: 'all green',
    worktree: null,
    ...overrides,
  }
}

// --------------------------------------------------------------------------
// Registration + dictionaries
// --------------------------------------------------------------------------

await testAsync('client.js registers the module id, settings section and dictionaries', () => {
  const { moduleId, slotRegistrations, localeRegistrations, effectLabels } = loadWithContext({ activeLocale: 'zh' })
  assert.equal(moduleId, '@ruaibeite/dsh-agent-ci')
  const section = slotRegistrations.find((entry) => entry.slotOptions.name === 'settings.section')
  assert.equal(section.slotOptions.id, 'agent-ci')
  assert.equal(section.slotOptions.order, 4)
  assert.equal(section.slotOptions.locale, '@ruaibeite/dsh-agent-ci')
  assert.equal(typeof section.component, 'function')
  assert.equal(section.slotOptions.label(), 'Agent CI')
  const icon = slotRegistrations.find((entry) => entry.slotOptions.name === 'settings.section.icon')
  assert.equal(icon.slotOptions.id, 'agent-ci')
  assert.equal(localeRegistrations[0].namespace, '@ruaibeite/dsh-agent-ci')
  assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries.zh).sort(), Object.keys(localeRegistrations[0].dictionaries.en).sort())
  assert.equal(effectLabels.length, 1)
})

await testAsync('bundled TEXT and locale/*.json keep zh/en key parity', () => {
  const { load } = loadWithContext({})
  const zh = load.model.TEXT.zh
  const en = load.model.TEXT.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal(typeof zh['meta.title'], 'string')
  assert.equal(typeof zh['meta.description'], 'string')
  const fileZh = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'zh.json'), 'utf8'))
  const fileEn = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'en.json'), 'utf8'))
  assert.deepEqual(Object.keys(fileZh).sort(), Object.keys(fileEn).sort())
  assert.deepEqual(Object.keys(fileZh).sort(), Object.keys(zh).sort())
  assert.equal(fileZh['meta.title'], zh['meta.title'])
  assert.equal(fileEn['meta.title'], en['meta.title'])
  assert.equal(fileZh['meta.description'], zh['meta.description'])
})

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

await testAsync('formatting and draft helpers are pure and deterministic', () => {
  const model = loadClient({}).model
  assert.equal(model.fmtDuration(820), '820ms')
  assert.equal(model.fmtDuration(4200), '4.2s')
  assert.equal(model.fmtDuration(65000), '1m 05s')
  assert.equal(model.fmtCount(1500), '1.5k')
  assert.equal(model.fmtCount(999), '999')
  assert.equal(model.shortCwd('/Users/me/projects/dsh-mark'), 'projects/dsh-mark')
  assert.equal(model.shortCwd('C:\\work\\repo'), 'work/repo')
  assert.deepEqual(model.parseListInput(' a, b\nc, a '), ['a', 'b', 'c'])
  assert.equal(model.parseLimit(''), null)
  assert.equal(model.parseLimit('0'), null)
  assert.equal(model.parseLimit('12'), 12)
  assert.equal(Number.isNaN(model.parseLimit('-1')), true)
  assert.equal(Number.isNaN(model.parseLimit('1.5')), true)
  assert.equal(model.runTone(null), 'muted')
  assert.equal(model.runTone({ status: 'passed' }), 'pass')
  assert.equal(model.runTone({ status: 'failed' }), 'fail')
  assert.equal(model.runTone({ status: 'error' }), 'error')
  assert.equal(model.isRunningStatus(makeReport({ status: { running: true } })), true)
  assert.equal(model.isRunningStatus(makeReport()), false)
  assert.equal(model.statusText(null, tr), '未运行')
  assert.equal(model.reasonText('forbidden-path', tr), '改动了禁止路径')
  const lastRuns = model.lastRunsByCase([
    makeRun({ id: 'run-new', status: 'failed' }),
    makeRun({ id: 'run-old', status: 'passed' }),
  ])
  assert.equal(lastRuns.get('case-1a2b3c4d').id, 'run-new')
})

await testAsync('drafts convert to/from case payloads and validate', () => {
  const model = loadClient({}).model
  const draft = model.emptyDraft()
  assert.equal(model.canSaveDraft(draft), false)
  const invalid = model.validateDraft(draft)
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['cwd', 'prompt'])

  const good = { ...draft, name: 'Case', prompt: ' fix it ', cwd: '/work/repo', provider: 'deepseek', model: 'deepseek-chat',
    testCommand: ' npm test ', forbiddenPaths: 'secret/, node_modules', expectFiles: 'src/', maxSteps: '12', maxTokens: '0' }
  assert.equal(model.canSaveDraft(good), true)
  assert.deepEqual(model.draftToFields(good), {
    name: 'Case',
    prompt: 'fix it',
    cwd: '/work/repo',
    provider: 'deepseek',
    model: 'deepseek-chat',
    assertions: { testCommand: 'npm test', forbiddenPaths: ['secret/', 'node_modules'], expectFiles: ['src/'], maxSteps: 12 },
  })
  const invalidNumber = model.validateDraft({ ...good, maxTokens: 'lots' })
  assert.deepEqual(Object.keys(invalidNumber.errors), ['maxTokens'])
  const relative = model.validateDraft({ ...good, cwd: 'work/repo' })
  assert.deepEqual(Object.keys(relative.errors), ['cwd'])

  const roundTrip = model.draftFromCase(makeCase())
  assert.equal(roundTrip.name, 'Fix redirect')
  assert.equal(roundTrip.testCommand, 'npm test')
  assert.equal(roundTrip.maxSteps, '10')
  const fromSession = model.draftFromSession({ id: 's1', title: 'T', prompt: 'P', cwd: '/r', provider: 'p', model: 'm' })
  assert.equal(fromSession.prompt, 'P')
  assert.equal(fromSession.maxTokens, '')
  assert.match(model.assertionSummary(makeCase(), tr), /测试/)
})

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

await testAsync('StateView renders loading / error / empty and the error retry interacts', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const loading = await mount(React, model.StateView, { kind: 'loading', tr, error: '' })
  assert.equal(loading.view().dataValue('state'), 'loading')
  assert.equal(loading.view().contains('正在读取用例'), true)
  assert.equal(loading.view().buttons.length, 0)

  let retried = 0
  const errored = await mount(React, model.StateView, { kind: 'error', tr, error: 'boom', onRetry: () => { retried += 1 } })
  assert.equal(errored.view().dataValue('state'), 'error')
  assert.equal(errored.view().contains('boom'), true)
  const retry = errored.view().buttonByText('重试')
  assert.ok(retry)
  retry.props.onClick()
  assert.equal(retried, 1)

  const empty = await mount(React, model.StateView, { kind: 'empty', tr, error: '' })
  assert.equal(empty.view().dataValue('state'), 'empty')
  assert.equal(empty.view().contains('还没有用例'), true)
})

await testAsync('CaseList shows badges, metadata and per-case actions', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const calls = []
  const mounted = await mount(React, model.CaseList, {
    tr,
    cases: [makeCase(), makeCase({ id: 'case-99aa88bb', name: 'Never run', assertions: {} })],
    runs: [makeRun({ status: 'failed', reason: 'test-failed' })],
    sessions: [{ id: 's1', title: 'Session one' }],
    status: null,
    busy: false,
    onNew: () => calls.push('new'),
    onFromSession: (id) => calls.push(`session:${id}`),
    onRun: (testCase) => calls.push(`run:${testCase.id}`),
    onEdit: (testCase) => calls.push(`edit:${testCase.id}`),
    onDelete: (testCase) => calls.push(`delete:${testCase.id}`),
    onExport: (testCase) => calls.push(`export:${testCase.id}`),
  })
  const view = mounted.view()
  assert.equal(view.contains('Fix redirect'), true)
  assert.equal(view.contains('Never run'), true)
  assert.equal(view.contains('失败'), true) // last run badge
  assert.equal(view.contains('未运行'), true) // second case badge
  assert.equal(view.contains('≤10 步'), true)
  assert.equal(view.dataValues('case-id').length, 2)
  assert.equal(view.byTag('option').some((option) => view.textOf(option) === 'Session one'), true)

  const sessionPicker = view.nodes.find((node) => node.props['data-role'] === 'session-picker')
  assert.ok(sessionPicker)
  sessionPicker.props.onChange({ target: { value: 's1' } })
  assert.deepEqual(calls, ['session:s1'])
  view.buttonByText('运行').props.onClick()
  assert.deepEqual(calls[1], 'run:case-1a2b3c4d')
  view.buttonByText('编辑').props.onClick()
  assert.deepEqual(calls[2], 'edit:case-1a2b3c4d')
  view.buttonByText('删除').props.onClick()
  assert.deepEqual(calls[3], 'delete:case-1a2b3c4d')
  view.buttonByText('新建用例').props.onClick()
  assert.deepEqual(calls[4], 'new')
})

await testAsync('CaseForm disables save for an empty prompt and enables it once valid', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const draft = model.emptyDraft()
  const mounted = await mount(React, model.CaseForm, {
    tr,
    draft,
    caseId: '',
    editing: false,
    saving: false,
    error: '',
    onChange: () => {},
    onSave: () => {},
    onCancel: () => {},
  })
  const view = mounted.view()
  const saveEmpty = view.buttons.find((button) => view.textOf(button) === '保存')
  assert.ok(saveEmpty)
  assert.equal(saveEmpty.props.disabled, true)
  assert.equal(view.contains('prompt 不能为空'), true)
  assert.equal(view.contains('需要仓库的绝对路径'), true)

  const filled = await mount(React, model.CaseForm, {
    tr,
    draft: { ...draft, prompt: 'fix it', cwd: '/work/repo' },
    caseId: 'case-1a2b3c4d',
    editing: true,
    saving: false,
    error: '',
    onChange: () => {},
    onSave: () => {},
    onCancel: () => {},
  })
  const filledView = filled.view()
  assert.equal(filledView.buttons.find((button) => filledView.textOf(button) === '保存').props.disabled, false)
  assert.equal(filledView.contains('编辑用例'), true)
  assert.equal(filledView.contains('form.title.new'), false)
})

await testAsync('RunResultPanel renders metrics, changed files and test output as text (escaped by React)', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const payload = '<script>alert("xss")</script>\nAssertionError: boom'
  let copied = 0
  const mounted = await mount(React, model.RunResultPanel, {
    tr,
    run: makeRun({ status: 'failed', reason: 'test-failed', testExit: 1, testOutputTail: payload, changedFiles: ['src/a.ts', "src/b'test.ts"], steps: 7, totalTokens: 2500 }),
    copied: false,
    onBack: () => {},
    onCopy: () => { copied += 1 },
  })
  const view = mounted.view()
  assert.equal(view.contains('运行结果'), true)
  assert.equal(view.contains('失败'), true)
  assert.equal(view.contains('测试失败'), true)
  assert.equal(view.contains('7'), true)
  assert.equal(view.contains('src/a.ts'), true)
  assert.equal(view.contains("src/b'test.ts"), true)
  // The raw tail must appear as a text child, never via dangerouslySetInnerHTML.
  assert.equal(view.text.includes(payload), true)
  assert.equal(view.nodes.some((node) => node.props.dangerouslySetInnerHTML !== undefined), false)
  const pre = view.byTag('pre')[0]
  assert.equal(view.textOf(pre), payload)
  view.buttonByText('复制 JSON').props.onClick()
  assert.equal(copied, 1)
  view.buttonByText('返回列表').props.onClick()
})

// --------------------------------------------------------------------------
// Polling with fake timers
// --------------------------------------------------------------------------

await testAsync('AgentCiSection polls every 2 s while running and clears the timer when done', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const reports = [
    makeReport({ cases: [makeCase()], status: { running: true, caseId: 'case-1a2b3c4d' } }),
    makeReport({ cases: [makeCase()], runs: [makeRun()], status: { running: false } }),
  ]
  let index = 0
  const fetchReport = () => {
    const report = reports[Math.min(index, reports.length - 1)]
    index += 1
    return Promise.resolve(report)
  }
  const mounted = await mount(React, model.AgentCiSection, {
    getLanguage: () => 'zh',
    fetchReport,
    postAction: () => Promise.resolve({ ok: true }),
  })
  assert.equal(load.intervalCalls.length, 1)
  assert.equal(load.intervalCalls[0].ms, 2000)
  assert.equal(mounted.view().contains('运行中…（每 2 秒轮询）'), true)

  // Fire the recorded poll; the next report is finished, so the effect cleans up.
  await load.intervalCalls[0].fn()
  await mounted.rerender()
  assert.equal(load.clearedIntervals.includes(load.intervalCalls[0].id), true)
  assert.equal(mounted.view().contains('运行中…（每 2 秒轮询）'), false)
  assert.equal(index >= 2, true)
})

await testAsync('AgentCiSection: error state shows retry; empty state shows the new-case hint', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  let attempts = 0
  const failing = await mount(React, model.AgentCiSection, {
    getLanguage: () => 'zh',
    fetchReport: () => {
      attempts += 1
      return Promise.reject(new Error('host route down'))
    },
    postAction: () => Promise.resolve({ ok: true }),
  })
  const failedView = failing.view()
  assert.equal(failedView.dataValue('state'), 'error')
  assert.equal(failedView.contains('host route down'), true)
  const retry = failedView.buttonByText('重试')
  assert.ok(retry)
  retry.props.onClick()
  await failing.rerender()
  assert.equal(attempts >= 2, true)

  const emptyLoad = loadClient({})
  const empty = await mount(emptyLoad.React, emptyLoad.model.AgentCiSection, {
    getLanguage: () => 'zh',
    fetchReport: () => Promise.resolve(makeReport()),
    postAction: () => Promise.resolve({ ok: true }),
  })
  assert.equal(empty.view().dataValue('state'), 'empty')
  assert.equal(empty.view().contains('还没有用例'), true)
})

await testAsync('AgentCiSection: refresh button refetches the report', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  let calls = 0
  const mounted = await mount(React, model.AgentCiSection, {
    getLanguage: () => 'zh',
    fetchReport: () => {
      calls += 1
      return Promise.resolve(makeReport({ cases: [makeCase()] }))
    },
    postAction: () => Promise.resolve({ ok: true }),
  })
  assert.equal(calls, 1)
  mounted.view().buttonByText('刷新').props.onClick()
  await mounted.rerender()
  assert.equal(calls, 2)
})

await testAsync('AgentCiSection: en locale renders English copy', async () => {
  const load = loadClient({})
  const React = load.React
  const model = load.model
  const mounted = await mount(React, model.AgentCiSection, {
    getLanguage: () => 'en',
    fetchReport: () => Promise.resolve(makeReport({ cases: [makeCase()] })),
    postAction: () => Promise.resolve({ ok: true }),
  })
  const view = mounted.view()
  assert.equal(view.contains('Agent CI'), true)
  assert.equal(view.contains('New case'), true)
  assert.equal(view.contains('Refreshing'), false)
  assert.equal(view.contains('Refresh'), true)
})

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log('-', failure.name)
  process.exitCode = 1
}
