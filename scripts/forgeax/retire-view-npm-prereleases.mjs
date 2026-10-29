import { execFileSync } from 'node:child_process';

const packageName = '@forgeax/view';
const deprecationMessage =
  'Standalone View prereleases are retired. Use @forgeax/engine-sdk on the same channel to receive its embedded View tool paired with Engine.';
const expectedTags = {
  latest: '0.4.18',
  beta: '0.2.1-beta-20260924075842',
  rc: '0.4.18-rc.1',
  candidate: '0.5.0-dev.15096.c15198eb4992',
  next: '0.5.0-dev.15096.c15198eb4992',
};
const retiredTags = ['beta', 'rc', 'candidate', 'next'];

function npm(args) {
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function readJson(args) {
  return JSON.parse(npm(args));
}

function readDistTags() {
  const result = readJson(['view', packageName, 'dist-tags', '--json']);
  const tags = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error('invalid-view-dist-tags-response');
  }
  return tags;
}

const tags = readDistTags();
for (const [tag, expected] of Object.entries(expectedTags)) {
  if (tags[tag] !== undefined && tags[tag] !== expected) {
    throw new Error(`unexpected-${tag}-tag-target:${tags[tag]}`);
  }
}
if (tags.latest !== expectedTags.latest) {
  throw new Error(`unexpected-latest-tag-target:${tags.latest}`);
}

const versions = readJson(['view', packageName, 'versions', '--json']);
const prereleases = versions.filter((version) => version.includes('-'));
if (prereleases.length === 0) throw new Error('standalone-view-prereleases-not-found');

for (const tag of retiredTags) {
  if (tags[tag] !== undefined) npm(['dist-tag', 'rm', packageName, tag]);
}
for (const version of prereleases) {
  npm(['deprecate', `${packageName}@${version}`, deprecationMessage]);
}

const remainingTags = readDistTags();
if (remainingTags.latest !== expectedTags.latest) {
  throw new Error(`latest-tag-changed:${remainingTags.latest}`);
}
for (const tag of retiredTags) {
  if (remainingTags[tag] !== undefined) throw new Error(`retired-tag-remains:${tag}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      package: packageName,
      removedTags: retiredTags.filter((tag) => tags[tag] !== undefined),
      deprecatedPrereleaseCount: prereleases.length,
      retainedLatest: remainingTags.latest,
    },
    null,
    2,
  ),
);
