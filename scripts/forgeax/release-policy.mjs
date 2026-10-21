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

/** Stable must be an ancestor of every rc source so promotion is a fast-forward. */
export function assertReleaseSource(version, source, branchTip, ancestor, stableTip) {
  const policy = releasePolicy(version);
  if (!/^[0-9a-f]{40}$/.test(source) || !ancestor(source, branchTip)) {
    throw new Error(`release-source-not-on-${policy.branch}: ${source}`);
  }
  if (policy.channel === 'next' && !version.endsWith(`.${source.slice(0, 12)}`)) {
    throw new Error('release-development-source-mismatch');
  }
  if (policy.channel === 'rc' && (stableTip === undefined || !ancestor(stableTip, source))) {
    throw new Error('release-rc-missing-stable');
  }
  return policy;
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
  const branches = policy.channel === 'rc' ? [policy.branch, 'stable'] : [policy.branch];
  // Explicit refspecs also create tracking refs in a single-branch checkout.
  const refspecs = branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git('fetch', '--no-tags', ...history, 'origin', ...refspecs);
  const tip = git('rev-parse', `origin/${policy.branch}`);
  const stableTip = policy.channel === 'rc' ? git('rev-parse', 'origin/stable') : undefined;
  const source = requested || tip;
  assertReleaseSource(
    version,
    source,
    tip,
    (sha, head) => {
      try {
        git('merge-base', '--is-ancestor', sha, head);
        return true;
      } catch {
        return false;
      }
    },
    stableTip,
  );
  process.stdout.write(
    `source_sha=${source}\nsource_branch=${policy.branch}\nchannel=${policy.channel}\n`,
  );
}
