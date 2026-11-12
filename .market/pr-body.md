<!-- PR title: Add ruaibeite/dsh-agent-ci -->

Adds one entry file:

`data/plugins/ruaibeite__dsh-agent-ci.yml`

- Single entry; no other files touched, and the generated READMEs are left untouched.
- The repository declares `dsh.bundle` in `package.json` (with `cordis.patch.yml`) and ships real host + client code.
- `dsh-plugin` topic is set on the repository.
- Description states what the code does: the host half freezes a recorded session into a regression case (prompt, repository path, optional model, deterministic assertions), then runs it in a throwaway `git worktree` by creating a fresh DSH agent in that worktree (`ctx.agents.create` + `meta.cwd`), sending the recorded prompt and waiting for it to go idle; it then checks the test command's exit code, changed files against `forbiddenPaths` / `expectFiles`, and the step / token limits read from the new session's events. Cases live in `$DSH_HOME/cache/agent-ci/cases.json` (max 100), the last 50 runs in `runs.json`; runs are single-concurrency. The client half adds an **Agent CI** section to Settings with a case list, create/edit/delete, create-from-session, a run button with polling, and a result panel (reason, steps, tokens, changed files, test output tail).
- Runs create a new DSH session and really call the model; the repository working tree is never modified (detached worktree, removed after the run). No network request or upload.
- Icon is a GitHub-hosted raster (`assets/icon-180.png`).
- No npm package; installs from GitHub. Verified with `npm test` (35 host + 12 browser-harness tests) and a real `dsh --profile web` boot in an isolated `DSH_HOME` (route `GET /dsh-agent-ci/api?action=report` → 200 JSON). Actual model-running evaluation requires a configured model and is performed by the user.
- The repository was created immediately before this PR, so the submission gate's 1-day repository-age check will fail until it clears on its own; nothing else is pending.