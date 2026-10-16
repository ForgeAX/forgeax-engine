import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apiBase = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository ?? ''}`;

function values(name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) result.push(args[index + 1]);
  }
  return result;
}

function value(name) {
  return values(name)[0];
}

if (!repository || !token) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
const tag = value('--tag');
const title = value('--title');
const notesFile = value('--notes-file');
const expectedCommit = value('--commit');
const assetPaths = values('--asset');
if (
  !tag ||
  !title ||
  !notesFile ||
  !expectedCommit ||
  assetPaths.length === 0 ||
  assetPaths.some((path) => typeof path !== 'string' || path.length === 0)
) {
  throw new Error(
    'usage: finalize-sdk-release.mjs --tag <tag> --title <title> --notes-file <path> --commit <sha> --asset <path> ...',
  );
}
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('sdk-release-commit-invalid');

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${url} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response;
}

async function findRelease() {
  const response = await fetch(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`GET release ${tag} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function resolveTagCommit() {
  const response = await fetch(`${apiBase}/git/ref/tags/${encodeURIComponent(tag)}`, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`GET tag ${tag} failed (${response.status}): ${await response.text()}`);
  const ref = await response.json();
  if (ref.object.type === 'commit') return ref.object.sha;
  if (ref.object.type !== 'tag') throw new Error(`sdk-release-tag-object-invalid: ${tag}`);
  const annotated = await request(`${apiBase}/git/tags/${encodeURIComponent(ref.object.sha)}`);
  const object = (await annotated.json()).object;
  if (object?.type !== 'commit' || typeof object.sha !== 'string') {
    throw new Error(`sdk-release-annotated-tag-target-invalid: ${tag}`);
  }
  return object.sha;
}

async function waitForTag() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const commit = await resolveTagCommit();
    if (commit === expectedCommit) return;
    if (commit !== undefined) throw new Error(`sdk-release-tag-target-mismatch: ${commit}`);
    await new Promise((accept) => setTimeout(accept, 1000));
  }
  throw new Error(`sdk-release-tag-not-visible: ${tag}`);
}

async function createOrReadRelease() {
  const existing = await findRelease();
  if (existing !== undefined) return existing;
  try {
    return await request(`${apiBase}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: expectedCommit,
        name: title,
        body: await readFile(notesFile, 'utf8'),
        prerelease: tag.includes('-dev.'),
        make_latest: tag.includes('-dev.') ? 'false' : 'true',
      }),
    }).then((response) => response.json());
  } catch (cause) {
    const raced = await findRelease();
    if (raced !== undefined) return raced;
    throw cause;
  }
}

async function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadAsset(asset) {
  const response = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`sdk-release-asset-download-failed: ${asset.name}`);
  return Buffer.from(await response.arrayBuffer());
}

async function uploadAsset(release, name, bytes) {
  const uploadUrl = release.upload_url.replace('{?name,label}', '');
  return request(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  }).then((response) => response.json());
}

const release = await createOrReadRelease();
await waitForTag();
const remoteByName = new Map(release.assets.map((asset) => [asset.name, asset]));
const result = [];
for (const path of assetPaths) {
  const bytes = await readFile(path);
  const name = basename(path);
  if (name.length === 0) throw new Error(`sdk-release-asset-name-invalid: ${path}`);
  const digest = await sha256(bytes);
  const existing = remoteByName.get(name);
  if (existing !== undefined) {
    const remoteDigest = await sha256(await downloadAsset(existing));
    if (remoteDigest !== digest) throw new Error(`sdk-release-asset-conflict: ${name}`);
    result.push({ name, sha256: digest, status: 'existing' });
    continue;
  }
  const uploaded = await uploadAsset(release, name, bytes);
  if (uploaded?.name !== name || typeof uploaded.url !== 'string') {
    throw new Error(`sdk-release-asset-upload-invalid: ${name}`);
  }
  const remoteDigest = await sha256(await downloadAsset(uploaded));
  if (remoteDigest !== digest) throw new Error(`sdk-release-asset-integrity-mismatch: ${name}`);
  remoteByName.set(name, uploaded);
  result.push({ name, sha256: digest, status: 'uploaded' });
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    tag,
    commit: expectedCommit,
    releaseId: release.id,
    assets: result,
  })}\n`,
);
