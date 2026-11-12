/**
 * @ruaibeite/dsh-agent-ci — browser half.
 *
 * One page in Settings: 「Agent CI」. It lists regression cases frozen from
 * real sessions, creates/edits them (including a "create from session" picker),
 * starts a run and renders the deterministic verdict (test result, changed
 * files, steps, tokens). Everything talks to the plugin's own host route
 * (`/dsh-agent-ci/api`); this half never touches the session log directly.
 *
 * Four states are explicit: loading / error / empty / populated. While the host
 * reports a run in progress the page polls `?action=report` every 2 s and stops
 * as soon as the run finishes. No `@deepseek-ai/*` import: only the injected
 * `react`. CSS uses `--dsw-alias-*` theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-agent-ci',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@ruaibeite/dsh-agent-ci'

    /** Host route. */
    const ROUTE = '/dsh-agent-ci/api'
    /** Poll cadence while a run is in flight. */
    const POLL_MS = 2000

    // ---- copy (bundled fallback; the locale service supplies the real one) --
    const TEXT = {
      zh: {
        'meta.title': 'Agent CI',
        'meta.description': '把真实会话固化为回归用例，在隔离 git worktree 中重跑并检查测试、改动文件、步数与 token。全部本机执行。',
        'nav': 'Agent CI',
        'title': 'Agent CI',
        'subtitle': '把历史会话固化为回归用例：在临时 git worktree 中让 DSH 重做一次，用确定性断言（测试命令 / 改动文件 / 步数 / token）判断是否通过。运行会新建一个会话并真实调用模型。',
        'action.refresh': '刷新',
        'action.new': '新建用例',
        'action.fromSession': '从会话创建',
        'action.save': '保存',
        'action.saving': '保存中…',
        'action.cancel': '取消',
        'action.run': '运行',
        'action.running': '运行中…',
        'action.edit': '编辑',
        'action.delete': '删除',
        'action.export': '导出 JSON',
        'action.back': '返回列表',
        'action.copy': '复制 JSON',
        'action.copied': '已复制',
        'action.retry': '重试',
        'status.loading': '正在读取用例…',
        'status.loadingHint': '首次打开会扫描本机投影缓存，之后只读增量。',
        'status.error': '读取 Agent CI 数据失败',
        'status.empty': '还没有用例',
        'status.emptyHint': '点「新建用例」，或从上面的历史会话下拉里选一个，一键固化。',
        'status.running': '运行中…（每 2 秒轮询）',
        'status.updated': '更新于 {time}',
        'list.name': '名称',
        'list.repo': '仓库',
        'list.model': '模型',
        'list.assertions': '断言',
        'list.lastRun': '最近结果',
        'list.defaultModel': '默认模型',
        'badge.never': '未运行',
        'badge.running': '运行中',
        'form.title.new': '新建用例',
        'form.title.edit': '编辑用例',
        'form.name': '名称',
        'form.nameHint': '留空时取 prompt 第一行。',
        'form.prompt': 'Prompt（用户任务原文）',
        'form.cwd': '仓库绝对路径',
        'form.cwdHint': '必须是 git 仓库内的绝对路径。',
        'form.provider': 'Provider（可空）',
        'form.model': 'Model（可空）',
        'form.testCommand': '测试命令',
        'form.testCommandHint': '在 worktree 中执行，退出码 0 = 通过。',
        'form.forbiddenPaths': '禁止改动的路径前缀',
        'form.forbiddenPathsHint': '逗号分隔，相对仓库根目录；命中即失败。',
        'form.expectFiles': '期望改动的路径前缀',
        'form.expectFilesHint': '逗号分隔；至少命中一个才算通过。',
        'form.maxSteps': '最大步数',
        'form.maxTokens': '最大 token',
        'form.limitHint': '0 或留空 = 不限。',
        'validation.prompt': 'prompt 不能为空',
        'validation.cwd': '需要仓库的绝对路径',
        'validation.number': '需要非负整数（0 = 不限）',
        'session.pick': '从历史会话创建',
        'session.placeholder': '选择最近会话…',
        'session.none': '投影缓存里还没有可用的历史会话。',
        'assert.tests': '测试',
        'assert.steps': '≤{n} 步',
        'assert.tokens': '≤{n} token',
        'assert.none': '无断言',
        'result.title': '运行结果',
        'result.status': '状态',
        'result.reason': '原因',
        'result.steps': '步数',
        'result.tokens': '输入 / 输出',
        'result.totalTokens': '合计 token',
        'result.duration': '耗时',
        'result.testExit': '测试退出码',
        'result.testOutput': '测试输出（尾部）',
        'result.outputEmpty': '没有输出。',
        'result.changedFiles': '改动文件（{n}）',
        'result.noChanges': '没有改动文件。',
        'result.worktree': 'Worktree（保留供排查）',
        'result.error': '错误',
        'result.none': '还没有结果。',
        'reason.ok': '通过',
        'reason.test-failed': '测试失败',
        'reason.forbidden-path': '改动了禁止路径',
        'reason.expect-file-missing': '缺少期望改动',
        'reason.max-steps': '步数超限',
        'reason.max-tokens': 'token 超限',
        'reason.agent-error': 'Agent 出错',
        'reason.no-git': '不是可用的 git 仓库',
        'reason.service-unavailable': '运行服务不可用',
        'status.passed': '通过',
        'status.failed': '失败',
        'status.error': '错误',
        'notice.running': '已有运行在跑，稍后再试。',
        'notice.exported': '已导出 JSON。',
        'notice.copied': '已复制 JSON。',
        'notice.saved': '已保存。',
        'notice.deleted': '已删除。',
        'notice.confirmDelete': '删除用例「{name}」？运行历史不会被删除。',
        'notice.copyFailed': '复制失败，请手动选择文本。',
        'footer.note': '本机运行：只写本插件 cache，不写会话日志；运行会在临时 git worktree 中由 agent 改动代码，结束后删除。',
      },
      en: {
        'meta.title': 'Agent CI',
        'meta.description': 'Freeze real sessions into regression cases, replay them in isolated git worktrees and verify tests, changed files, steps and tokens. Fully local.',
        'nav': 'Agent CI',
        'title': 'Agent CI',
        'subtitle': 'Freeze a past session into a regression case: DSH redoes the task in a temporary git worktree and deterministic assertions (test command / changed files / steps / tokens) decide pass or fail. A run creates a new session and really calls the model.',
        'action.refresh': 'Refresh',
        'action.new': 'New case',
        'action.fromSession': 'From session',
        'action.save': 'Save',
        'action.saving': 'Saving…',
        'action.cancel': 'Cancel',
        'action.run': 'Run',
        'action.running': 'Running…',
        'action.edit': 'Edit',
        'action.delete': 'Delete',
        'action.export': 'Export JSON',
        'action.back': 'Back',
        'action.copy': 'Copy JSON',
        'action.copied': 'Copied',
        'action.retry': 'Retry',
        'status.loading': 'Reading cases…',
        'status.loadingHint': 'The first open scans the local projection cache, later opens only read changes.',
        'status.error': 'Could not read Agent CI data',
        'status.empty': 'No cases yet',
        'status.emptyHint': 'Press "New case", or pick a recent session above to freeze it in one click.',
        'status.running': 'Running… (polling every 2 s)',
        'status.updated': 'Updated {time}',
        'list.name': 'Name',
        'list.repo': 'Repo',
        'list.model': 'Model',
        'list.assertions': 'Assertions',
        'list.lastRun': 'Last run',
        'list.defaultModel': 'Default model',
        'badge.never': 'Never run',
        'badge.running': 'Running',
        'form.title.new': 'New case',
        'form.title.edit': 'Edit case',
        'form.name': 'Name',
        'form.nameHint': 'Defaults to the first prompt line.',
        'form.prompt': 'Prompt (the original task)',
        'form.cwd': 'Absolute repo path',
        'form.cwdHint': 'Must be an absolute path inside a git repository.',
        'form.provider': 'Provider (optional)',
        'form.model': 'Model (optional)',
        'form.testCommand': 'Test command',
        'form.testCommandHint': 'Runs in the worktree; exit code 0 = pass.',
        'form.forbiddenPaths': 'Forbidden path prefixes',
        'form.forbiddenPathsHint': 'Comma separated, relative to the repo root; a hit fails the run.',
        'form.expectFiles': 'Expected path prefixes',
        'form.expectFilesHint': 'Comma separated; at least one must be changed.',
        'form.maxSteps': 'Max steps',
        'form.maxTokens': 'Max tokens',
        'form.limitHint': '0 or empty = unlimited.',
        'validation.prompt': 'Prompt is required',
        'validation.cwd': 'An absolute repo path is required',
        'validation.number': 'A non-negative integer is required (0 = unlimited)',
        'session.pick': 'Create from a session',
        'session.placeholder': 'Pick a recent session…',
        'session.none': 'No usable sessions in the projection cache yet.',
        'assert.tests': 'tests',
        'assert.steps': '≤{n} steps',
        'assert.tokens': '≤{n} tokens',
        'assert.none': 'no assertions',
        'result.title': 'Run result',
        'result.status': 'Status',
        'result.reason': 'Reason',
        'result.steps': 'Steps',
        'result.tokens': 'Input / output',
        'result.totalTokens': 'Total tokens',
        'result.duration': 'Duration',
        'result.testExit': 'Test exit code',
        'result.testOutput': 'Test output (tail)',
        'result.outputEmpty': 'No output.',
        'result.changedFiles': 'Changed files ({n})',
        'result.noChanges': 'No changed files.',
        'result.worktree': 'Worktree (kept for debugging)',
        'result.error': 'Error',
        'result.none': 'No result yet.',
        'reason.ok': 'passed',
        'reason.test-failed': 'test failed',
        'reason.forbidden-path': 'touched a forbidden path',
        'reason.expect-file-missing': 'expected file missing',
        'reason.max-steps': 'too many steps',
        'reason.max-tokens': 'token budget exceeded',
        'reason.agent-error': 'agent error',
        'reason.no-git': 'not a usable git repo',
        'reason.service-unavailable': 'run service unavailable',
        'status.passed': 'Passed',
        'status.failed': 'Failed',
        'status.error': 'Error',
        'notice.running': 'Another run is in progress; try again shortly.',
        'notice.exported': 'JSON exported.',
        'notice.copied': 'JSON copied.',
        'notice.saved': 'Saved.',
        'notice.deleted': 'Deleted.',
        'notice.confirmDelete': 'Delete case "{name}"? Run history is kept.',
        'notice.copyFailed': 'Copy failed; please select the text manually.',
        'footer.note': 'Local only: writes its own cache, never the session log. A run lets the agent edit code inside a temporary git worktree which is removed afterwards.',
      },
    }

    // ---- helpers ---------------------------------------------------------

    /** Whether a language id is Chinese. */
    function isChinese(value) {
      return typeof value === 'string' && /^zh/i.test(value)
    }

    /** The active client locale id, from the locale service or the document. */
    function activeLanguage(ctx) {
      try {
        const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
        if (locale !== null && locale !== undefined) {
          const snapshot = typeof locale.getLocale === 'function'
            ? locale.getLocale()
            : typeof locale.getSnapshot === 'function'
              ? locale.getSnapshot()
              : null
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string' && snapshot.active !== '') {
            return snapshot.active
          }
        }
      } catch {
        /* fall through */
      }
      try {
        const lang = (document.documentElement && document.documentElement.lang) || ''
        const nav = typeof navigator === 'object' && navigator !== null ? navigator.language || '' : ''
        return isChinese(lang) || isChinese(nav) ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /** Resolve a translation function from props/bundled dicts. */
    function textOf(t, zh) {
      if (typeof t === 'function') return t
      const dict = zh ? TEXT.zh : TEXT.en
      return (key, vars) => {
        let text = dict[key] ?? TEXT.en[key] ?? key
        if (vars !== null && typeof vars === 'object') {
          for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
        }
        return text
      }
    }

    /** Whether this rendered page should speak Chinese. */
    function pageIsChinese(props) {
      const options = props !== null && typeof props === 'object' ? props : {}
      try {
        if (typeof options.getLanguage === 'function') {
          const language = options.getLanguage()
          if (typeof language === 'string' && language !== '') return isChinese(language)
        }
      } catch {
        /* ignore */
      }
      if (typeof options.language === 'string' && options.language !== '') return isChinese(options.language)
      return isChinese(activeLanguage(null))
    }

    /** `HH:MM:SS`, locale-agnostic. */
    function fmtClock(value) {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Compact duration: 820ms / 4.2s / 1m 05s. */
    function fmtDuration(ms) {
      const value = Number.isFinite(ms) ? Math.max(0, ms) : 0
      if (value < 1000) return `${Math.round(value)}ms`
      if (value < 60000) return `${(value / 1000).toFixed(1)}s`
      const minutes = Math.floor(value / 60000)
      const seconds = Math.round((value % 60000) / 1000)
      return `${minutes}m ${String(seconds).padStart(2, '0')}s`
    }

    /** Compact integer (`12.3k`). */
    function fmtCount(value) {
      const number = Number.isFinite(value) ? value : 0
      if (number >= 1e6) return `${Math.round(number / 1e5) / 10}m`
      if (number >= 1000) return `${Math.round(number / 100) / 10}k`
      return String(Math.trunc(number))
    }

    /** Last two path segments of the repo. */
    function shortCwd(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '—'
      const parts = cwd.replace(/\\/g, '/').split('/').filter((part) => part !== '')
      return parts.slice(-2).join('/') || cwd
    }

    /** `tests / ≤20 steps / ≤50k tokens` summary. */
    function assertionSummary(testCase, t) {
      const assertions = testCase !== null && typeof testCase === 'object' && testCase.assertions !== null && typeof testCase.assertions === 'object'
        ? testCase.assertions
        : {}
      const parts = []
      if (typeof assertions.testCommand === 'string' && assertions.testCommand !== '') parts.push(t('assert.tests'))
      if (Number.isFinite(assertions.maxSteps) && assertions.maxSteps > 0) parts.push(t('assert.steps', { n: assertions.maxSteps }))
      if (Number.isFinite(assertions.maxTokens) && assertions.maxTokens > 0) parts.push(t('assert.tokens', { n: fmtCount(assertions.maxTokens) }))
      if (Array.isArray(assertions.forbiddenPaths) && assertions.forbiddenPaths.length > 0) parts.push('no ' + assertions.forbiddenPaths.join(','))
      if (Array.isArray(assertions.expectFiles) && assertions.expectFiles.length > 0) parts.push('+' + assertions.expectFiles.join(','))
      return parts.length === 0 ? t('assert.none') : parts.join(' · ')
    }

    /** Map caseId -> most recent run (runs arrive newest-first). */
    function lastRunsByCase(runs) {
      const map = new Map()
      if (!Array.isArray(runs)) return map
      for (const run of runs) {
        if (run !== null && typeof run === 'object' && typeof run.caseId === 'string' && !map.has(run.caseId)) {
          map.set(run.caseId, run)
        }
      }
      return map
    }

    /** Badge tone for a run (or 'muted' when never run). */
    function runTone(run) {
      if (run === null || run === undefined) return 'muted'
      if (run.status === 'passed') return 'pass'
      if (run.status === 'failed') return 'fail'
      return 'error'
    }

    /** Localized status label. */
    function statusText(run, t) {
      if (run === null || run === undefined) return t('badge.never')
      if (run.status === 'passed') return t('status.passed')
      if (run.status === 'failed') return t('status.failed')
      return t('status.error')
    }

    /** Localized reason label. */
    function reasonText(reason, t) {
      const key = typeof reason === 'string' && reason !== '' ? reason : 'agent-error'
      return t(`reason.${key}`)
    }

    /** Whether the report describes a running case. */
    function isRunningStatus(report) {
      return report !== null && typeof report === 'object'
        && report.status !== null && typeof report.status === 'object'
        && report.status.running === true
    }

    /** Split a comma/newline separated list input. */
    function parseListInput(text) {
      if (typeof text !== 'string') return []
      const seen = new Set()
      const result = []
      for (const part of text.split(/[,\n]/)) {
        const value = part.trim()
        if (value === '' || seen.has(value)) continue
        seen.add(value)
        result.push(value)
      }
      return result
    }

    /** Parse an optional non-negative integer field; `null` = absent, NaN = invalid. */
    function parseLimit(text) {
      if (typeof text === 'number') {
        if (!Number.isInteger(text) || text < 0) return Number.NaN
        return text === 0 ? null : text
      }
      if (typeof text !== 'string' || text.trim() === '') return null
      const value = Number(text.trim())
      if (!Number.isInteger(value) || value < 0) return Number.NaN
      return value === 0 ? null : value
    }

    /** Fresh draft for the create form. */
    function emptyDraft() {
      return {
        name: '', prompt: '', cwd: '', provider: '', model: '',
        testCommand: '', forbiddenPaths: '', expectFiles: '', maxSteps: '', maxTokens: '',
      }
    }

    /** Draft from an existing case. */
    function draftFromCase(testCase) {
      const assertions = testCase !== null && typeof testCase === 'object' && testCase.assertions !== null && typeof testCase.assertions === 'object'
        ? testCase.assertions
        : {}
      return {
        name: typeof testCase?.name === 'string' ? testCase.name : '',
        prompt: typeof testCase?.prompt === 'string' ? testCase.prompt : '',
        cwd: typeof testCase?.cwd === 'string' ? testCase.cwd : '',
        provider: typeof testCase?.provider === 'string' ? testCase.provider : '',
        model: typeof testCase?.model === 'string' ? testCase.model : '',
        testCommand: typeof assertions.testCommand === 'string' ? assertions.testCommand : '',
        forbiddenPaths: Array.isArray(assertions.forbiddenPaths) ? assertions.forbiddenPaths.join(', ') : '',
        expectFiles: Array.isArray(assertions.expectFiles) ? assertions.expectFiles.join(', ') : '',
        maxSteps: Number.isFinite(assertions.maxSteps) && assertions.maxSteps > 0 ? String(assertions.maxSteps) : '',
        maxTokens: Number.isFinite(assertions.maxTokens) && assertions.maxTokens > 0 ? String(assertions.maxTokens) : '',
      }
    }

    /** Draft prefilled from a report session entry. */
    function draftFromSession(session) {
      const draft = emptyDraft()
      if (session === null || typeof session !== 'object') return draft
      return {
        ...draft,
        name: typeof session.title === 'string' ? session.title : '',
        prompt: typeof session.prompt === 'string' ? session.prompt : '',
        cwd: typeof session.cwd === 'string' ? session.cwd : '',
        provider: typeof session.provider === 'string' ? session.provider : '',
        model: typeof session.model === 'string' ? session.model : '',
      }
    }

    /** Draft -> create/update payload fields. */
    function draftToFields(draft) {
      const fields = {
        name: typeof draft.name === 'string' ? draft.name.trim() : '',
        prompt: typeof draft.prompt === 'string' ? draft.prompt.trim() : '',
        cwd: typeof draft.cwd === 'string' ? draft.cwd.trim() : '',
        provider: typeof draft.provider === 'string' && draft.provider.trim() !== '' ? draft.provider.trim() : null,
        model: typeof draft.model === 'string' && draft.model.trim() !== '' ? draft.model.trim() : null,
        assertions: {},
      }
      if (fields.name === '') delete fields.name
      const command = typeof draft.testCommand === 'string' ? draft.testCommand.trim() : ''
      if (command !== '') fields.assertions.testCommand = command
      const forbidden = parseListInput(draft.forbiddenPaths)
      if (forbidden.length > 0) fields.assertions.forbiddenPaths = forbidden
      const expected = parseListInput(draft.expectFiles)
      if (expected.length > 0) fields.assertions.expectFiles = expected
      const maxSteps = parseLimit(draft.maxSteps)
      if (maxSteps !== null) fields.assertions.maxSteps = maxSteps
      const maxTokens = parseLimit(draft.maxTokens)
      if (maxTokens !== null) fields.assertions.maxTokens = maxTokens
      return fields
    }

    function isAbsoluteInput(value) {
      return typeof value === 'string' && (/^\//.test(value.trim()) || /^[A-Za-z]:[\\/]/.test(value.trim()))
    }

    /** Client-side form validation (the host validates again). */
    function validateDraft(draft) {
      const errors = {}
      if (draft === null || typeof draft !== 'object' || typeof draft.prompt !== 'string' || draft.prompt.trim() === '') {
        errors.prompt = 'validation.prompt'
      }
      if (draft === null || typeof draft !== 'object' || !isAbsoluteInput(draft.cwd)) errors.cwd = 'validation.cwd'
      for (const key of ['maxSteps', 'maxTokens']) {
        const parsed = parseLimit(draft === null || typeof draft !== 'object' ? undefined : draft[key])
        if (Number.isNaN(parsed)) errors[key] = 'validation.number'
      }
      return { ok: Object.keys(errors).length === 0, errors }
    }

    /** Save button gate (empty prompt is the main one). */
    function canSaveDraft(draft) {
      return validateDraft(draft).ok
    }

    // ---- network ---------------------------------------------------------

    /** GET the report; throws on a non-ok payload. */
    async function fetchReport() {
      const response = await fetch(`${ROUTE}?action=report`, { headers: { accept: 'application/json' } })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || payload.ok !== true) {
        throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload
    }

    /** POST one action; 409 is returned (not thrown) so the UI can explain it. */
    async function postAction(body) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload
      if (response.status === 409 && payload !== null && typeof payload === 'object') return payload
      const error = new Error(
        payload !== null && typeof payload.detail === 'string'
          ? payload.detail
          : payload !== null && typeof payload.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`,
      )
      error.payload = payload
      throw error
    }

    /** Copy text to the clipboard (best effort). */
    function copyPlainText(text) {
      try {
        if (typeof navigator === 'object' && navigator !== null && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return Promise.resolve(navigator.clipboard.writeText(text)).then(() => true, () => false)
        }
      } catch {
        /* fall through */
      }
      return Promise.resolve(false)
    }

    // ---- styles ----------------------------------------------------------

    const CSS = `
.aci-root{display:flex;flex-direction:column;gap:14px;padding:2px 0 20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.aci-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.aci-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.aci-sub{margin-top:5px;max-width:760px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55}
.aci-head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aci-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.5}
.aci-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}
.aci-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.aci-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.aci-btn:disabled{opacity:.5;cursor:not-allowed}
.aci-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.aci-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.aci-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.aci-toolbar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aci-select{max-width:280px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px}
.aci-panel{display:flex;flex-direction:column;gap:10px;padding:13px 14px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.aci-panel-title{margin:0;font-size:15px;font-weight:600}
.aci-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.aci-row:first-of-type{border-top:none}
.aci-row-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.aci-row-name{font-size:13px;font-weight:600}
.aci-row-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.aci-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0}
.aci-badge{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap}
.aci-badge-pass{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.aci-badge-fail{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.aci-badge-error{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.aci-badge-muted{color:var(--dsw-alias-label-tertiary)}
.aci-badge-run{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.aci-field{display:flex;flex-direction:column;gap:4px}
.aci-field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.aci-label{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.aci-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
.aci-input,.aci-textarea{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.5}
.aci-input:focus,.aci-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0;border-color:transparent}
.aci-textarea{min-height:96px;resize:vertical;font-family:inherit}
.aci-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.aci-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.aci-state{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.aci-state-title{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aci-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.aci-metric{display:flex;flex-direction:column;gap:1px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.aci-metric-label{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.aci-metric-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.aci-code{max-height:220px;overflow:auto;margin:0;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.aci-files{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6}
.aci-foot{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.aci-notice{color:var(--dsw-alias-label-secondary);font-size:11.5px}
`

    // ---- components ------------------------------------------------------

    /** Small status badge. */
    function Badge(props) {
      const tone = typeof props.tone === 'string' ? props.tone : 'muted'
      return h('span', { className: `aci-badge aci-badge-${tone}` }, props.children)
    }

    /** Plain button with the shared class set. */
    function Btn(props) {
      const className = ['aci-btn', props.primary === true ? 'aci-btn-primary' : '', props.danger === true ? 'aci-btn-danger' : '', props.className ?? '']
        .filter((part) => part !== '').join(' ')
      return h('button', {
        type: 'button',
        className,
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.onClick,
      }, props.children)
    }

    /** Loading / error / empty state block. */
    function StateView(props) {
      const kind = typeof props.kind === 'string' ? props.kind : 'loading'
      const title = kind === 'loading' ? props.tr('status.loading') : kind === 'error' ? props.tr('status.error') : props.tr('status.empty')
      const hint = kind === 'loading' ? props.tr('status.loadingHint') : kind === 'error' ? props.error : props.tr('status.emptyHint')
      return h('div', { className: 'aci-state', 'data-state': kind },
        h('div', { className: 'aci-state-title' }, title),
        hint !== undefined && hint !== '' ? h('div', { className: 'aci-note' }, hint) : null,
        kind === 'error' && typeof props.onRetry === 'function'
          ? h(Btn, { onClick: props.onRetry }, props.tr('action.retry'))
          : null,
      )
    }

    /** Header with refresh / running indicator. */
    function Header(props) {
      const tr = props.tr
      return h('div', { className: 'aci-head' },
        h('div', null,
          h('h2', { className: 'aci-title' }, tr('title')),
          h('div', { className: 'aci-sub' }, tr('subtitle')),
        ),
        h('div', { className: 'aci-head-right' },
          props.running === true ? h(Badge, { tone: 'run' }, tr('status.running')) : null,
          props.updatedAt !== undefined && props.updatedAt !== '' ? h('span', { className: 'aci-note' }, tr('status.updated', { time: props.updatedAt })) : null,
          h(Btn, { onClick: props.onRefresh, disabled: props.busy === true }, tr('action.refresh')),
        ),
      )
    }

    /** One case row. */
    function CaseRow(props) {
      const tr = props.tr
      const testCase = props.case
      const lastRun = props.lastRun
      const running = props.running === true
      return h('div', { className: 'aci-row', 'data-case-id': testCase.id },
        h('div', { className: 'aci-row-main' },
          h('div', { className: 'aci-row-name' }, testCase.name),
          h('div', { className: 'aci-row-meta' },
            h('span', null, tr('list.repo') + ': ' + shortCwd(testCase.cwd)),
            h('span', null, tr('list.model') + ': ' + (testCase.provider && testCase.model ? `${testCase.provider}/${testCase.model}` : tr('list.defaultModel'))),
            h('span', null, tr('list.assertions') + ': ' + assertionSummary(testCase, tr)),
          ),
        ),
        h('div', { className: 'aci-row-actions' },
          lastRun !== undefined && lastRun !== null
            ? h(Badge, { tone: runTone(lastRun) }, statusText(lastRun, tr))
            : h(Badge, { tone: 'muted' }, tr('badge.never')),
          running ? h(Badge, { tone: 'run' }, tr('badge.running')) : null,
          h(Btn, { primary: true, disabled: running || props.busy === true, onClick: () => props.onRun(testCase) }, running ? tr('action.running') : tr('action.run')),
          h(Btn, { onClick: () => props.onEdit(testCase), disabled: running }, tr('action.edit')),
          h(Btn, { onClick: () => props.onExport(testCase) }, tr('action.export')),
          h(Btn, { danger: true, onClick: () => props.onDelete(testCase), disabled: running }, tr('action.delete')),
        ),
      )
    }

    /** Case list + toolbar + session picker. */
    function CaseList(props) {
      const tr = props.tr
      const cases = Array.isArray(props.cases) ? props.cases : []
      const sessions = Array.isArray(props.sessions) ? props.sessions : []
      const lastRuns = lastRunsByCase(props.runs)
      return h('div', { className: 'aci-panel' },
        h('div', { className: 'aci-toolbar' },
          h('div', { className: 'aci-panel-title' }, `${tr('list.name')} · ${cases.length}`),
          h('div', { className: 'aci-toolbar-right' },
            sessions.length > 0
              ? h('select', {
                className: 'aci-select',
                'data-role': 'session-picker',
                value: '',
                onChange: (event) => {
                  const id = event?.target?.value
                  if (typeof id === 'string' && id !== '') props.onFromSession(id)
                },
              },
              h('option', { value: '' }, tr('session.pick')),
              sessions.map((session) => h('option', { key: session.id, value: session.id }, session.title)),
              )
              : h('span', { className: 'aci-note' }, tr('session.none')),
            h(Btn, { primary: true, onClick: props.onNew }, tr('action.new')),
          ),
        ),
        cases.length === 0
          ? h(StateView, { kind: 'empty', tr, error: '' })
          : cases.map((testCase) => h(CaseRow, {
            key: testCase.id,
            case: testCase,
            tr,
            lastRun: lastRuns.get(testCase.id),
            running: props.status !== null && typeof props.status === 'object' && props.status.caseId === testCase.id,
            busy: props.busy,
            onRun: props.onRun,
            onEdit: props.onEdit,
            onExport: props.onExport,
            onDelete: props.onDelete,
          })),
      )
    }

    /** Create/edit form. */
    function CaseForm(props) {
      const tr = props.tr
      const draft = props.draft
      const errors = props.errors !== null && typeof props.errors === 'object' ? props.errors : {}
      const validation = validateDraft(draft)
      const allErrors = { ...validation.errors, ...errors }
      const change = (field) => (event) => props.onChange(field, event?.target?.value ?? '')
      const field = (key, label, hint, rows) => h('label', { className: 'aci-field' },
        h('span', { className: 'aci-label' }, label),
        rows === true
          ? h('textarea', { className: 'aci-textarea', value: draft[key], onChange: change(key), 'data-field': key })
          : h('input', { className: 'aci-input', type: 'text', value: draft[key], onChange: change(key), 'data-field': key }),
        hint !== undefined && hint !== '' ? h('span', { className: 'aci-hint' }, hint) : null,
        allErrors[key] !== undefined ? h('span', { className: 'aci-error' }, tr(allErrors[key])) : null,
      )
      return h('div', { className: 'aci-panel' },
        h('h3', { className: 'aci-panel-title' }, props.editing === true ? tr('form.title.edit') : tr('form.title.new')),
        field('name', tr('form.name'), tr('form.nameHint')),
        field('prompt', tr('form.prompt'), '', true),
        field('cwd', tr('form.cwd'), tr('form.cwdHint')),
        h('div', { className: 'aci-field-row' },
          field('provider', tr('form.provider'), ''),
          field('model', tr('form.model'), ''),
        ),
        field('testCommand', tr('form.testCommand'), tr('form.testCommandHint')),
        field('forbiddenPaths', tr('form.forbiddenPaths'), tr('form.forbiddenPathsHint')),
        field('expectFiles', tr('form.expectFiles'), tr('form.expectFilesHint')),
        h('div', { className: 'aci-field-row' },
          field('maxSteps', tr('form.maxSteps'), tr('form.limitHint')),
          field('maxTokens', tr('form.maxTokens'), tr('form.limitHint')),
        ),
        props.error !== undefined && props.error !== '' ? h('div', { className: 'aci-error' }, props.error) : null,
        h('div', { className: 'aci-form-actions' },
          h(Btn, {
            primary: true,
            disabled: !canSaveDraft(draft) || props.saving === true,
            onClick: () => props.onSave(draftToFields(draft), props.caseId),
          }, props.saving === true ? tr('action.saving') : tr('action.save')),
          h(Btn, { onClick: props.onCancel }, tr('action.cancel')),
        ),
      )
    }

    /** Run result detail panel. */
    function RunResultPanel(props) {
      const tr = props.tr
      const run = props.run
      if (run === null || run === undefined || typeof run !== 'object') {
        return h('div', { className: 'aci-panel' }, h(StateView, { kind: 'empty', tr, error: '' }))
      }
      const changed = Array.isArray(run.changedFiles) ? run.changedFiles : []
      const output = typeof run.testOutputTail === 'string' ? run.testOutputTail : ''
      return h('div', { className: 'aci-panel', 'data-run-id': run.id ?? '' },
        h('div', { className: 'aci-toolbar' },
          h('h3', { className: 'aci-panel-title' }, `${tr('result.title')} · ${run.caseName ?? run.caseId ?? ''}`),
          h('div', { className: 'aci-toolbar-right' },
            h(Badge, { tone: runTone(run) }, statusText(run, tr)),
            h(Btn, { onClick: props.onBack }, tr('action.back')),
            h(Btn, { onClick: () => props.onCopy(run) }, props.copied === true ? tr('action.copied') : tr('action.copy')),
          ),
        ),
        h('div', { className: 'aci-note' },
          `${reasonText(run.reason, tr)} · ${fmtDuration(run.durationMs)}${run.at ? ' · ' + fmtClock(run.at) : ''}`,
        ),
        h('div', { className: 'aci-grid' },
          metric(tr('result.steps'), String(run.steps ?? 0)),
          metric(tr('result.tokens'), `${fmtCount(run.inputTokens)} / ${fmtCount(run.outputTokens)}`),
          metric(tr('result.totalTokens'), fmtCount(run.totalTokens)),
          metric(tr('result.testExit'), run.testExit === 0 ? '0' : run.testExit === 1 ? '1' : '—'),
        ),
        run.error !== undefined && run.error !== '' ? h('div', { className: 'aci-error' }, `${tr('result.error')}: ${run.error}`) : null,
        h('div', { className: 'aci-field' },
          h('span', { className: 'aci-label' }, tr('result.changedFiles', { n: changed.length })),
          changed.length === 0
            ? h('div', { className: 'aci-note' }, tr('result.noChanges'))
            : h('div', { className: 'aci-files' }, changed.map((file, index) => h('span', { key: `${file}:${index}` }, file))),
        ),
        h('div', { className: 'aci-field' },
          h('span', { className: 'aci-label' }, tr('result.testOutput')),
          h('pre', { className: 'aci-code' }, output === '' ? tr('result.outputEmpty') : output),
        ),
        typeof run.worktree === 'string' && run.worktree !== ''
          ? h('div', { className: 'aci-note' }, `${tr('result.worktree')}: ${run.worktree}`)
          : null,
      )
      function metric(label, value) {
        return h('div', { className: 'aci-metric' },
          h('span', { className: 'aci-metric-label' }, label),
          h('span', { className: 'aci-metric-value' }, String(value)),
        )
      }
    }

    /** Settings icon. */
    function AgentCiIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        h('path', { d: 'M4 7h7M15 7h5M4 17h3M11 17h9' }),
        h('circle', { cx: 13, cy: 7, r: 2 }),
        h('circle', { cx: 9, cy: 17, r: 2 }),
        h('path', { d: 'M17 12.5l1.8 1.8L22 11' }),
      )
    }

    /** The settings page. */
    function AgentCiSection(props) {
      const zh = pageIsChinese(props)
      const tr = textOf(props.t, zh)
      const load = typeof props.fetchReport === 'function' ? props.fetchReport : fetchReport
      const send = typeof props.postAction === 'function' ? props.postAction : postAction
      const confirmFn = typeof props.confirm === 'function' ? props.confirm : (message) => {
        try {
          return typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true
        } catch {
          return true
        }
      }

      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(true)
      const [error, setError] = React.useState('')
      const [view, setView] = React.useState({ kind: 'list' })
      const [notice, setNotice] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [formError, setFormError] = React.useState('')
      const [updatedAt, setUpdatedAt] = React.useState('')
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        let alive = true
        setBusy(true)
        load()
          .then((report) => {
            if (!alive) return
            setData(report)
            setError('')
            setUpdatedAt(fmtClock(Date.now()))
          })
          .catch((failure) => {
            if (alive) setError(failure !== null && typeof failure.message === 'string' ? failure.message : String(failure))
          })
          .finally(() => {
            if (alive) setBusy(false)
          })
        return () => {
          alive = false
          mounted.current = false
        }
      }, [])

      const running = isRunningStatus(data)

      React.useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => {
          load()
            .then((report) => {
              if (!mounted.current) return
              setData(report)
              setError('')
              setUpdatedAt(fmtClock(Date.now()))
            })
            .catch(() => {
              /* a transient poll failure keeps the last report */
            })
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [running])

      /** Re-fetch the report and update the visible state. */
      async function reload(options = {}) {
        if (options.quiet !== true) setBusy(true)
        try {
          const report = await load()
          if (!mounted.current) return null
          setData(report)
          setError('')
          setUpdatedAt(fmtClock(Date.now()))
          return report
        } catch (failure) {
          if (mounted.current) setError(failure !== null && typeof failure.message === 'string' ? failure.message : String(failure))
          return null
        } finally {
          if (mounted.current && options.quiet !== true) setBusy(false)
        }
      }

      /** Run one case; the host serializes runs, so a 409 is reported inline. */
      async function runCaseAction(testCase) {
        setNotice('')
        setBusy(true)
        try {
          const payload = await send({ action: 'run', id: testCase.id })
          if (payload !== null && payload.ok === true && payload.run !== undefined) {
            setView({ kind: 'result', run: payload.run })
          } else if (payload !== null && payload.error === 'run-in-progress') {
            setNotice(tr('notice.running'))
          } else if (payload !== null && typeof payload.error === 'string') {
            setError(payload.error)
          }
        } catch (failure) {
          setError(failure !== null && typeof failure.message === 'string' ? failure.message : String(failure))
        } finally {
          if (mounted.current) setBusy(false)
          void reload({ quiet: true })
        }
      }

      /** Create or update, then go back to the list. */
      async function saveCase(fields, caseId) {
        setSaving(true)
        setFormError('')
        try {
          if (typeof caseId === 'string' && caseId !== '') {
            await send({ action: 'update', id: caseId, patch: fields })
          } else {
            await send({ action: 'create', fields })
          }
          setNotice(tr('notice.saved'))
          setView({ kind: 'list' })
          await reload({ quiet: true })
        } catch (failure) {
          const message = failure !== null && typeof failure.message === 'string' ? failure.message : String(failure)
          setFormError(message)
        } finally {
          if (mounted.current) setSaving(false)
        }
      }

      /** Delete after a confirm. */
      async function deleteCaseAction(testCase) {
        const message = tr('notice.confirmDelete', { name: testCase.name })
        if (confirmFn(message) !== true) return
        try {
          await send({ action: 'delete', id: testCase.id })
          setNotice(tr('notice.deleted'))
          await reload({ quiet: true })
        } catch (failure) {
          setError(failure !== null && typeof failure.message === 'string' ? failure.message : String(failure))
        }
      }

      /** Export the case definition (or hand it to a test seam). */
      function exportCase(testCase) {
        try {
          if (typeof props.exportJson === 'function') {
            props.exportJson(testCase)
          } else {
            const blob = new Blob([JSON.stringify(testCase, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `${testCase.id}.json`
            anchor.click()
            URL.revokeObjectURL(url)
          }
          setNotice(tr('notice.exported'))
        } catch {
          setNotice('')
        }
      }

      /** Copy the run JSON. */
      async function copyRun(run) {
        const text = JSON.stringify(run, null, 2)
        if (typeof props.copyText === 'function') {
          const ok = await Promise.resolve(props.copyText(text))
          setNotice(ok === false ? tr('notice.copyFailed') : tr('notice.copied'))
          return
        }
        const ok = await copyPlainText(text)
        setNotice(ok ? tr('notice.copied') : tr('notice.copyFailed'))
      }

      /** Open the form for an existing case. */
      function editCase(testCase) {
        setFormError('')
        setView({ kind: 'form', draft: draftFromCase(testCase), caseId: testCase.id })
      }

      /** Open the form prefilled from a report session. */
      function fromSession(sessionId) {
        const sessions = Array.isArray(data?.sessions) ? data.sessions : []
        const session = sessions.find((entry) => entry.id === sessionId)
        if (session === undefined) return
        setFormError('')
        setView({ kind: 'form', draft: draftFromSession(session), caseId: '' })
      }

      let body = null
      if (data === null && error !== '') {
        body = h(StateView, { kind: 'error', tr, error, onRetry: () => { void reload() } })
      } else if (data === null) {
        body = h(StateView, { kind: 'loading', tr, error: '' })
      } else if (view.kind === 'form') {
        body = h(CaseForm, {
          tr,
          draft: view.draft,
          caseId: view.caseId,
          editing: typeof view.caseId === 'string' && view.caseId !== '',
          saving,
          error: formError,
          onChange: (field, value) => setView({ ...view, draft: { ...view.draft, [field]: value } }),
          onSave: (fields, caseId) => { void saveCase(fields, caseId) },
          onCancel: () => { setView({ kind: 'list' }); setFormError('') },
        })
      } else if (view.kind === 'result') {
        body = h(RunResultPanel, {
          tr,
          run: view.run,
          copied: false,
          onBack: () => setView({ kind: 'list' }),
          onCopy: (run) => { void copyRun(run) },
        })
      } else {
        body = h(CaseList, {
          tr,
          cases: Array.isArray(data.cases) ? data.cases : [],
          runs: Array.isArray(data.runs) ? data.runs : [],
          sessions: Array.isArray(data.sessions) ? data.sessions : [],
          status: data.status,
          busy,
          onNew: () => { setFormError(''); setView({ kind: 'form', draft: emptyDraft(), caseId: '' }) },
          onFromSession: fromSession,
          onRun: (testCase) => { void runCaseAction(testCase) },
          onEdit: editCase,
          onDelete: (testCase) => { void deleteCaseAction(testCase) },
          onExport: exportCase,
        })
      }

      return h('div', { className: 'aci-root' },
        h('style', null, CSS),
        h(Header, { tr, running, busy, updatedAt, onRefresh: () => { void reload() } }),
        notice !== '' ? h('div', { className: 'aci-notice' }, notice) : null,
        error !== '' && data !== null ? h('div', { className: 'aci-error' }, error) : null,
        body,
        h('div', { className: 'aci-foot' }, tr('footer.note')),
      )
    }

    // ---- plugin registration --------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: TEXT.zh, en: TEXT.en }),
          'agent-ci: dictionaries',
        )
        const getLanguage = () => activeLanguage(ctx)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'agent-ci',
              order: 4,
              label: () => (/^zh/i.test(getLanguage()) ? 'Agent CI' : 'Agent CI'),
              locale: NS,
              inject: () => ({ fetchReport, getLanguage }),
            },
            AgentCiSection,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'agent-ci' }, AgentCiIcon),
        )
      },
      // Pure model surface for the no-browser tests; the module loader only
      // reads `inject` and `apply`, so this is inert at runtime.
      __model: {
        NS,
        ROUTE,
        POLL_MS,
        TEXT,
        isChinese,
        activeLanguage,
        textOf,
        pageIsChinese,
        fmtClock,
        fmtDuration,
        fmtCount,
        shortCwd,
        assertionSummary,
        lastRunsByCase,
        runTone,
        statusText,
        reasonText,
        isRunningStatus,
        parseListInput,
        parseLimit,
        emptyDraft,
        draftFromCase,
        draftFromSession,
        draftToFields,
        validateDraft,
        canSaveDraft,
        fetchReport,
        postAction,
        StateView,
        Header,
        CaseRow,
        CaseList,
        CaseForm,
        RunResultPanel,
        AgentCiSection,
        AgentCiIcon,
      },
    }
  },
})
