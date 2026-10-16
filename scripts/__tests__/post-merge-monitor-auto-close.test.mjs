// post-merge-monitor-auto-close.test.mjs (bug-20260511 w1 + w2)
//
// vitest unit test driving the post-merge-monitor auto-close + dedup
// implementation (TDD red-green per plan-strategy D-P5).
//
// Helpers (`findMatchingOpenIssues` / `extractIssueMergeSha` /
// `buildEvidenceComment` / `buildDedupComment`) live in
// scripts/__tests__/fixtures/post-merge-monitor-helpers.mjs and are
// mirrored byte-for-byte by the `actions/github-script@v7` step bodies in
// .github/workflows/post-merge-monitor.yml (D-P5 fixture anchor / R-P1
// mitigation). Literal anchors shared between yaml and these tests:
//   - issue body sha sentinel: `**merge sha**: \`<sha>\``  (yaml line ~144)
//   - labels triple:           ['post-merge', 'ci-failure', 'sla-24h']
//   - close scenarios:         'sha-rerun-green' | 'sha-progressed'
//
// 3-scenario coverage (plan-strategy §5.1):
//   (a) auto-close green path   — w1, AC-02 / AC-03 / AC-06
//   (b) dedup red path          — w2, AC-04 / AC-07
//   (c) new-red existing path   — w2 defensive, AC-01
//
// Refs:
//   - requirements §AC-01 / AC-02 / AC-03 / AC-04 / AC-06 / AC-07
//   - plan-strategy §3 D-P1 / D-P2 / D-P3 / D-P5
//   - research §3 Findings F-R1 / F-R4 / F-R6

import { describe, expect, it, vi } from 'vitest';

import {
  buildDedupComment,
  buildEvidenceComment,
  extractIssueMergeSha,
  findMatchingOpenIssues,
  POST_MERGE_LABELS,
} from './fixtures/post-merge-monitor-helpers.mjs';

// ---------------------------------------------------------------------------
// Mock octokit driver: replicates the yaml's inline JS sequence so the
// test asserts the behavioural contract (which APIs called, in what order,
// with what body literal). Mirrors w3 / w4 yaml steps.
// ---------------------------------------------------------------------------

async function drivePostMergeMonitor({
  workflowRun,
  openIssues,
  superseded = false,
  isoTimestamp = '2026-05-11T12:34:56.789Z',
}) {
  const calls = {
    listForRepo: [],
    create: [],
    update: [],
    createComment: [],
  };

  const octokit = {
    rest: {
      issues: {
        listForRepo: vi.fn(async (params) => {
          calls.listForRepo.push(params);
          return { data: openIssues };
        }),
        create: vi.fn(async (params) => {
          calls.create.push(params);
          return { data: { number: 999, ...params } };
        }),
        update: vi.fn(async (params) => {
          calls.update.push(params);
          return { data: { number: params.issue_number, state: params.state } };
        }),
        createComment: vi.fn(async (params) => {
          calls.createComment.push(params);
          return { data: { id: 1, body: params.body } };
        }),
      },
    },
  };

  // Step 1 — list open candidates (shared across red + green per D-P3).
  const listResp = await octokit.rest.issues.listForRepo({
    owner: 'org',
    repo: 'repo',
    labels: POST_MERGE_LABELS.join(','),
    state: 'open',
  });
  const matched = findMatchingOpenIssues(workflowRun.head_sha, listResp.data);

  // Step 2 — dispatch based on conclusion + superseded filter.
  if (workflowRun.conclusion !== 'success' && !superseded) {
    if (matched.length > 0) {
      // Dedup branch (AC-04 + AC-07): comment on each, do NOT create.
      for (const issue of matched) {
        await octokit.rest.issues.createComment({
          owner: 'org',
          repo: 'repo',
          issue_number: issue.number,
          body: buildDedupComment(workflowRun),
        });
      }
    } else {
      // New-red branch (AC-01 defensive): preserve existing K-11 behaviour.
      await octokit.rest.issues.create({
        owner: 'org',
        repo: 'repo',
        title: `[post-merge] main ci.yml conclusion=${workflowRun.conclusion}`,
        body: `red body with **merge sha**: \`${workflowRun.head_sha}\``,
        labels: POST_MERGE_LABELS,
      });
    }
  } else if (workflowRun.conclusion === 'success') {
    for (const issue of matched) {
      const issueSha = extractIssueMergeSha(issue.body) || '';
      const { body } = buildEvidenceComment(workflowRun, issueSha, isoTimestamp);
      await octokit.rest.issues.update({
        owner: 'org',
        repo: 'repo',
        issue_number: issue.number,
        state: 'closed',
      });
      await octokit.rest.issues.createComment({
        owner: 'org',
        repo: 'repo',
        issue_number: issue.number,
        body,
      });
    }
  }

  return { octokit, calls, matched };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('post-merge-monitor auto-close (w1, AC-02 / AC-03 / AC-06)', () => {
  it('green + 1 open issue with matching sha -> update({state:closed}) + createComment with three fields, no create', async () => {
    const workflowRun = {
      conclusion: 'success',
      head_sha: 'X',
      html_url: 'https://github.com/org/repo/actions/runs/123',
    };
    const openIssues = [
      {
        number: 100,
        body: '...\n**merge sha**: `X`\n...',
      },
    ];
    const { calls } = await drivePostMergeMonitor({
      workflowRun,
      openIssues,
      isoTimestamp: '2026-05-11T12:34:56.789Z',
    });

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].issue_number).toBe(100);
    expect(calls.update[0].state).toBe('closed');

    expect(calls.createComment).toHaveLength(1);
    const body = calls.createComment[0].body;
    expect(body).toContain('https://github.com/org/repo/actions/runs/123');
    expect(body).toContain('2026-05-11T12:34:56.789Z');
    expect(body).toContain('sha-rerun-green');

    expect(calls.create).toHaveLength(0);
  });

  it('green + multiple open issues, one matches current head_sha -> close only the matching one with sha-rerun-green', async () => {
    const workflowRun = {
      conclusion: 'success',
      head_sha: 'CURRENT',
      html_url: 'https://github.com/org/repo/actions/runs/789',
    };
    const openIssues = [
      { number: 200, body: '**merge sha**: `CURRENT`' },
      { number: 201, body: '**merge sha**: `OTHER`' },
    ];
    const { calls } = await drivePostMergeMonitor({
      workflowRun,
      openIssues,
      isoTimestamp: '2026-05-11T13:00:00.000Z',
    });

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].issue_number).toBe(200);
    expect(calls.update[0].state).toBe('closed');
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0].body).toContain('sha-rerun-green');
    expect(calls.createComment[0].body).toContain('https://github.com/org/repo/actions/runs/789');
    expect(calls.createComment[0].body).toContain('2026-05-11T13:00:00.000Z');
  });
});

describe('post-merge-monitor dedup red path (w2, AC-04 / AC-07)', () => {
  it('red + 1 open issue with matching sha -> createComment dedup, NO create', async () => {
    const workflowRun = {
      conclusion: 'failure',
      head_sha: 'Y',
      html_url: 'https://github.com/org/repo/actions/runs/555',
    };
    const openIssues = [{ number: 200, body: '**merge sha**: `Y` (already opened)' }];
    const { calls } = await drivePostMergeMonitor({ workflowRun, openIssues });

    expect(calls.create).toHaveLength(0);

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0].issue_number).toBe(200);
    const body = calls.createComment[0].body;
    expect(body).toContain('duplicate red detected on same head_sha');
    expect(body).toContain('Y');
    expect(body).toContain('https://github.com/org/repo/actions/runs/555');

    expect(calls.update).toHaveLength(0);
  });

  it('red + 2 open issues both with matching sha -> dedup comment on each, NO create', async () => {
    const workflowRun = {
      conclusion: 'failure',
      head_sha: 'Y2',
      html_url: 'https://github.com/org/repo/actions/runs/666',
    };
    const openIssues = [
      { number: 300, body: '**merge sha**: `Y2`' },
      { number: 301, body: '**merge sha**: `Y2` (sibling)' },
    ];
    const { calls } = await drivePostMergeMonitor({ workflowRun, openIssues });

    expect(calls.create).toHaveLength(0);
    expect(calls.createComment).toHaveLength(2);
    const numbers = calls.createComment.map((c) => c.issue_number).sort();
    expect(numbers).toEqual([300, 301]);
  });
});

describe('post-merge-monitor new-red defensive path (w2, AC-01)', () => {
  it('red + 0 matching open issue -> issues.create with three labels + body containing merge sha', async () => {
    const workflowRun = {
      conclusion: 'failure',
      head_sha: 'Z',
      html_url: 'https://github.com/org/repo/actions/runs/777',
    };
    const openIssues = [];
    const { calls } = await drivePostMergeMonitor({ workflowRun, openIssues });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].labels).toEqual(['post-merge', 'ci-failure', 'sla-24h']);
    expect(calls.create[0].body).toContain('**merge sha**: `Z`');

    expect(calls.createComment).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
  });

  it('red + open issue with DIFFERENT sha -> new issues.create (conservative, no false-positive dedup)', async () => {
    const workflowRun = {
      conclusion: 'failure',
      head_sha: 'Z2',
      html_url: 'https://github.com/org/repo/actions/runs/888',
    };
    const openIssues = [{ number: 400, body: '**merge sha**: `OTHER_SHA`' }];
    const { calls } = await drivePostMergeMonitor({ workflowRun, openIssues });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].body).toContain('**merge sha**: `Z2`');
    expect(calls.createComment).toHaveLength(0);
  });

  it('cancelled-superseded -> neither create nor close (filter passes through)', async () => {
    const workflowRun = {
      conclusion: 'cancelled',
      head_sha: 'W',
      html_url: 'https://github.com/org/repo/actions/runs/999',
    };
    const openIssues = [];
    const { calls } = await drivePostMergeMonitor({
      workflowRun,
      openIssues,
      superseded: true,
    });

    expect(calls.create).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
    expect(calls.createComment).toHaveLength(0);
  });
});

describe('findMatchingOpenIssues helper (D-P2 + D-P3)', () => {
  it('matches body containing **merge sha**: `<sha>` literal sentinel', () => {
    const matched = findMatchingOpenIssues('abc123', [
      { number: 1, body: 'preamble\n**merge sha**: `abc123`\ntail' },
      { number: 2, body: '**merge sha**: `other`' },
      { number: 3, body: 'no sha here' },
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0].number).toBe(1);
  });

  it('returns empty when no issue body contains the sentinel (conservative, no false positive)', () => {
    const matched = findMatchingOpenIssues('abc123', [
      { number: 1, body: 'external human issue with no sha' },
    ]);
    expect(matched).toEqual([]);
  });
});
