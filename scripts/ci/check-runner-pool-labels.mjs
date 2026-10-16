#!/usr/bin/env node
// Enforce explicit resource-pool labels on self-hosted workflow jobs. Ordinary
// CI must stay on the organization's self-hosted Linux fleet; hosted native
// runners are reserved for the explicitly low-frequency nightly lane.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SELF_HOSTED_LABEL = 'self-hosted';
export const POOL_LABELS = Object.freeze(['standard', 'heavy']);
export const SELF_HOSTED_CAPABILITY_LABELS = Object.freeze(['gpu']);

const HOSTED_LABEL_PATTERN = /^(?:ubuntu|windows|macos)(?:-[a-z0-9][a-z0-9.-]*)?$/;

function withoutComment(line) {
  return line.replace(/\s+#.*$/, '').trimEnd();
}

function unquote(value) {
  let result = value.trim();
  let changed = true;
  while (changed && result.length >= 2) {
    changed = false;
    const first = result[0];
    const last = result.at(-1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      result = result.slice(1, -1).trim();
      changed = true;
    }
  }
  return result;
}

function parseArray(value) {
  const body = value.trim().slice(1, -1);
  if (!body.trim()) return [];
  return body
    .split(',')
    .map((entry) => unquote(entry))
    .filter(Boolean);
}

function parseStaticRunnerLabels(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseArray(trimmed);
  }

  const jsonExpression = trimmed.match(/fromJSON\(\s*(['"])(\[[\s\S]*\])\1\s*\)/);
  if (jsonExpression) {
    try {
      const parsed = JSON.parse(jsonExpression[2]);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  if (/^['"].*['"]$/.test(trimmed)) return [unquote(trimmed)];
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return [trimmed];
  return null;
}

function parseRunnerValue(value) {
  const unquoted = unquote(value);
  try {
    const parsed = JSON.parse(unquoted);
    if (typeof parsed === 'string') return [parsed];
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // The normal nightly form is a quoted scalar, not JSON after unquoting.
  }
  return unquoted ? [unquoted] : [];
}

function hostedLabel(label) {
  return HOSTED_LABEL_PATTERN.test(label);
}

function hostedLabelsForClassification(classification) {
  if (classification.kind === 'github-hosted') return classification.labels;
  return classification.hostedLabels ?? [];
}

function isDisabledCondition(value) {
  return /^(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/.test(value.trim());
}

function isDisabledJob(block) {
  return block.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*if:\s*(.*)$/);
    return match ? isDisabledCondition(match[1]) : false;
  });
}

function isNightlyWorkflow(file) {
  return /nightly/i.test(file);
}

function selectorError(file, line, job, message) {
  return `${file}:${line}: job ${job}: ${message}`;
}

export function classifyRunnerSelector(value, runnerValues = []) {
  const trimmed = value.trim();

  if (/fromJSON\(\s*matrix\.runner\s*\)/.test(trimmed)) {
    const entries = runnerValues.map(parseRunnerValue).filter((entry) => entry.length > 0);
    const labels = entries.flat();
    if (entries.length === 0) {
      return { kind: 'error', message: 'dynamic matrix.runner has no statically declared values' };
    }

    const selfHostedEntries = entries.filter((entry) => entry.includes(SELF_HOSTED_LABEL));
    const hostedEntries = entries.filter((entry) => !entry.includes(SELF_HOSTED_LABEL));
    if (selfHostedEntries.length > 0) {
      const pools = [];
      for (const entry of selfHostedEntries) {
        const entryPools = entry.filter((label) => POOL_LABELS.includes(label));
        if (entryPools.length !== 1) {
          return {
            kind: 'error',
            message:
              'dynamic self-hosted runner selection must declare exactly one of standard or heavy explicitly',
          };
        }
        pools.push(entryPools[0]);
      }
      const hostedLabels = hostedEntries.flat();
      const invalidHostedLabels = hostedLabels.filter((label) => !hostedLabel(label));
      if (invalidHostedLabels.length > 0) {
        return {
          kind: 'error',
          message: `unsupported dynamic runner labels: ${invalidHostedLabels.join(', ')}`,
        };
      }
      const pool = new Set(pools).size === 1 ? pools[0] : null;
      const capabilities = selfHostedEntries
        .flat()
        .filter((label) => SELF_HOSTED_CAPABILITY_LABELS.includes(label));
      return hostedEntries.length > 0
        ? { kind: 'mixed', labels, hostedLabels, pool, capabilities }
        : { kind: 'self-hosted', labels, pool, capabilities };
    }

    return labels.every(hostedLabel)
      ? { kind: 'github-hosted', labels }
      : { kind: 'error', message: `unsupported dynamic runner labels: ${labels.join(', ')}` };
  }

  const labels = parseStaticRunnerLabels(trimmed);
  if (!labels) return { kind: 'error', message: `cannot statically classify runs-on: ${trimmed}` };

  if (labels.includes(SELF_HOSTED_LABEL)) {
    const pools = labels.filter((label) => POOL_LABELS.includes(label));
    if (pools.length === 0) {
      const capabilities = labels.filter((label) => SELF_HOSTED_CAPABILITY_LABELS.includes(label));
      const capabilityOnlyLabels = new Set([
        SELF_HOSTED_LABEL,
        'Linux',
        'X64',
        ...SELF_HOSTED_CAPABILITY_LABELS,
      ]);
      if (capabilities.length === 1 && labels.every((label) => capabilityOnlyLabels.has(label))) {
        return { kind: 'self-hosted', labels, pool: null, capabilities };
      }
    }
    if (pools.length !== 1) {
      return {
        kind: 'error',
        message: `self-hosted selector must contain exactly one of ${POOL_LABELS.join(' or ')}; found ${pools.length ? pools.join(', ') : 'neither'}`,
      };
    }
    const capabilities = labels.filter((label) => SELF_HOSTED_CAPABILITY_LABELS.includes(label));
    return { kind: 'self-hosted', labels, pool: pools[0], capabilities };
  }

  return labels.length === 1 && labels.every(hostedLabel)
    ? { kind: 'github-hosted', labels }
    : { kind: 'error', message: `unsupported runner labels: ${labels.join(', ') || '<empty>'}` };
}

function workflowHasPullRequestTrigger(lines) {
  let inOn = false;
  for (const line of lines) {
    const clean = withoutComment(line);
    const onMatch = clean.match(/^on:\s*(.*)$/);
    if (onMatch) {
      const inline = onMatch[1];
      if (/\bpull_request(?:_target)?\b/.test(inline)) return true;
      inOn = inline.trim() === '';
      continue;
    }
    if (!inOn) continue;
    if (/^[A-Za-z0-9_.-]+:\s*/.test(clean)) {
      inOn = false;
      continue;
    }
    if (/^ {2}pull_request(?:_target)?:\s*$/.test(clean)) return true;
  }
  return false;
}

function workflowHasMainPushTrigger(lines) {
  let inOn = false;
  let inPush = false;
  let inPushBranches = false;
  for (const line of lines) {
    const clean = withoutComment(line);
    const onMatch = clean.match(/^on:\s*(.*)$/);
    if (onMatch) {
      const inline = onMatch[1];
      if (/\bpush\b/.test(inline) && /\bmain\b/.test(inline)) return true;
      inOn = inline.trim() === '';
      inPush = false;
      inPushBranches = false;
      continue;
    }
    if (!inOn) continue;

    const pushMatch = clean.match(/^ {2}push:\s*(.*)$/);
    if (pushMatch) {
      if (/\bmain\b/.test(pushMatch[1])) return true;
      inPush = true;
      inPushBranches = false;
      continue;
    }
    if (/^ {2}[A-Za-z0-9_.-]+:\s*/.test(clean)) {
      inPush = false;
      inPushBranches = false;
      continue;
    }
    if (!inPush) continue;

    const branchesMatch = clean.match(/^ {4}branches:\s*(.*)$/);
    if (branchesMatch) {
      if (/\bmain\b/.test(branchesMatch[1])) return true;
      inPushBranches = branchesMatch[1].trim() === '';
      continue;
    }
    if (inPushBranches && /^ {6}-\s*['"]?main['"]?\s*$/.test(clean)) return true;
  }
  return false;
}

function workflowHasWorkflowRunTrigger(lines) {
  let inOn = false;
  for (const line of lines) {
    const clean = withoutComment(line);
    const onMatch = clean.match(/^on:\s*(.*)$/);
    if (onMatch) {
      if (/\bworkflow_run\b/.test(onMatch[1])) return true;
      inOn = onMatch[1].trim() === '';
      continue;
    }
    if (!inOn) continue;
    if (/^ {2}workflow_run:\s*/.test(clean)) return true;
    if (/^ {2}[A-Za-z0-9_.-]+:\s*/.test(clean)) {
      inOn = false;
    }
  }
  return false;
}

function jobBlock(lines, lineNumber) {
  const selectorIndex = lineNumber - 1;
  let start = selectorIndex;
  while (start >= 0 && !/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(withoutComment(lines[start]))) {
    start -= 1;
  }
  let end = lines.length;
  for (let index = selectorIndex + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(withoutComment(lines[index]))) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).map(withoutComment).join('\n');
}

function jobExcludedFromPullRequest(block) {
  return (
    /github\.event_name\s*==\s*['"](?:push|workflow_dispatch|schedule|workflow_run|workflow_call)['"]/.test(
      block,
    ) || /github\.event_name\s*!=\s*['"]pull_request(?:_target)?['"]/.test(block)
  );
}

function jobExcludedFromEvent(block, eventName) {
  const equalEvents = [...block.matchAll(/github\.event_name\s*==\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  if (equalEvents.length > 0 && !equalEvents.includes(eventName)) return true;
  const notEqualEvents = [...block.matchAll(/github\.event_name\s*!=\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  return notEqualEvents.includes(eventName);
}

export function checkPullRequestRunnerPolicy(
  text,
  file = '<workflow>',
  baseResult = checkWorkflowText(text, file),
) {
  const lines = text.split(/\r?\n/);
  const pullRequest = workflowHasPullRequestTrigger(lines);
  if (!pullRequest) return { pullRequest, hostedSelectors: [], errors: [] };

  const hostedSelectors = baseResult.selectors.filter(
    (selector) =>
      hostedLabelsForClassification(selector).length > 0 &&
      !jobExcludedFromPullRequest(jobBlock(lines, selector.line)),
  );
  const errors = hostedSelectors.map((selector) =>
    selectorError(
      file,
      selector.line,
      selector.job,
      `PR-triggered job must use a self-hosted runner; found ${selector.value}`,
    ),
  );
  return { pullRequest, hostedSelectors, errors };
}

export function checkPostMergeRunnerPolicy(
  text,
  file = '<workflow>',
  baseResult = checkWorkflowText(text, file),
) {
  const lines = text.split(/\r?\n/);
  const mainPush = workflowHasMainPushTrigger(lines);
  const workflowRun = workflowHasWorkflowRunTrigger(lines);
  const postMerge = mainPush || workflowRun;
  if (!postMerge) {
    return {
      postMerge,
      mainPush,
      workflowRun,
      hostedSelectors: [],
      errors: [],
    };
  }

  const hostedSelectors = baseResult.selectors.filter((selector) => {
    if (hostedLabelsForClassification(selector).length === 0) return false;
    const block = jobBlock(lines, selector.line);
    return (
      (mainPush && !jobExcludedFromEvent(block, 'push')) ||
      (workflowRun && !jobExcludedFromEvent(block, 'workflow_run'))
    );
  });
  const errors = hostedSelectors.map((selector) =>
    selectorError(
      file,
      selector.line,
      selector.job,
      `post-merge job must use a self-hosted runner; found ${selector.value}`,
    ),
  );
  return { postMerge, mainPush, workflowRun, hostedSelectors, errors };
}

export function checkWorkflowText(text, file = '<workflow>') {
  const lines = text.split(/\r?\n/);
  const runnerValues = [];
  let inJobs = false;
  let currentJob = '<unknown>';
  const jobs = new Map();
  const selectors = [];
  const errors = [];

  for (const line of lines) {
    const clean = withoutComment(line);
    const runnerMatch = clean.match(/^\s*(?:-\s+)?runner:\s*(.+)$/);
    if (runnerMatch) runnerValues.push(runnerMatch[1]);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const clean = withoutComment(lines[index]);
    if (/^jobs:\s*$/.test(clean)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const jobMatch = clean.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, { hasRunsOn: false, hasUses: false, disabled: false });
      continue;
    }

    const jobIfMatch = clean.match(/^ {4}if:\s*(.*)$/);
    if (jobIfMatch && jobs.has(currentJob)) {
      jobs.get(currentJob).disabled = isDisabledCondition(jobIfMatch[1]);
    }

    if (/^ {4}uses:\s*\S+/.test(clean) && jobs.has(currentJob)) {
      jobs.get(currentJob).hasUses = true;
    }

    const runsOnMatch = clean.match(/^ {4}runs-on:\s*(.*)$/);
    if (!runsOnMatch) continue;

    const value = runsOnMatch[1].trim();
    if (!value) {
      errors.push(
        selectorError(file, lineNumber, currentJob, 'runs-on must be a single-line selector'),
      );
      continue;
    }

    jobs.get(currentJob).hasRunsOn = true;
    const block = jobBlock(lines, lineNumber);
    if (isDisabledJob(block)) continue;

    const classification = classifyRunnerSelector(value, runnerValues);
    selectors.push({ file, line: lineNumber, job: currentJob, value, ...classification });
    if (classification.kind === 'error') {
      errors.push(selectorError(file, lineNumber, currentJob, classification.message));
      continue;
    }

    const hostedLabels = hostedLabelsForClassification(classification);
    if (hostedLabels.length > 0 && !isNightlyWorkflow(file)) {
      const hasNativeHosted = hostedLabels.some((label) => /^(?:macos|windows)-/i.test(label));
      errors.push(
        selectorError(
          file,
          lineNumber,
          currentJob,
          hasNativeHosted
            ? `direct GitHub-hosted macOS/Windows is disabled; do not use it for daily development. Disable this job with if: \${{ false }} or move it to the approved nightly lane`
            : 'GitHub-hosted Linux is disabled; use self-hosted Linux X64 with exactly one standard or heavy capacity label',
        ),
      );
    }
  }

  for (const [job, definition] of jobs) {
    if (!definition.disabled && !definition.hasRunsOn && !definition.hasUses) {
      errors.push(`${file}: job ${job}: job must declare runs-on or use a reusable workflow`);
    }
  }

  return { selectors, errors };
}

export function checkWorkflowDirectory(
  workflowsDir,
  { requireSelfHostedPr = false, requireSelfHostedPostMerge = false } = {},
) {
  const directory = resolve(workflowsDir);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  const results = files.map((file) => {
    const text = readFileSync(`${directory}/${file}`, 'utf8');
    const result = checkWorkflowText(text, file);
    const pullRequestPolicy = requireSelfHostedPr
      ? checkPullRequestRunnerPolicy(text, file, result)
      : { pullRequest: false, hostedSelectors: [], errors: [] };
    const postMergePolicy = requireSelfHostedPostMerge
      ? checkPostMergeRunnerPolicy(text, file, result)
      : {
          postMerge: false,
          mainPush: false,
          workflowRun: false,
          hostedSelectors: [],
          errors: [],
        };
    return {
      file,
      ...result,
      pullRequest: pullRequestPolicy.pullRequest,
      pullRequestHostedSelectors: pullRequestPolicy.hostedSelectors,
      pullRequestPolicyErrors: pullRequestPolicy.errors,
      postMerge: postMergePolicy.postMerge,
      postMergeHostedSelectors: postMergePolicy.hostedSelectors,
      postMergePolicyErrors: postMergePolicy.errors,
    };
  });
  return {
    files,
    selectors: results.flatMap((result) => result.selectors),
    errors: results.flatMap((result) => [
      ...result.errors,
      ...result.pullRequestPolicyErrors,
      ...result.postMergePolicyErrors,
    ]),
    pullRequestWorkflows: results
      .filter((result) => result.pullRequest)
      .map((result) => result.file),
    pullRequestHostedSelectors: results.flatMap((result) => result.pullRequestHostedSelectors),
    postMergeWorkflows: results.filter((result) => result.postMerge).map((result) => result.file),
    postMergeHostedSelectors: results.flatMap((result) => result.postMergeHostedSelectors),
  };
}

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const workflowsDir = argumentValue(args, '--workflows-dir', '.github/workflows');
  const requireSelfHostedPr = args.includes('--require-self-hosted-pr');
  const requireSelfHostedPostMerge = args.includes('--require-self-hosted-post-merge');
  const result = checkWorkflowDirectory(workflowsDir, {
    requireSelfHostedPr,
    requireSelfHostedPostMerge,
  });
  const policyFlags = [
    requireSelfHostedPr ? '--require-self-hosted-pr' : '',
    requireSelfHostedPostMerge ? '--require-self-hosted-post-merge' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (result.errors.length > 0) {
    process.stderr.write(
      `[reason] runner-pool-label-contract: every active Linux job must use self-hosted Linux X64 with exactly one standard/heavy capacity label; direct hosted macOS/Windows is disabled for daily development;\n         ${result.errors.join('\n         ')}\n[rerun]  node scripts/ci/check-runner-pool-labels.mjs --workflows-dir ${workflowsDir}${policyFlags ? ` ${policyFlags}` : ''}\n[hint]   Disable non-compliant jobs with if: \${{ false }} or move the low-frequency native lane to nightly.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const selfHosted = result.selectors.filter((selector) => selector.kind === 'self-hosted');
  const hosted = result.selectors.filter((selector) => selector.kind === 'github-hosted');
  const capabilityOnly = selfHosted.filter((selector) => selector.pool === null);
  const policy = [
    requireSelfHostedPr
      ? `PR policy: ${result.pullRequestWorkflows.length} workflow(s), ${result.pullRequestHostedSelectors.length} hosted selector(s)`
      : '',
    requireSelfHostedPostMerge
      ? `post-merge policy: ${result.postMergeWorkflows.length} workflow(s), ${result.postMergeHostedSelectors.length} hosted selector(s)`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  process.stdout.write(
    `[ok] runner pool labels: ${selfHosted.length} self-hosted job selectors (${selfHosted.filter((selector) => selector.pool === 'standard').length} standard, ${selfHosted.filter((selector) => selector.pool === 'heavy').length} heavy, ${capabilityOnly.length} capability-only); ${hosted.length} GitHub-hosted selector(s)${policy ? `; ${policy}` : ''}\n`,
  );
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
