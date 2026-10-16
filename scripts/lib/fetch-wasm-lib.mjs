// fetch-wasm-lib.mjs — Shared GitHub Release fetch helpers for the three
// per-package fetch-wasm.mjs scripts (wgpu-wasm, codec, fbx).
//
// SSOT for: FetchError, parseGitOrigin, getGitOrigin, authHeaders (with
// `gh auth token` fallback), getReleaseByTag, downloadAsset, extractTarball.
// Network transport is ordered Node fetch -> gh CLI -> curl/curl.exe so a
// platform-native TLS stack can recover from enterprise interception.
//
// Architecture-principles #1 (SSOT), #4 (Pipeline Isolation): each per-package
// fetch-wasm.mjs provides its own content-key computation + main() orchestration;
// this module provides the GitHub API surface that is identical across all three.

import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve as resolvePath, sep } from 'node:path';

const GITHUB_API_ACCEPT = 'application/vnd.github+json';
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND']);

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export class FetchError extends Error {
  /** @readonly */ code;
  /** @readonly */ hint;
  constructor(code, message, hint) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// git origin -> { owner, repo }
// ---------------------------------------------------------------------------

/**
 * Parse a git remote URL into { owner, repo }.
 * Supports SSH (git@github.com:OWNER/REPO.git) and HTTPS
 * (https://github.com/OWNER/REPO.git), including HTTPS URLs that embed
 * credentials (https://TOKEN@github.com/OWNER/REPO.git or
 * https://USER:PASS@github.com/...) as written by git credential helpers /
 * Windows Git Credential Manager. Throws FetchError for non-GitHub hosts or
 * unparseable URLs.
 */
export function parseGitOrigin(url) {
  // SSH: git@github.com:OWNER/REPO.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return assertGitHub(sshMatch[1], sshMatch[2]);
  }
  // HTTPS: https://github.com/OWNER/REPO.git — the optional (?:[^@]+@)?
  // non-capturing group skips embedded credentials (TOKEN@ or USER:PASS@)
  // so the host capture is the bare hostname, not "TOKEN@github.com".
  const httpsMatch = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return assertGitHub(httpsMatch[1], httpsMatch[2]);
  }
  throw new FetchError(
    'E3_ORIGIN_PARSE_FAILED',
    `Cannot parse git origin URL: ${url}.`,
    'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
  );
}

function assertGitHub(host, path) {
  if (host !== 'github.com') {
    throw new FetchError(
      'E3_ORIGIN_UNSUPPORTED_HOST',
      `Unsupported git host: ${host}.`,
      'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
    );
  }
  const parts = path.split('/');
  if (parts.length !== 2) {
    throw new FetchError(
      'E3_ORIGIN_PARSE_FAILED',
      `Cannot parse owner/repo from: ${path}.`,
      'Expected git@github.com:OWNER/REPO.git or https://github.com/OWNER/REPO.git format.',
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Read the git remote "origin" URL and parse it into { owner, repo }.
 * Throws FetchError if there is no origin remote configured.
 */
export function getGitOrigin() {
  let url;
  try {
    url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
  } catch {
    throw new FetchError(
      'E3_NO_ORIGIN',
      'No git remote "origin" configured.',
      'This repository has no "origin" remote. Set one with `git remote add origin <url>`.',
    );
  }
  return parseGitOrigin(url);
}

// ---------------------------------------------------------------------------
// GitHub authentication
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header for GitHub API requests.
 * Prefers GITHUB_TOKEN, then GH_TOKEN (the name the official `gh` CLI and many
 * CI systems set), then falls back to `gh auth token` CLI.
 */
export function authHeaders(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || resolveGhCliToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fallback to `gh auth token` when GITHUB_TOKEN env var is not set. */
function resolveGhCliToken() {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function commandText(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}

function parseHttpStatus(text) {
  const matches = [
    ...String(text).matchAll(/\bHTTP(?:\/\d(?:\.\d+)?)?\s+(\d{3})\b|\(HTTP\s+(\d{3})\)/gi),
  ];
  const match = matches.at(-1);
  return match ? Number(match[1] || match[2]) : undefined;
}

function parseCurlResponse(stdout) {
  const text = String(stdout || '');
  const marker = text.match(/\n(\d{3})\s*$/);
  if (!marker) return { body: text, status: undefined };
  return {
    body: text.slice(0, marker.index).trimEnd(),
    status: Number(marker[1]),
  };
}

function commandFailure(result) {
  return result?.status !== 0;
}

function commandResultLabel(result) {
  if (result?.status === 0) return 'ok';
  if (result?.error?.code) return result.error.code;
  const status = parseHttpStatus(commandText(result));
  return status ? `HTTP ${status}` : 'failed';
}

function attemptSummary(attempts) {
  if (attempts.length === 0) return 'none';
  return attempts.map((attempt) => `${attempt.label} (${attempt.result})`).join(', ');
}

function transportKind(error) {
  const code = error?.cause?.code || error?.code;
  const text = `${code || ''} ${error?.message || error || ''}`;
  if (TLS_ERROR_CODES.has(code) || /\b(?:cert|certificate|ssl|tls)\b/i.test(text)) return 'TLS';
  if (DNS_ERROR_CODES.has(code) || /\b(?:dns|resolve|name lookup)\b/i.test(text)) return 'DNS';
  return 'network';
}

function networkHint({ buildHint, error, attempts }) {
  const kind = transportKind(error);
  const cause =
    kind === 'TLS'
      ? 'Node fetch failed during TLS verification; check the enterprise proxy or trusted CA configuration.'
      : kind === 'DNS'
        ? 'Node fetch failed during DNS or host resolution.'
        : 'Node fetch did not reach an HTTP response.';
  return `${cause} OS-native fallback attempts: ${attemptSummary(attempts)}. Set GH_TOKEN/GITHUB_TOKEN or run \`gh auth login\`, then retry. ${buildHint}.`;
}

function networkError({ operation, error, buildHint, attempts }) {
  const detail = error?.message || error || 'unknown transport error';
  return new FetchError(
    'E1_NETWORK',
    `${operation} failed after Node fetch and OS-native transport attempts: ${detail}`,
    networkHint({ buildHint, error, attempts }),
  );
}

function responseError({ status, statusText, owner, repo, tag, pkgLabel, buildHint, operation }) {
  if (status === 404) {
    return new FetchError(
      'E2_ASSET_NOT_FOUND',
      operation === 'release'
        ? `Release tag "${tag}" not found on ${owner}/${repo}.`
        : `Release asset not found on ${owner}/${repo} (tag: ${tag}).`,
      `No pre-built ${pkgLabel} release or asset exists for this content. ${buildHint}, or push to main to trigger a CI release.`,
    );
  }
  if (status === 401 || status === 403) {
    return new FetchError(
      'E5_AUTH_FAILED',
      `Authentication failed (${status}) for ${owner}/${repo}.`,
      `This repository is private or the token lacks access. Set GITHUB_TOKEN, run \`gh auth login\`, or ${buildHint}.`,
    );
  }
  return new FetchError(
    'E1_NETWORK',
    `${operation === 'release' ? 'GitHub API' : 'Download'} returned ${status}: ${statusText || 'unknown status'}`,
    `An unexpected HTTP error occurred. ${buildHint}.`,
  );
}

function runGhApi(owner, repo, tag, commandRunner) {
  const result = commandRunner('gh', [
    'api',
    `repos/${owner}/${repo}/releases/tags/${tag}`,
    '--header',
    `Accept: ${GITHUB_API_ACCEPT}`,
  ]);
  if (commandFailure(result)) {
    return { kind: 'failure', result, status: parseHttpStatus(commandText(result)) };
  }
  try {
    return { kind: 'success', release: JSON.parse(result.stdout), result };
  } catch {
    return { kind: 'failure', result, status: undefined };
  }
}

function runCurlApi(owner, repo, tag, env, commandRunner, platform) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--header',
    `Accept: ${GITHUB_API_ACCEPT}`,
    '--write-out',
    '\n%{http_code}',
  ];
  const authorization = authHeaders(env).Authorization;
  if (authorization) args.push('--header', `Authorization: ${authorization}`);
  args.push(url);
  const result = commandRunner(platform === 'win32' ? 'curl.exe' : 'curl', args);
  const response = parseCurlResponse(result.stdout);
  if (commandFailure(result) && response.status === undefined) {
    return { kind: 'failure', result, status: undefined };
  }
  if (response.status && response.status >= 200 && response.status < 300) {
    try {
      return { kind: 'success', release: JSON.parse(response.body), result };
    } catch {
      return { kind: 'failure', result, status: response.status };
    }
  }
  return { kind: 'failure', result, status: response.status };
}

function nativeReleaseFallback(owner, repo, tag, { env, commandRunner, platform }) {
  const attempts = [];
  const gh = runGhApi(owner, repo, tag, commandRunner);
  attempts.push({ label: 'gh api', result: commandResultLabel(gh.result) });
  if (gh.kind === 'success')
    return { kind: 'success', release: gh.release, transport: 'gh api', attempts };
  if (gh.status === 404) return { kind: 'http', status: 404, attempts };

  const curl = runCurlApi(owner, repo, tag, env, commandRunner, platform);
  attempts.push({
    label: platform === 'win32' ? 'curl.exe' : 'curl',
    result: commandResultLabel(curl.result),
  });
  if (curl.kind === 'success')
    return { kind: 'success', release: curl.release, transport: 'curl', attempts };
  if (curl.status) return { kind: 'http', status: curl.status, attempts };
  return { kind: 'failure', attempts };
}

function runGhReleaseDownload(owner, repo, tag, assetName, destPath, commandRunner) {
  const result = commandRunner('gh', [
    'release',
    'download',
    tag,
    '--repo',
    `${owner}/${repo}`,
    '--pattern',
    assetName,
    '--output',
    destPath,
    '--clobber',
  ]);
  if (!commandFailure(result) && existsSync(destPath)) return { kind: 'success', result };
  return { kind: 'failure', result, status: parseHttpStatus(commandText(result)) };
}

async function runCurlAsset(owner, repo, assetId, destPath, env, commandRunner, platform) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`;
  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--header',
    'Accept: application/octet-stream',
    '--output',
    destPath,
    '--write-out',
    '%{http_code}',
  ];
  const authorization = authHeaders(env).Authorization;
  if (authorization) args.push('--header', `Authorization: ${authorization}`);
  args.push(url);
  const result = commandRunner(platform === 'win32' ? 'curl.exe' : 'curl', args);
  const statusText = String(result.stdout || '').trim();
  const status = /^\d{3}$/.test(statusText)
    ? Number(statusText)
    : parseHttpStatus(commandText(result));
  if (status && status >= 200 && status < 300 && existsSync(destPath))
    return { kind: 'success', result };
  await rm(destPath, { force: true });
  return { kind: 'failure', result, status };
}

async function nativeAssetFallback(
  asset,
  destPath,
  { owner, repo, tag, env, commandRunner, platform },
) {
  const attempts = [];
  const assetName = asset?.name;
  const assetId = asset?.id;
  if (owner && repo && tag && assetName && Number.isInteger(assetId)) {
    const gh = runGhReleaseDownload(owner, repo, tag, assetName, destPath, commandRunner);
    attempts.push({ label: 'gh release download', result: commandResultLabel(gh.result) });
    if (gh.kind === 'success')
      return { kind: 'success', transport: 'gh release download', attempts };

    const curl = await runCurlAsset(owner, repo, assetId, destPath, env, commandRunner, platform);
    attempts.push({
      label: platform === 'win32' ? 'curl.exe' : 'curl',
      result: commandResultLabel(curl.result),
    });
    if (curl.kind === 'success') return { kind: 'success', transport: 'curl', attempts };
    if (curl.status) return { kind: 'http', status: curl.status, attempts };
  } else {
    attempts.push({ label: 'OS-native fallback', result: 'missing release asset context' });
  }
  return { kind: 'failure', attempts };
}

function logFallback(log, operation, error, transport) {
  log(
    `[fetch-wasm] Node fetch failed during ${operation} (${transportKind(error)}); ` +
      `recovered through ${transport}.`,
  );
}

/**
 * Fetch the release object for a given tag.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag - e.g. "wasm-artifacts"
 * @param {{ pkgLabel: string, buildHint: string, env?: object, fetchImpl?: Function, commandRunner?: Function, platform?: string, log?: Function }} opts
 *        pkgLabel — human-readable name for error messages (e.g. "wgpu-wasm")
 *        buildHint — local build fallback command for error messages
 */
export async function getReleaseByTag(owner, repo, tag, opts) {
  const {
    pkgLabel,
    buildHint,
    env = process.env,
    fetchImpl = globalThis.fetch,
    commandRunner = runCommand,
    platform = process.platform,
    log = console.warn,
  } = opts;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  let resp;
  try {
    resp = await fetchImpl(url, { headers: authHeaders(env) });
  } catch (e) {
    const fallback = nativeReleaseFallback(owner, repo, tag, { env, commandRunner, platform });
    if (fallback.kind === 'success') {
      logFallback(log, 'release metadata', e, fallback.transport);
      return fallback.release;
    }
    if (fallback.kind === 'http') {
      throw responseError({
        status: fallback.status,
        owner,
        repo,
        tag,
        pkgLabel,
        buildHint,
        operation: 'release',
      });
    }
    throw networkError({
      operation: 'release metadata request',
      error: e,
      buildHint,
      attempts: fallback.attempts,
    });
  }
  if (resp.status === 404) {
    throw responseError({
      status: 404,
      owner,
      repo,
      tag,
      pkgLabel,
      buildHint,
      operation: 'release',
    });
  }
  if (resp.status === 401 || resp.status === 403) {
    throw responseError({
      status: resp.status,
      owner,
      repo,
      tag,
      pkgLabel,
      buildHint,
      operation: 'release',
    });
  }
  if (!resp.ok) {
    throw responseError({
      status: resp.status,
      statusText: resp.statusText,
      owner,
      repo,
      tag,
      pkgLabel,
      buildHint,
      operation: 'release',
    });
  }
  return resp.json();
}

/**
 * Resolve one exact content-keyed asset from a release.
 *
 * Asset selection belongs here with the release transport so package scripts
 * only own content-key computation and package-specific extraction.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag
 * @param {string} assetName
 * @param {{ pkgLabel: string, buildHint: string, missingAssetHint?: string, env?: object, fetchImpl?: Function, commandRunner?: Function, platform?: string, log?: Function }} opts
 */
export async function getReleaseAsset(owner, repo, tag, assetName, opts) {
  const { pkgLabel, buildHint, missingAssetHint, ...releaseOpts } = opts;
  const release = await getReleaseByTag(owner, repo, tag, {
    pkgLabel,
    buildHint,
    ...releaseOpts,
  });
  const asset = (release.assets || []).find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new FetchError(
      'E4_HASH_MISMATCH',
      `No release asset matching "${assetName}" found on ${owner}/${repo} (tag: ${tag}).`,
      `${missingAssetHint || `No pre-built ${pkgLabel} asset exists for this content.`} ${buildHint}, or push to main to trigger a CI release.`,
    );
  }
  return asset;
}

/**
 * Download a release asset via the API asset endpoint (asset.url) with
 * Accept: application/octet-stream — works for public and private repos.
 *
 * Uses the API asset endpoint (asset.url) NOT asset.browser_download_url:
 * the browser URL 404s for PRIVATE repos even with a Bearer token (it expects
 * a browser session), while the API endpoint authorizes via the token for both
 * public and private repos.
 *
 * @param {{ id: number, name: string, url: string }} asset
 * @param {{ owner?: string, repo?: string, tag?: string, pkgLabel?: string, buildHint?: string, env?: object, fetchImpl?: Function, commandRunner?: Function, platform?: string, log?: Function }} opts
 */
export async function downloadAsset(asset, destPath, opts = {}) {
  const {
    owner,
    repo,
    tag,
    pkgLabel = 'WASM',
    buildHint = 'build the WASM locally',
    env = process.env,
    fetchImpl = globalThis.fetch,
    commandRunner = runCommand,
    platform = process.platform,
    log = console.warn,
  } = opts;
  let resp;
  try {
    resp = await fetchImpl(asset.url, {
      headers: { ...authHeaders(env), Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
  } catch (e) {
    await mkdir(dirname(destPath), { recursive: true });
    const fallback = await nativeAssetFallback(asset, destPath, {
      owner,
      repo,
      tag,
      env,
      commandRunner,
      platform,
    });
    if (fallback.kind === 'success') {
      logFallback(log, 'asset download', e, fallback.transport);
      return;
    }
    if (fallback.kind === 'http') {
      throw responseError({
        status: fallback.status,
        owner,
        repo,
        tag,
        pkgLabel,
        buildHint,
        operation: 'asset',
      });
    }
    throw networkError({
      operation: 'asset download',
      error: e,
      buildHint,
      attempts: fallback.attempts,
    });
  }
  if (!resp.ok) {
    throw responseError({
      status: resp.status,
      statusText: resp.statusText,
      owner,
      repo,
      tag,
      pkgLabel,
      buildHint,
      operation: 'asset',
    });
  }
  if (!resp.body) {
    throw new FetchError(
      'E1_NETWORK',
      `Download returned HTTP ${resp.status} without a response body.`,
      `The release asset was reachable but empty. ${buildHint}.`,
    );
  }
  await mkdir(dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  const reader = resp.body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      await new Promise((resolve, reject) => {
        fileStream.write(chunk.value, (err) => (err ? reject(err) : resolve()));
      });
      chunk = await reader.read();
    }
  } finally {
    await new Promise((resolve) => fileStream.end(resolve));
  }
}

/**
 * Extract a .tar.gz tarball into destDir (replace, not merge — idempotency #6).
 * Cleans destDir before extracting so a re-fetch never leaves stale members.
 */
export async function extractTarball(tarballPath, destDir) {
  const archive = resolvePath(tarballPath);
  const destination = resolvePath(destDir).replaceAll(sep, '/');
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', `./${basename(archive)}`, '-C', destination], {
      cwd: dirname(archive),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new FetchError(
              'E6_EXTRACT_FAILED',
              `tar exited with code ${code} while extracting ${tarballPath}.`,
              `Extraction failed.`,
            ),
          ),
    );
  });
}
