/**
 * `check decision-coverage-verify` — advisory verify-phase decision-coverage gate, as a gate
 * module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns a `GateResult`; the command
 * router formats it. Always `blocking:false` — a soft warning, never a verification failure.
 * Imports no io module and performs no direct console/stdout/stderr write (ESLint-enforced).
 *
 * Argv after the verb: `<phase-dir> <context-path>` (positional; no `--context` flag here).
 */

import fs from 'node:fs';
import { gateVerdict, isGateUsageFailure } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { isDecisionCoverageGateEnabled } from './gate-config.cjs';
import {
  decisionMentioned,
  loadPlanContents,
  phaseDirProblem,
  loadSummaryContents,
  loadDecisionExtraction,
  readModifiedFilesContent,
  phaseCommitMessages,
  buildVerifyMessage,
} from './decision-coverage-support.cjs';
import type { UncoveredItem } from './decision-coverage-support.cjs';

export function evaluateDecisionCoverageVerify(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir, args } = input;
  let phaseDir = '';
  if (args[0]) {
    const resolved = resolveContainedPath(args[0], projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    phaseDir = resolved;
  }
  let contextPath = '';
  if (args[1]) {
    const resolved = resolveContainedPath(args[1], projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    contextPath = resolved;
  }

  if (!isDecisionCoverageGateEnabled(projectDir)) {
    return gateVerdict('skip', false, { skipped: true, blocking: false, reason: 'workflow.context_coverage_gate is false', total: 0, honored: 0, not_honored: [], message: 'Decision coverage gate disabled by config.' });
  }
  if (!contextPath || !fs.existsSync(contextPath)) {
    return gateVerdict('skip', false, { skipped: true, blocking: false, reason: 'CONTEXT.md missing', total: 0, honored: 0, not_honored: [], message: 'No CONTEXT.md - nothing to check.' });
  }

  const { trackable: decisions, outcome: decisionOutcome } = loadDecisionExtraction(contextPath);

  // Mirror could-not-parse surface for verify (non-blocking advisory WARN).
  // Fire independent of decisions.length — a parse-miss on any bullet must surface,
  // even when some decisions were partially extracted (#1365 fix-parity with plan gate).
  // Nothing was checked, so total/honored are null, as in the plan gate (#4794).
  if (decisionOutcome === 'could-not-parse') {
    const partialParse = decisions.length > 0;
    return gateVerdict('advisory', false, {
      skipped: false,
      blocking: false,
      reason: 'could-not-parse',
      total: null,
      honored: null,
      not_honored: [],
      message: partialParse
        ? 'Decision coverage verify (warning): decisions could not be fully parsed — one or more ' +
          '`- **D-NN ...**` bullets appear malformed (missing `:` or ` — ` separator, or a phase ' +
          'prefix that is not a digit run). Fix the bullet format in the CONTEXT.md decisions block.'
        : 'Decision coverage verify (warning): could not parse decisions — possible format mismatch. ' +
          'Check the formatting of the CONTEXT.md decisions block (accepted forms: `- **D-NN:** text`, ' +
          '`- **D4-NN:** text` (phase-prefixed), `- **D-NN — title** body`).',
    });
  }

  if (decisions.length === 0) {
    return gateVerdict('skip', false, { skipped: true, blocking: false, reason: 'no trackable decisions', total: 0, honored: 0, not_honored: [], message: 'No trackable decisions in CONTEXT.md.' });
  }

  // #4939: mirror the plan gate. A phase-dir argument that names no directory
  // means no plan or summary was scanned, so no decision can be reported
  // not-honored. Warn (verify stays non-blocking) rather than list every decision.
  const phaseDirIssue = phaseDir ? phaseDirProblem(phaseDir) : null;
  if (phaseDirIssue) {
    return gateVerdict('advisory', false, { skipped: false, blocking: false, reason: phaseDirIssue.reason, total: null, honored: null, not_honored: [], message: `Decision coverage verify (warning): the phase directory "${args[0]}" ${phaseDirIssue.what}, so no plans or summaries were scanned. ${phaseDirIssue.hint}` });
  }

  const planContents = loadPlanContents(phaseDir);
  const summaryParts = loadSummaryContents(phaseDir);
  const haystack = [
    planContents.join('\n\n'),
    summaryParts.join('\n\n'),
    readModifiedFilesContent(projectDir, summaryParts),
    phaseCommitMessages(projectDir, phaseDir),
  ].join('\n\n');

  const notHonored: UncoveredItem[] = [];
  let honored = 0;
  for (const decision of decisions) {
    if (decisionMentioned(haystack, decision)) honored++;
    else notHonored.push({ id: decision.id, text: decision.text, category: decision.category });
  }

  return gateVerdict(notHonored.length === 0 ? 'pass' : 'advisory', false, {
    skipped: false,
    blocking: false,
    total: decisions.length,
    honored,
    not_honored: notHonored,
    message: buildVerifyMessage(notHonored),
  });
}
