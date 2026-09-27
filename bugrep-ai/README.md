# BugRep AI

> **Bug report in. Verified fix out.** A team of AI agents, powered by **IBM Bob**, that finds a bug from a
> plain-English report, proves it with failing tests, writes the fix, verifies it, and hands you the fixed code and a report.

![flow](https://img.shields.io/badge/flow-report%20→%20RED%20→%20fix%20→%20GREEN-7c6cff)

---

## Quick start

```bash
cd bugrep-ai
npm install
npm start            # → http://localhost:3000
```

Click **Run live demo**. It works with no API keys, so it's a safe way to present.

To fix your own code, add an AI engine to `bugrep-ai/.env` (see [Configuration](#configuration)), then choose one of:

| Source | What to enter |
|---|---|
| **Local / IDE** | The folder open in your IDE (prefilled with this repo). Tick *Write the approved fix back* to update your files in place. |
| **GitHub** | `https://github.com/owner/repo` (or `…/tree/branch/sub/folder`). Add `GITHUB_TOKEN` for private repos. |
| **Upload ZIP** | Drag a `.zip` of your project onto the drop zone. |

---

## What happens in a run

| # | Stage | Who | What |
|---|---|---|---|
| 1 | Fetch code | BugRep | Copies the code into `runs/<id>/workspace`. **Your original is never touched.** |
| 2 | Map codebase | BugRep | Detects JavaScript/Python, ranks the files most relevant to the bug report, and reads README/rules docs. |
| 3 | **Test Agent** | AI | Locates the faulty file and function, then writes strict regression tests (`__bugrep__/…`). |
| 4 | Reproduce | Jest / pytest | Runs the tests on the **original** code. They must fail, which proves the bug is real. The suite is then locked (SHA-256). |
| 5 | **Fix Agent** | AI | Returns full new source files. It may not touch tests, `__bugrep__/`, `node_modules/`, or paths outside the project. |
| 6 | Verify | Jest / pytest | Runs the **same locked tests** on the fixed copy. Everything must pass. |
| 7 | Your approval | You | Review the diff and approve or reject (or turn on *Auto-approve*). |
| 8 | Deliver | BugRep | Produces `fixed-code.zip`, `fix.patch`, the test file, and (optionally) writes the fix back to your folder, with backups. |
| 9 | Report | BugRep | `report.md` + `report.json` built only from recorded facts. |

The agents retry automatically once each: when their tests can't run, and when their first fix doesn't pass.

---

## Command line (inside IBM Bob IDE's terminal)

```bash
node cli.js run --demo                                   # the bundled demo
node cli.js run --path .. --bug "Totals go negative with 200% coupons"
node cli.js run --github https://github.com/owner/repo --bug-file bug.txt
node cli.js run --zip project.zip --bug "…" --yes        # --yes = auto-approve
node cli.js runs                                         # recent runs
```

Other flags: `--rules "<expected behaviour>"`, `--rules-file f`, `--engine auto|bob|watsonx|replay`,
`--write-back` (local only), `--no-tests`.
Exit codes: `0` fixed · `1` failed · `2` rejected · `3` setup problem · `4` bug not reproduced.

---

## Configuration

Copy `env.example` to `.env` in `bugrep-ai/` and fill in **one** engine:

```ini
# IBM Bob Shell (preferred)
BOBSHELL_API_KEY=...
# BOB_CLI_PATH=C:\Users\you\AppData\Roaming\npm\bob.cmd   # only if `bob` isn't on PATH
# BOB_EXTRA_ARGS=--accept-license                        # only after you've read and accepted Bob's license

# or IBM watsonx.ai
WATSONX_API_KEY=...
WATSONX_PROJECT_ID=...
# WATSONX_MODEL_ID=ibm/granite-3-8b-instruct
```

**How Bob Shell is called.** For each agent, BugRep makes a scratch copy of the project, writes the task to
`__bugrep__/TASK.md`, and runs `bob run --format json --workspace <scratch> --mode agent --trust "<short prompt>"`.
Bob writes its answer to `__bugrep__/answer.json`. Anything else Bob edits in the scratch copy is thrown away.
The raw Bob output for every run is saved in `runs/<id>/bob-*.log`.

---

## Demo mode, honestly

The demo runs a real pipeline on `demo/shop-cart`. If Bob or watsonx is configured and you pick it in
*AI engine*, the demo uses live AI. Otherwise it uses **Demo replay**: pre-recorded agent answers from
`demo/replay.json`. Replay is labelled in the UI and the report. The tests, the RED → GREEN verification, the diff
and the delivery still all run live.

---

## Project layout

```
bugrep-ai/
├── cli.js                 ← terminal entry point
├── web/
│   ├── server.js          ← Express API + live progress (Server-Sent Events)
│   └── public/            ← UI (index.html, styles.css, app.js)
├── workflow/
│   ├── pipeline.js        ← the 9-stage pipeline
│   ├── engines.js         ← Bob Shell / watsonx / replay + JSON extraction
│   ├── prompts.js         ← Test Agent & Fix Agent prompts
│   ├── sources.js         ← local folder, GitHub, ZIP, demo
│   ├── workspace.js       ← copying, file ranking, zip in/out, path safety
│   ├── testrunner.js      ← Jest & pytest runners with honest result classification
│   └── report.js          ← Markdown + JSON report
├── demo/                  ← demo project, bug report, replay answers
├── scripts/fake-bob.js    ← stand-in for Bob Shell, to test without using Bobcoins
├── test/                  ← unit tests for BugRep itself (npm test)
└── runs/                  ← one folder per run (git-ignored)
```

## Supported projects

- **JavaScript** (CommonJS or ES modules). BugRep's own Jest runs the generated tests, so no Jest config is needed in your project.
  Dependencies are installed with `npm install --ignore-scripts` if `node_modules` is missing.
- **Python**. Needs `pytest` (`pip install pytest`).
- TypeScript, Java and other languages are detected, but not yet runnable.

## Safety

- The server listens on `127.0.0.1` only. The local source can read folders on your machine, so don't expose it.
- ZIP extraction blocks path traversal and oversized archives. `.env`, `node_modules` and `.git` are never copied or sent to the AI.
- Bug report text is fenced as untrusted data in every prompt.
- Nothing is written to your folder without approval. Originals are backed up in `runs/<id>/backup`.
