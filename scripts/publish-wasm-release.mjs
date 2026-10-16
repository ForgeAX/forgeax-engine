import { readFile } from 'node:fs/promises';

const [tag, assetName, tarballPath] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (!tag || !assetName || !tarballPath) {
  throw new Error('usage: publish-wasm-release.mjs <tag> <asset-name> <tarball-path>');
}
if (!token || !repository) {
  throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
}

const apiBase = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? 'GET'} ${url} failed (${response.status}): ${body}`);
  }
  return response;
}

async function findRelease() {
  const response = await fetch(`${apiBase}/releases/tags/${tag}`, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET release ${tag} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

let release = await findRelease();
if (!release) {
  try {
    release = await request(`${apiBase}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: 'WASM Artifacts',
        body: 'Content-keyed WASM artifacts for forgeax engine wasm packages.',
      }),
    }).then((response) => response.json());
    console.log(`created release ${tag}`);
  } catch (error) {
    // The three package jobs may create this shared release concurrently. If a
    // sibling won the race, reread it rather than failing the independent asset.
    release = await findRelease();
    if (!release) throw error;
  }
}

if (release.assets.some((asset) => asset.name === assetName)) {
  console.log(`asset ${assetName} already published — skipping`);
  process.exit(0);
}

const uploadBase = release.upload_url.replace('{?name,label}', '');
const tarball = await readFile(tarballPath);
await request(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: tarball,
});
console.log(`uploaded ${assetName}`);
