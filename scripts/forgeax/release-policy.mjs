import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const core = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const sequence = '(0|[1-9][0-9]*)';
const versionPattern = new RegExp(
  `^${core}(?:-dev\\.${sequence}\\.([0-9a-f]{12})|-rc\\.${sequence})?$`,
);

// `mirror` names the public repository branch; the rc test line is never mirrored.
const CHANNELS = {
  stable: { channel: 'stable', branch: 'stable', tag: 'latest', mirror: 'stable' },
  rc: { channel: 'rc', branch: 'rc', tag: 'rc', mirror: null },
  next: { channel: 'next', branch: 'main', tag: 'next', mirror: 'main' },
};

function parse(version) {
  const match = versionPattern.exec(version);
  if (match === null) throw new Error(`release-version-invalid: ${version}`);
  const channel = match[4] !== undefined ? 'next' : match[6] !== undefined ? 'rc' : 'stable';
  return {
    policy: CHANNELS[channel],
    core: match.slice(1, 4).map(BigInt),
    sequence: match[4] ?? match[6],
  };
}

function compareCore(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function releasePolicy(version) {
  return parse(version).policy;
}

export function assertSuccessfulCandidateRun(run, expectedRunId) {
  if (
    !Number.isSafeInteger(run?.id) ||
    String(run.id) !== String(expectedRunId) ||
    run.path !== '.github/workflows/sdk-release-candidate.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('release-candidate-run-not-successful');
}

/** The next development version continues the current `next` sequence on the next minor. */
export function developmentVersion(stable, currentNext, source) {
  if (releasePolicy(stable).channel !== 'stable' || !/^[0-9a-f]{40}$/.test(source)) {
    throw new Error('release-development-baseline-invalid');
  }
  const [major, minor] = stable.split('.');
  const core = `${major}.${BigInt(minor) + 1n}.0`;
  const previous = currentNext === undefined ? undefined : parse(currentNext);
  const sequence =
    previous?.policy.channel === 'next' && currentNext.startsWith(`${core}-dev.`)
      ? BigInt(previous.sequence) + 1n
      : 1n;
  const version = `${core}-dev.${sequence}.${source.slice(0, 12)}`;
  releasePolicy(version);
  return version;
}

/**
 * Stable must be an ancestor of every rc source so promotion is a fast-forward.
 * A stable version may also be prepared from the exact rc tip before `stable`
 * moves; its explicit Promotion fast-forwards `stable` to that source.
 * Returns the branch that admitted the source.
 */
export function assertReleaseSource(version, source, tips, ancestor) {
  const policy = releasePolicy(version);
  const sha = /^[0-9a-f]{40}$/.test(source);
  const containsStable = sha && tips.stable !== undefined && ancestor(tips.stable, source);
  if (!sha || tips[policy.branch] === undefined || !ancestor(source, tips[policy.branch])) {
    if (policy.channel === 'stable' && source === tips.rc && containsStable) return 'rc';
    throw new Error(`release-source-not-on-${policy.branch}: ${source}`);
  }
  if (policy.channel === 'next' && !version.endsWith(`.${source.slice(0, 12)}`)) {
    throw new Error('release-development-source-mismatch');
  }
  if (policy.channel === 'rc' && !containsStable) {
    throw new Error('release-rc-missing-stable');
  }
  return policy.branch;
}

/** The stable version an rc line tests. */
export function stableVersionOf(version) {
  const { policy, core } = parse(version);
  if (policy.channel !== 'rc') throw new Error(`release-version-not-rc: ${version}`);
  return core.join('.');
}

export function assertChannelAdvance(version, current) {
  if (current === undefined || current === version) return;
  const next = parse(version);
  const previous = parse(current);
  const order = compareCore(next.core, previous.core);
  if (order > 0) return;
  // Within one prerelease line the sequence orders; a released core admits no later prerelease.
  if (
    order === 0 &&
    next.policy === previous.policy &&
    next.sequence !== undefined &&
    BigInt(next.sequence) > BigInt(previous.sequence)
  )
    return;
  throw new Error(`release-channel-regression: ${current} -> ${version}`);
}

/** An rc tests the next stable patch; a hotfix that takes its number moves the rc line up. */
export function assertRcAboveStable(version, stable) {
  const candidate = parse(version);
  if (candidate.policy.channel !== 'rc' || stable === undefined) return;
  if (compareCore(candidate.core, parse(stable).core) <= 0)
    throw new Error(`release-rc-not-above-stable: ${version} <= ${stable}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, requested] = process.argv.slice(2);
  const policy = releasePolicy(version);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const history = git('rev-parse', '--is-shallow-repository') === 'true' ? ['--unshallow'] : [];
  const branches = policy.channel === 'next' ? ['main'] : ['stable', 'rc'];
  // Explicit refspecs also create tracking refs in a single-branch checkout. A
  // stable release from `stable` does not depend on an open rc line existing.
  const tips = {};
  for (const branch of branches) {
    try {
      git(
        'fetch',
        '--no-tags',
        ...(Object.keys(tips).length === 0 ? history : []),
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      );
      tips[branch] = git('rev-parse', `origin/${branch}`);
    } catch (error) {
      if (branch === policy.branch || branch === 'stable') throw error;
    }
  }
  const source = requested || tips[policy.branch];
  const sourceBranch = assertReleaseSource(version, source, tips, (sha, head) => {
    try {
      git('merge-base', '--is-ancestor', sha, head);
      return true;
    } catch {
      return false;
    }
  });
  process.stdout.write(
    `source_sha=${source}\nsource_branch=${sourceBranch}\nchannel=${policy.channel}\n`,
  );
}
