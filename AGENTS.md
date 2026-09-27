# BugRep-AI: Project Context for IBM Bob

BugRep-AI turns a plain-English bug report plus code (IDE workspace folder, GitHub repo, or ZIP) into a verified repair:

INVESTIGATE (Bob call #1) → RED (Jest/pytest) → REPAIR (Bob call #2) → GREEN (same locked tests) → human APPROVAL →
final GREEN on the exact candidate → REPORT → optional Jira / Slack / Teams.

## Run it
```bash
cd bugrep-ai && npm install
npm run web          # UI at http://localhost:3000
npm run preflight    # demo checks (no Bob calls)
npm test             # acceptance + unit tests (uses scripts/fake-bob.js, never real Bob)
```

## Non-negotiable rules
- A normal run makes exactly TWO Bob calls (Investigator, Repairer). No hidden or automatic retries. Only the user's
  "Retry Fix" makes another Repairer call.
- Every external process goes through `workflow/proc.js` with a hard timeout and cancellation. No run may stay running forever.
- Every run ends in an explicit status (completed, awaiting-approval, rejected, failed, timed-out, cancelled, interrupted,
  not-reproduced, repair-not-verified). Infrastructure failures are never "not reproduced".
- Test results come only from Jest/pytest. Tests are locked by SHA-256; the verified candidate is hashed and exactly that is applied.
- Never fake AI output or RED/GREEN evidence. The demo uses real Bob and fails visibly if Bob or tests are unavailable.
- Never modify user source before approval. The demo only resets `runs/_demo-workspace`.
- Never expose or store secrets (API keys, tokens, webhook URLs). All stored text passes through `workflow/redact.js`.
- Integration (Jira/Slack/Teams) failures never change a repair's status.
- Legacy manual-workflow files (`orchestrator.js`, `workflow/runner.js`, `workflow/state.js`, `workflow/inputs.js`,
  `workflow/jira.js`, `agents/*.md`, `src/cart*`) are kept for reference and are not used by the pipeline.
