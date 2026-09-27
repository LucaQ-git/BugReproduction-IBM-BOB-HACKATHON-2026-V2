# BugRep-AI

> **From bug report to verified repair.** IBM Bob agents reproduce a bug with failing tests, write a repair,
> prove it with the **same locked tests**, and wait for your approval. Then share the result to Jira, Slack or Teams.

```
PROJECT / SOURCE → BUG REPORT → AI AGENT → INVESTIGATE → RED → REPAIR → GREEN → APPROVAL → REPORT → (Jira · Slack · Teams)
```

## Quick start

```bash
cd bugrep-ai
npm install
cp env.example .env        # add BOBSHELL_API_KEY
npm run web                # → http://localhost:3000
```

## Live demo (deterministic, isolated)

1. Click **Run Live Demo**. Preflight checks run first and use **no Bob calls**:
   fixture, template, bug report, Node ≥ 18, Jest installed, Jest smoke test, run folder writable, demo workspace, Bob available.
2. **Start Live Demo** is enabled only if every check passes. Otherwise the dialog shows **DEMO CANNOT START** and the reason.
3. The demo resets `runs/_demo-workspace` from `demo/template/` plus `demo/cart.fixture.js`. The header is corrected to
   `// src/cart.js // Reset to buggy baseline for this demo run.`, and `cart.fixture.js` itself is never edited.
4. Real pipeline, real IBM Bob, exactly two Bob calls. No pre-recorded or fake results: if Bob or the test environment
   fails, the run shows **DEMO FAILED** / **RUN FAILED** with the reason.
5. **Reset Demo** (`POST /api/demo/reset`) cancels active demo runs and rebuilds only the demo workspace. Your
   projects and past reports are never touched.

CLI: `npm run preflight` · `npm run demo`

## Normal runs

Choose **IDE Workspace** (a local folder), **GitHub** or **Upload ZIP**, describe the bug, pick the agent and click **Analyze & Repair**.
BugRep works on a copy in `runs/<id>/`. Your code only changes if you approve **and** ticked "write back" for a local folder (originals backed up).

```bash
node cli.js run --path <folder> --bug "…" [--write-back] [--yes]
node cli.js run --github https://github.com/owner/repo --bug-file bug.txt
node cli.js run --zip project.zip --bug "…"
node cli.js runs
```
Exit codes: 0 completed · 1 failed · 2 rejected · 3 setup · 4 not reproduced · 5 repair not verified · 6 cancelled · 7 timed out. Ctrl+C = Stop Run.

## Run states (every run ends in one)

| Status | Meaning |
|---|---|
| `completed` | RED → repair → GREEN → approved → final GREEN on the exact candidate → delivered |
| `awaiting-approval` | verified repair waiting for you (pipeline timer paused) |
| `rejected` | you rejected the repair; nothing changed |
| `not-reproduced` | tests **ran** and zero assertions failed |
| `repair-not-verified` | candidate still fails locked tests; nothing applied; **Retry Fix** = one more Repairer call |
| `failed` | with `errorType`: `environment` (tests could not start), `ai-response` (unparseable answer, see `bobDebug`), `ai-unavailable`, `invalid-tests`, `integrity`, `source`, `internal` |
| `timed-out` | a process or the whole run exceeded its limit (`failedStage`, `timedOutAt`) |
| `cancelled` | Stop Run: the child process is killed, later stages never start, evidence kept |
| `interrupted` | found still "running" at server start (restart/crash), so marked interrupted, never retried automatically |

Infrastructure failures are never reported as "bug not reproduced".

## IBM Bob call rule

A normal successful run makes **exactly two** Bob calls: **#1 Investigator** (localize + regression tests) and **#2 Repairer**.
Health polling (`bob --version`, cached 30 s), hashing, Jest, diff, approval, apply, report, Jira/Slack/Teams, run listing,
cancellation and demo reset never call Bob. **Retry Fix** is the only way to make another call, and only when you click it.
The report records `bobCallCount`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | status (Bob cached 30 s), integrations (booleans) |
| GET | `/api/agents` | providers: implemented / configured / operational |
| GET | `/api/integrations/status` | `{jira,slack,teams}.configured` only |
| POST | `/api/uploads` | raw ZIP body → `uploadId` |
| POST | `/api/runs` | start a run `{source, bugReport, rules, options:{agents, mode, autoApprove, includeTests, writeBack}}` |
| GET | `/api/runs` · `/api/runs/:id` | list · state |
| GET | `/api/runs/:id/events` | live Server-Sent Events |
| DELETE | `/api/runs/:id` | delete a finished run |
| POST | `/api/runs/:id/cancel` | Stop Run |
| POST | `/api/runs/:id/decision` · `/approve` · `/reject` | human approval |
| POST | `/api/runs/:id/retry-fix` | explicit extra Repairer call |
| POST | `/api/runs/:id/retry` | new run with the same inputs (explicit) |
| POST | `/api/runs/:id/dismiss` | hide an interrupted run |
| GET | `/api/runs/:id/diff` · `/report` · `/files/:name` | diff (+ truncation metadata) · report · downloads |
| POST | `/api/runs/:id/integrations/jira` · `/slack` · `/teams` | share (explicit) |
| GET | `/api/demo-bug` · `/api/demo/preflight` · POST `/api/demo/reset` | demo |

## Agents

| Agent | Status |
|---|---|
| IBM Bob | **implemented, operational** when `bob` + `BOBSHELL_API_KEY` are available (default) |
| IBM watsonx.ai | implemented, **experimental**, only if `WATSONX_*` set |
| Claude · ChatGPT (OpenAI) · Gemini · Grok | **skeletons**: visible as "Coming soon", never called, no keys needed. Selecting one returns "`<Name>` provider is not configured in this build." |

Interface (`agents/provider.js`): `getStatus()`, `investigate({workspace, bugReport, targetHint, …})`,
`repair({workspace, localizedFile, bugReport, redEvidence, lockedTest, …})`. Multi-Agent Review orchestration exists in the pipeline
(independent investigations, independent candidates, and the **test runner** picks the verified one). It unlocks when two or more agents are operational.

## Integrations (optional)

Jira (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`) creates a Bug with labels `bugrep-ai`, `ai-repair`.
Slack (`SLACK_WEBHOOK_URL`) and Teams (`TEAMS_WEBHOOK_URL`, Adaptive Card) post a run summary. They are triggered only by the Share
buttons. Results (`CREATED BUG-123`, `SENT`, `FAILED: HTTP 403`) are stored under `integrations` and in the report. **They never change the repair status.**
No URL, token or key is ever returned to the browser.

## Project tree

```
bugrep-ai/
├── cli.js                      terminal entry (run / preflight / runs)
├── web/server.js               API + SSE + startup stale-run recovery
├── web/public/                 UI: Projects · Runs · Agents · Integrations · Reports
├── agents/                     index.js · provider.js · parse.js · bob.js · watsonx.js · claude.js · openai.js · gemini.js · grok.js
├── integrations/               index.js · jira.js · slack.js · teams.js · summary.js · http.js
├── workflow/
│   ├── pipeline.js             9 stages, states, cancel, timeouts, retry-fix, recovery
│   ├── proc.js                 the only process runner (timeout + cancel + tree kill)
│   ├── testrunner.js           Jest / pytest, honest classification, hard timeout
│   ├── demo.js                 preflight, reset, controlled workspace
│   ├── sources.js · workspace.js · prompts.js · report.js · errors.js · redact.js · paths.js
├── demo/                       template/ · cart.fixture.js · bug_report.txt
├── scripts/fake-bob.js         TEST DOUBLE for automated tests only
├── test/                       acceptance (A–J) + unit tests, `npm test`
└── runs/                       per-run folders (git-ignored)
```

## Deploy to Vercel

1. Import the repo in Vercel and set **Root Directory** to `bugrep-ai`. `vercel.json` handles the rest: the UI is
   served from `web/public` and every `/api/*` route goes to one Express function (`api/index.js`, 300 s max).
2. Add your environment variables (see `env.example`) in the project settings. Set `PUBLIC_BASE_URL` to the deployment URL.
3. Deploy (`vercel --prod`, or push to the connected branch).

Limits on the hosted version:
- **IDE Workspace is disabled.** Use GitHub or Upload ZIP (Vercel caps request bodies at 4.5 MB).
- **The Bob Shell CLI is not on Vercel's runtime.** Use watsonx, or point `BOB_CLI_PATH` at a binary you bundle.
  pytest is not available either, so only Jest (JavaScript) projects can be tested.
- **Runs live in `/tmp` and in memory on one function instance.** A run must finish within 300 s, including the time it
  waits for approval. Later requests (approve, SSE, downloads) can land on another instance that has never seen the run.
  For reliable runs, host it as a long-running Node server instead (`npm start` with `HOST=0.0.0.0`).
- The deployment is public by default. Turn on Vercel Deployment Protection so nobody else spends your AI credits.

## Known limitations

- IBM Bob behaviour (speed, answer quality, exact CLI flags) depends on your Bob Shell install. BugRep's automated tests use
  `scripts/fake-bob.js`, **not** real Bob.
- JavaScript (Jest) and Python (pytest) projects only.
- Up to 5 relevant files are sent to the agent, so bugs spanning many files may be missed.
- Multi-agent mode and the Claude/OpenAI/Gemini/Grok providers are architecture only.
- A run waiting for approval is not timed out. If the server restarts meanwhile it becomes `interrupted`.
- Jira uses REST v2 with a text description. Teams expects a Workflows/webhook URL that accepts Adaptive Cards.
