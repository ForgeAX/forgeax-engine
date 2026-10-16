// post-merge-monitor-helpers.mjs (bug-20260511 fixture anchor)
//
// SSOT helper logic mirrored byte-for-byte by the inline JS bodies of the
// post-merge-monitor.yml `actions/github-script@v7` steps:
//   - List existing open post-merge issues for this head_sha
//   - Open or comment tracking issue on failure
//   - Auto-close tracked issues on success
//
// yaml anchor: .github/workflows/post-merge-monitor.yml (D-P5 fixture
// anchor, R-P1 mitigation). The yaml inline JS keeps the same:
//   - sentinel literal:        `**merge sha**: \`<sha>\``
//   - labels triple:           ['post-merge', 'ci-failure', 'sla-24h']
//   - close scenarios:         'sha-rerun-green' | 'sha-progressed'
//   - comment body shapes:     see buildEvidenceComment / buildDedupComment
//
// Consumer:
//   - scripts/__tests__/post-merge-monitor-auto-close.test.mjs (unit test
//     consumes the helpers + drives them against a mocked octokit so the
//     behavioural contract (issues.update + issues.createComment + scenario
//     literal + run url + ISO timestamp) is verified at unit level)
//
// Refs:
//   - bug-20260511-post-merge-monitor-auto-close plan-strategy.md §3 D-P5
//   - requirements.md §AC-02 / AC-03 / AC-04 / AC-06 / AC-07

export const POST_MERGE_LABELS = ['post-merge', 'ci-failure', 'sla-24h'];

/**
 * Scan a list of open `post-merge` tracking issues and return those whose
 * body carries the `**merge sha**: \`<sha>\`` literal sentinel matching the
 * given workflow_run head_sha. Single list call covers both the dedup (red)
 * and auto-close (green) paths (D-P3).
 *
 * @param {string} headSha
 * @param {{ number: number, body: string }[]} openIssues
 */
export function findMatchingOpenIssues(headSha, openIssues) {
  const sentinel = `**merge sha**: \`${headSha}\``;
  return openIssues.filter(
    (issue) => typeof issue.body === 'string' && issue.body.includes(sentinel),
  );
}

/**
 * Extract the merge sha sentinel from an existing issue body. Returns
 * `null` if not found (i.e. external human-opened issue with the same
 * triple label — keep conservative, do not close).
 *
 * @param {string} body
 */
export function extractIssueMergeSha(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/\*\*merge sha\*\*: `([^`]+)`/);
  return m ? m[1] : null;
}

/**
 * Build the evidence comment body for an auto-close action. Three fields
 * are grep-able literal anchors per AC-03 (charter proposition 3):
 *   1. **ci run url**: <workflow_run.html_url>
 *   2. **timestamp**:  <ISO 8601 UTC, new Date().toISOString()>
 *   3. **scenario**:   'sha-rerun-green' | 'sha-progressed'
 *
 * `sha-rerun-green` — same head_sha rerun turned green (possibly transient
 *                     flake, not a real fix; charter proposition 4 do not
 *                     mask).
 * `sha-progressed`  — newer push sha overtook the previous red sha.
 *
 * @param {{ html_url: string, head_sha: string }} workflowRun
 * @param {string} issueMergeSha
 * @param {string} isoTimestamp
 */
export function buildEvidenceComment(workflowRun, issueMergeSha, isoTimestamp) {
  const scenario = issueMergeSha === workflowRun.head_sha ? 'sha-rerun-green' : 'sha-progressed';
  const body = [
    'Auto-closed by post-merge-monitor: main ci.yml run turned green.',
    '',
    `**ci run url**: ${workflowRun.html_url}`,
    `**timestamp**: ${isoTimestamp}`,
    `**scenario**: ${scenario}`,
    '',
    scenario === 'sha-rerun-green'
      ? '(same head_sha rerun turned green — could be transient flake; review before treating as fixed.)'
      : '(newer push sha overtook the previous red sha — root cause may have been addressed.)',
  ].join('\n');
  return { scenario, body };
}

/**
 * Build the dedup comment body for a red path collision (same head_sha,
 * already-open tracking issue). AC-04: do not call `issues.create`; call
 * `issues.createComment` on the existing issue and reference the current
 * run url.
 *
 * @param {{ html_url: string, head_sha: string }} workflowRun
 */
export function buildDedupComment(workflowRun) {
  return [
    `duplicate red detected on same head_sha \`${workflowRun.head_sha}\``,
    '',
    `**ci run url**: ${workflowRun.html_url}`,
  ].join('\n');
}
