import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const core = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const versionPattern = new RegExp(`^${core}(?:-dev\\.(0|[1-9][0-9]*)\\.([0-9a-f]{12}))?$`);

export function releasePolicy(version) {
  const match = versionPattern.exec(version);
  if (match === null) throw new Error(`release-version-invalid: ${version}`);
  return match[4] === undefined
    ? { channel: 'stable', branch: 'stable', tag: 'latest' }
    : { channel: 'next', branch: 'main', tag: 'next' };
}

export function developmentVersion(stable, sequence, source) {
  if (releasePolicy(stable).channel !== 'stable' || !/^[0-9a-f]{40}$/.test(source)) {
    throw new Error('release-development-baseline-invalid');
  }
  const [major, minor] = stable.split('.');
  const version = `${major}.${BigInt(minor) + 1n}.0-dev.${sequence}.${source.slice(0, 12)}`;
  releasePolicy(version);
  return version;
}

export function assertReleaseSource(version, source, branchTip, ancestor) {
  const policy = releasePolicy(version);
  if (!/^[0-9a-f]{40}$/.test(source) || !ancestor(source, branchTip)) {
    throw new Error(`release-source-not-on-${policy.branch}: ${source}`);
  }
  if (policy.channel === 'next' && !version.endsWith(`.${source.slice(0, 12)}`)) {
    throw new Error('release-development-source-mismatch');
  }
  return policy;
}

export function assertChannelAdvance(version, current) {
  const policy = releasePolicy(version);
  if (current === undefined || current === version) return;
  const coreParts = (value) => value.split('-')[0].split('.').map(BigInt);
  const next = coreParts(version);
  const previous = coreParts(current);
  for (let index = 0; index < 3; index++) {
    if (next[index] > previous[index]) return;
    if (next[index] < previous[index])
      throw new Error(`release-channel-regression: ${current} -> ${version}`);
  }
  if (policy.channel === 'next') {
    // The historical SHA-only next identity had no ordered sequence.
    const match = /-dev\.([0-9]+)\.[0-9a-f]{12}$/.exec(current);
    if (match !== null && BigInt(versionPattern.exec(version)[4]) <= BigInt(match[1])) {
      throw new Error(`release-channel-regression: ${current} -> ${version}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, requested] = process.argv.slice(2);
  const policy = releasePolicy(version);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const history = git('rev-parse', '--is-shallow-repository') === 'true' ? ['--unshallow'] : [];
  git('fetch', '--no-tags', ...history, 'origin', policy.branch);
  const tip = git('rev-parse', `origin/${policy.branch}`);
  const source = requested || tip;
  assertReleaseSource(version, source, tip, (sha, head) => {
    try {
      git('merge-base', '--is-ancestor', sha, head);
      return true;
    } catch {
      return false;
    }
  });
  process.stdout.write(
    `source_sha=${source}\nsource_branch=${policy.branch}\nchannel=${policy.channel}\n`,
  );
}
