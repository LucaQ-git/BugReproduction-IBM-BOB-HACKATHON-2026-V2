# Upgrading to BugRep-AI v4

1. Unzip this archive over your repository root (it contains only new/changed files).
2. Delete these files/folders, which v4 no longer uses:
   - bugrep-ai/workflow/engines.js      (replaced by agents/)
   - bugrep-ai/demo/replay.json         (demo no longer uses pre-recorded answers)
   - bugrep-ai/demo/shop-cart/          (replaced by demo/template/ + demo/cart.fixture.js)
3. cd bugrep-ai && npm install && npm test && npm run web
4. Keep your existing .env; see env.example for the new optional settings (timeouts, Jira, Slack, Teams).
