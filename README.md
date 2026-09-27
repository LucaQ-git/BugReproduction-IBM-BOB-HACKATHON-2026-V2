# BugRep-AI — From Bug Report to Verified Repair

> **IBM Bob Hackathon 2026 · Team Submission**

BugRep-AI turns a plain-English bug report and a codebase into a verified, human-approved code repair — powered by IBM Bob agents, proven by real tests, and shareable to Jira, Slack, or Teams.

```
SOURCE CODE + BUG REPORT
        │
        ▼
  [IBM Bob — Investigator]   ← Bob call #1: localize the bug, generate regression tests
        │
        ▼
   RED  (Jest / pytest)      ← tests fail, bug confirmed
        │
        ▼
  [IBM Bob — Repairer]       ← Bob call #2: write the fix
        │
        ▼
   GREEN (same locked tests) ← fix proven against the same SHA-256-locked test suite
        │
        ▼
  HUMAN APPROVAL             ← nothing touches your source before you say yes
        │
        ▼
  FINAL GREEN + DELIVER      ← fix applied, report generated
        │
        ▼
  Jira · Slack · Teams       ← optional one-click sharing
```

---

## 📝 Problem & Solution Statement

### The Problem

Bugs are expensive — not because they are hard to fix, but because the path from *"something is broken"* to *"here is a proven repair"* is slow, error-prone, and largely manual. A developer receives a bug report, reads it, tries to reproduce it, digs through the codebase to find the affected code, writes a fix, writes (or updates) a test to confirm the fix, runs the full suite, and only then raises a PR. On a busy team that cycle can take hours or days, and at every step there is room for guesswork.

AI code assistants have started to shorten this loop, but they typically stop at the *suggestion* stage. They propose a change, but they do not reproduce the bug first, they do not lock regression tests before the fix is written, and they do not prevent the fix from being applied to your source unless the evidence is solid. The result is AI-generated patches that *look* plausible but have never been proven correct by a real test runner.

### The Solution

**BugRep-AI** is a full-pipeline automated repair agent built on top of **IBM Bob**. Its target users are software developers and engineering teams who want to go from a bug report to a verified, human-approved code patch with minimal manual effort.

A developer pastes (or uploads) a bug description and points BugRep-AI at a codebase — a local IDE workspace folder, a GitHub repository URL, or a ZIP file. BugRep-AI then runs a strict, two-stage AI pipeline:

1. **Investigate** — IBM Bob reads the bug report and the relevant source files, localizes the defect to a specific function, and writes regression tests that will fail *right now* (the RED phase). BugRep-AI actually runs those tests with Jest or pytest to confirm the bug is reproduced before proceeding.
2. **Repair** — IBM Bob receives the confirmed failure evidence, the localized file, and the locked test suite, then proposes a corrected version of the file. BugRep-AI runs the *same locked tests* against the candidate fix. Only if they all go GREEN does the run proceed to human approval.

The human sees the diff, the test output, and a full run report. If they approve, BugRep-AI applies the fix (optionally writing it back to the original folder). They can then share the report to Jira, Slack, or Teams with a single click.

What makes the approach novel and trustworthy is the combination of four constraints that are non-negotiable in the architecture:

- **Evidence before action.** The bug must be reproduced by a real test runner before any fix is attempted. An infrastructure failure is never reported as "bug not reproduced."
- **Locked tests.** The SHA-256 hash of the test file is recorded the moment it is written by the Investigator. The same hash is verified before and after the Repairer runs. Tests cannot be silently changed to make the fix look green.
- **Exactly two Bob calls per run.** No hidden retries, no speculative calls. A user-initiated "Retry Fix" is the only permitted third call, and it is counted in the report.
- **Approval gate.** Your source code is never modified without your explicit confirmation. Every approved fix is applied from the exact hashed candidate that passed the GREEN check.

The result is a repair workflow that gives developers high-confidence, test-proven patches in minutes rather than hours, with a complete audit trail and no risk of AI-generated changes sneaking into production unreviewed.

---

## 🤖 IBM Bob Usage Statement

IBM Bob is the AI engine at the heart of BugRep-AI. It is used at two precisely defined points in the pipeline — and nowhere else.

### Call #1 — The Investigator

Bob receives a structured prompt (built in [`workflow/prompts.js`](bugrep-ai/workflow/prompts.js)) that includes the bug report text, the most relevant source files from the workspace (up to five, ranked by name-matching heuristics), and a strict JSON response schema. Bob is asked to:

- Identify the specific file and function most likely responsible for the bug.
- Write a regression test (Jest for JavaScript, pytest for Python) that will fail against the current code.
- Provide a plain-English analysis explaining its reasoning.

Bob's JSON response is parsed and validated by [`agents/parse.js`](bugrep-ai/agents/parse.js). BugRep-AI then runs the generated tests with the real test runner ([`workflow/testrunner.js`](bugrep-ai/workflow/testrunner.js)) and aborts the run if zero assertions fail — because that would mean the bug was not actually reproduced.

### Call #2 — The Repairer

Only after the RED evidence is confirmed does Bob receive a second prompt containing: the original file content, the locked test file, the failing test output, and Bob's own earlier analysis. Bob is asked to return the complete corrected file — nothing else. The response is written to the run's working directory and the locked tests are run again to produce GREEN evidence.

### IBM Bob as a Development Partner

Beyond the two runtime calls, IBM Bob was used throughout the development of BugRep-AI itself:

- **Architecture and pipeline design** — Bob helped reason through the state machine in [`workflow/pipeline.js`](bugrep-ai/workflow/pipeline.js), including the nine run stages, cancellation logic, and the "interrupted" recovery path for server restarts.
- **Prompt engineering** — the two agent prompts (Investigator and Repairer) were iteratively refined with Bob's assistance to produce consistently structured JSON responses that parse reliably.
- **Test suite** — the acceptance test suite ([`test/`](bugrep-ai/test/)) and the `scripts/fake-bob.js` test double were written and debugged with Bob's help, ensuring the pipeline is testable without consuming real Bob calls.
- **API and UI** — Bob assisted with the Express server ([`web/server.js`](bugrep-ai/web/server.js)), the Server-Sent Events live-update stream, and the web UI that renders run state, diffs, and reports.
- **Security and redaction** — Bob reviewed the `workflow/redact.js` module and the `.bobignore` / `.gitignore` configuration to ensure no API keys or webhook URLs leak through logs or the browser.

### IBM watsonx.ai

The [`agents/watsonx.js`](bugrep-ai/agents/watsonx.js) provider implements the same `investigate` / `repair` interface against IBM watsonx.ai using the `@ibm-cloud/watsonx-ai` SDK. It is available as an experimental alternative when `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, and `WATSONX_URL` are set. It is not the default because the Bob Shell provides tighter local integration and a faster round-trip for the two-call pipeline pattern, but the architecture is explicitly designed to support watsonx.ai as a first-class agent in future production deployments.

---

## 🚀 Quick Start

```bash
cd bugrep-ai
npm install
cp env.example .env        # add BOBSHELL_API_KEY (required)
npm run web                # → http://localhost:3000
```

**Requirements:** Node.js ≥ 18, IBM Bob Shell installed and on `PATH`, Jest (bundled as a dependency).

### Try the live demo

1. Open `http://localhost:3000` and click **Run Live Demo**.
2. Preflight checks run first — no Bob calls are made here.
3. If every check passes, click **Start Live Demo**. The pipeline runs against a real buggy shopping-cart fixture using real Bob and real Jest.
4. If Bob or the test environment is unavailable the demo shows **DEMO FAILED** with the reason — results are never faked.

### CLI

```bash
node cli.js run --path <folder> --bug "…"             # local workspace
node cli.js run --github https://github.com/owner/repo --bug-file bug.txt
node cli.js run --zip project.zip --bug "…"
node cli.js runs                                       # list all runs
```

Exit codes: `0` completed · `1` failed · `2` rejected · `3` setup error · `4` not reproduced · `5` repair not verified · `6` cancelled · `7` timed out.

---

## 🔒 Security

- **`.gitignore` / `.bobignore`** — API keys, tokens, and webhook URLs are never committed or logged.
- **`workflow/redact.js`** — all text stored in run folders is scrubbed of secrets before write.
- **No secrets in browser responses** — the `/api/integrations/status` endpoint returns only boolean `configured` flags.
- **Before every commit:** review `git diff`, confirm `.env` is not staged, check for hardcoded credentials.

See [SECURITY.md](SECURITY.MD) for full guidelines.

---

## 📁 Project Structure

```
bugrep-ai/
├── cli.js                      CLI entry point
├── web/server.js               Express API + SSE + startup recovery
├── web/public/                 Browser UI (Projects · Runs · Agents · Integrations · Reports)
├── agents/                     index.js · provider.js · parse.js · bob.js · watsonx.js · (stubs)
├── integrations/               jira.js · slack.js · teams.js · summary.js
├── workflow/
│   ├── pipeline.js             9-stage state machine, cancel, timeouts, retry-fix
│   ├── proc.js                 sole process runner (hard timeout + tree-kill)
│   ├── testrunner.js           Jest / pytest, honest classification
│   ├── prompts.js              Investigator + Repairer prompt builders
│   ├── redact.js               secret scrubbing
│   └── …                       sources · workspace · report · errors · paths · demo
├── demo/                       template/ · cart.fixture.js · bug_report.txt
├── scripts/fake-bob.js         Test double (automated tests only — never in production)
└── test/                       Acceptance tests A–J + unit tests
```

---

## 🆘 Need Help?

- Read [SECURITY.md](SECURITY.MD) for security guidelines.
- Contact hackathon support through the mentor channel.
- Ask in the hackathon Slack workspace.

---

*BugRep-AI — IBM Bob Hackathon 2026. Security is everyone's responsibility. When in doubt, ask for help.*
