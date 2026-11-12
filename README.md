# dsh-agent-ci — Agent CI for DeepSeek Harness

Freeze a real session into a regression case, replay it in a throwaway `git worktree`, and check
deterministic assertions: the test command, the changed files, the step count and the token budget.
Everything runs locally; results are kept as a comparable history.

> Status: v0.1.0. Requires DeepSeek Harness 0.2.x and a `git` binary on `PATH`.

## Install

**From the plugin market** — install「Agent CI」from the DSH plugin market and restart the app.

**From GitHub**

```sh
git clone https://github.com/ruaibeite/dsh-agent-ci
# link it into the active profile and add "@ruaibeite/dsh-agent-ci" to
# profiles/<profile>/package.json -> dsh.profile.bundles, then restart DSH
```

The plugin registers a `settings.section` page («Agent CI») and one host route,
`/dsh-agent-ci/api`.

## What it does

1. **Freeze a case.** Pick a recent session (title/prompt/cwd/model are prefilled) or create a
   case by hand: prompt, repository path, optional model, and assertions.
2. **Run it.** The plugin creates a detached worktree at the repo `HEAD`, starts a fresh DSH agent
   inside it with the same prompt, waits for the agent to go idle, and then checks:
   - `testCommand` exits `0`,
   - no changed file hits a `forbiddenPaths` prefix,
   - at least one changed file matches `expectFiles` (when set),
   - `steps <= maxSteps` and `input+output tokens <= maxTokens` (when set).
3. **Read the verdict.** One result per run: `passed` / `failed` / `error`, a reason
   (`ok`, `test-failed`, `forbidden-path`, `expect-file-missing`, `max-steps`, `max-tokens`,
   `agent-error`, `no-git`, `service-unavailable`), steps, tokens, changed files and the tail of the
   test output. The last 50 runs are kept; each case shows its most recent result.

The page also offers **export JSON** for every case so a case definition can be fed into your own CI.

## How it works

- **Cases** are stored in `$DSH_HOME/cache/agent-ci/cases.json` (max 100), **runs** in
  `$DSH_HOME/cache/agent-ci/runs.json` (last 50). Both are written atomically (temp file + rename).
- **Recent sessions** shown by “create from session” are read from
  `$DSH_HOME/storages/session_projcache/sessions/*.json` (title, first prompt, cwd, model, steps,
  last activity). The scan is incremental (path + size + mtime).
- **Isolation**: every run gets its own `os.tmpdir()/dsh-agent-ci/case-*` worktree created with
  `git -C <repo> worktree add --detach <dir> HEAD`; it is removed after the run. Only if removal
  fails is the path kept in the result for debugging.
- **Metrics** are read from the injected `sessionQuery.readSession(...)` events (`step/start`
  count and `assistant/message.data.usage`), before the temporary agent session is disposed.
- The run pipeline is dependency-injected (`runCase({ case, deps })`), so it is covered by
  fake-service unit tests without a Harness process or a model call.

## Privacy

- Local only: no network request, no upload, no telemetry.
- The plugin only **reads** the projection cache it needs for the session picker; it never writes
  session logs, never appends events and never touches `.credentials.yaml`.
- The only files the plugin writes are its own `$DSH_HOME/cache/agent-ci/*.json`.
- A run does create a **new DSH session** and really calls the model inside the temporary
  worktree; the repository working tree itself is never modified.

## Known limitations (v0.1.0)

- Only **git repositories** with at least one commit work; a non-git directory or a repo without
  commits yields `error/no-git`. `git` must be on `PATH`.
- A run creates a visible session and costs tokens. Case assertions are **deterministic checks**,
  not an LLM judge; the test command is supplied by you.
- Runs are **single-concurrency** per Harness process; a second request gets
  `run-in-progress` / HTTP 409.
- Worktree removal is best-effort; a failed removal keeps the directory and records its path.
- The last 50 runs are kept; older runs are dropped. No cross-machine sync or CI upload — use
  “export JSON” and your own pipeline.
- “Create from session” lists the 30 most recent sessions from the projection cache; sessions that
  were never projected (or have no prompt/cwd) are not listed.

## Verify

```sh
cd dsh-agent-ci
npm test    # node test/host.mjs && node test/render.mjs
```

The tests are offline, need no browser and no real DSH process: host tests use `mkdtemp` homes and
fake `agents`/`subprocess`/`sessionQuery` services, browser tests run `client.js` in a `node:vm`
mini-React harness.

## License

MIT — see [LICENSE](./LICENSE).
