// agents/provider.js — the common interface every AI agent provider implements.
//
//   getStatus()  → { id, name, implemented, configured, operational, experimental, detail, version }
//   investigate({ workspace, bugReport, targetHint, rules, context, project, testPath, signal, log, runDir })
//        → { payload: { localizedFile, localizedFunction, analysis, testFile, testCode, tests?, confidence? }, ms }
//   repair({ workspace, localizedFile, bugReport, redEvidence, lockedTest, rules, context, project,
//            localization, signal, log, runDir })
//        → { payload: { rootCause, fixSummary, fixedCode?, files? }, ms }
//
// Providers only return text. They never write to the user's code: BugRep stages,
// tests and applies candidates itself.

'use strict';

const { RunError } = require('../workflow/errors');

class AgentProvider {
  constructor({ id, name, vendor }) {
    this.id = id;
    this.name = name;
    this.vendor = vendor || name;
  }

  async getStatus() {
    return { id: this.id, name: this.name, implemented: false, configured: false, operational: false,
      experimental: false, detail: 'Coming soon' };
  }

  async investigate() {
    throw new RunError('ai-unavailable', `${this.name} provider is not configured in this build.`);
  }

  async repair() {
    throw new RunError('ai-unavailable', `${this.name} provider is not configured in this build.`);
  }
}

/** A provider that is visible in the UI but not implemented yet. Never calls a network. */
class SkeletonProvider extends AgentProvider {
  async getStatus() {
    return { id: this.id, name: this.name, implemented: false, configured: false, operational: false,
      experimental: false, detail: 'Coming soon — not configured in this build' };
  }
}

module.exports = { AgentProvider, SkeletonProvider };
