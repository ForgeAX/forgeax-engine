#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const RETRY_DELAYS_SECONDS = [0, 5, 15];
// Bound response-header stalls, not the duration of a progressing archive.
// Run 37126874789 spent three minutes waiting for a 3435-byte report, then
// succeeded on a fresh route in two seconds. Keep all three retries and the
// independent two-minute body-idle allowance for large transfers below.
export const ARTIFACT_REQUEST_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = ARTIFACT_REQUEST_TIMEOUT_MS;
export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
export const ARTIFACT_IDLE_TIMEOUT_MS = DOWNLOAD_IDLE_TIMEOUT_MS;

function errorText(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) {
    if (typeof current.message === 'string') messages.push(current.message);
    if (typeof current.code === 'string') messages.push(current.code);
  }
  return messages.join(' ');
}

export function isRetryableTransportError(error) {
  const text = errorText(error);
  return (
    /ECONNRESET|UND_ERR_SOCKET|terminated other side closed|Failed to GetSignedArtifactURL|socket hang up|artifact (?:request|download|transfer) (?:timeout|idle timeout)|HTTP (?:408|429|5\d\d) /i.test(
      text,
    ) ||
    (error instanceof TypeError && /fetch failed/i.test(text))
  );
}

export function parseArtifactIds(value) {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !/^[1-9]\d*$/.test(id)))
    throw new Error('artifact IDs must be a non-empty comma-separated list of positive integers');
  return ids;
}

export function artifactNamePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0)
    throw new Error('artifact pattern must be non-empty');
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value ?? '')))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sleep(seconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1000));
}

export async function retryArtifact(operation, { sleepFn = sleep, onRetry = () => {} } = {}) {
  for (const [attemptIndex, delay] of RETRY_DELAYS_SECONDS.entries()) {
    if (delay > 0) await sleepFn(delay);
    try {
      return { attempt: attemptIndex + 1, value: await operation(attemptIndex + 1) };
    } catch (error) {
      if (!isRetryableTransportError(error) || attemptIndex === RETRY_DELAYS_SECONDS.length - 1)
        throw error;
      await onRetry({ attempt: attemptIndex + 1, error });
    }
  }
  throw new Error('artifact retry exhausted');
}

export async function observeArtifactDownload(
  operation,
  { nowFn = Date.now, transferAttempt = null } = {},
) {
  const startedMillis = nowFn();
  const compressedArchiveBytes = await operation();
  const completedMillis = nowFn();
  if (
    !Number.isFinite(startedMillis) ||
    !Number.isFinite(completedMillis) ||
    completedMillis < startedMillis ||
    !Number.isFinite(compressedArchiveBytes) ||
    compressedArchiveBytes < 0 ||
    !Number.isInteger(transferAttempt) ||
    transferAttempt < 1 ||
    transferAttempt > RETRY_DELAYS_SECONDS.length
  )
    throw new Error('artifact download observation is invalid');
  return {
    compressedArchiveBytes,
    download: {
      startedAt: new Date(startedMillis).toISOString(),
      completedAt: new Date(completedMillis).toISOString(),
      elapsedSeconds: (completedMillis - startedMillis) / 1000,
      transferAttempt,
    },
  };
}

function headers() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function responseFor(url, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const result = await requestWithTimeout(url, requestTimeoutMs);
  const { response } = result;
  if (!response.ok) throw new Error(`HTTP ${response.status} while reading artifact service`);
  return result;
}

async function listRunArtifacts(repository, runId) {
  const artifacts = [];
  for (let page = 1; ; page += 1) {
    const { response, controller } = await responseFor(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
    );
    const payload = JSON.parse(
      (
        await readResponseBody(response, {
          controller,
          idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        })
      ).toString('utf8'),
    );
    if (!Array.isArray(payload.artifacts) || !Number.isInteger(payload.total_count))
      throw new Error(`artifact run ${runId} returned invalid listing metadata`);
    artifacts.push(...payload.artifacts);
    if (artifacts.length >= payload.total_count || payload.artifacts.length < 100) return artifacts;
  }
}

export function selectRunArtifacts(artifacts, pattern, expectedCount) {
  const matcher = artifactNamePattern(pattern);
  // Failed-job reruns can publish the same producer name again in one run.
  // IDs are opaque: a newer upload can have a smaller ID. Creation time owns order.
  const latestByName = new Map();
  for (const artifact of artifacts) {
    if (
      artifact === null ||
      typeof artifact !== 'object' ||
      artifact.expired === true ||
      !Number.isInteger(artifact.id) ||
      artifact.id <= 0 ||
      typeof artifact.name !== 'string' ||
      !matcher.test(artifact.name)
    )
      continue;
    const previous = latestByName.get(artifact.name);
    if (previous === undefined) {
      latestByName.set(artifact.name, artifact);
    } else if (previous.id !== artifact.id) {
      const previousTime = Date.parse(previous.created_at);
      const currentTime = Date.parse(artifact.created_at);
      if (
        !Number.isFinite(previousTime) ||
        !Number.isFinite(currentTime) ||
        previousTime === currentTime
      )
        throw new Error(`artifact ${artifact.name} has ambiguous creation time`);
      if (currentTime > previousTime) latestByName.set(artifact.name, artifact);
    }
  }
  const selected = [...latestByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (selected.length !== expectedCount)
    throw new Error(
      `artifact pattern ${pattern} matched ${selected.length}; expected exactly ${expectedCount}`,
    );
  if (new Set(selected.map((artifact) => artifact.id)).size !== selected.length)
    throw new Error(`artifact pattern ${pattern} returned duplicate IDs`);
  if (
    selected.some(
      (artifact) =>
        artifact.name === '.' ||
        artifact.name === '..' ||
        artifact.name.includes('/') ||
        artifact.name.includes('\\'),
    )
  )
    throw new Error(`artifact pattern ${pattern} returned an unsafe artifact name`);
  return selected;
}

export async function discoverRunArtifacts(repository, runId, pattern, expectedCount) {
  const listed = await retryArtifact(() => listRunArtifacts(repository, runId), {
    onRetry: ({ attempt, error }) => {
      process.stdout.write(
        `artifact run ${runId} discovery retry ${attempt}/${RETRY_DELAYS_SECONDS.length}: ${errorText(error)}\n`,
      );
    },
  });
  return selectRunArtifacts(listed.value, pattern, expectedCount);
}

function timeoutMessage(kind, timeoutMs) {
  return `artifact ${kind} timeout after ${timeoutMs}ms`;
}

async function raceWithTimeout(operation, timeoutMs, message, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const response = await raceWithTimeout(
    () => fetch(url, { headers: headers(), signal: controller.signal }),
    timeoutMs,
    timeoutMessage('request', timeoutMs),
    () => controller.abort(),
  );
  return { response, controller };
}

export async function readResponseBody(
  response,
  { controller = null, idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS } = {},
) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return Buffer.from(
      await raceWithTimeout(
        () => response.arrayBuffer(),
        idleTimeoutMs,
        timeoutMessage('download idle', idleTimeoutMs),
        () => controller?.abort(),
      ),
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await raceWithTimeout(
        () => reader.read(),
        idleTimeoutMs,
        timeoutMessage('download idle', idleTimeoutMs),
        () => controller?.abort(),
      );
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, totalBytes);
}

async function metadataFor(repository, artifactId, requestTimeoutMs, idleTimeoutMs) {
  const { response, controller } = await responseFor(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`,
    requestTimeoutMs,
  );
  const metadata = JSON.parse(
    (
      await readResponseBody(response, {
        controller,
        idleTimeoutMs,
      })
    ).toString('utf8'),
  );
  const expectedSha = process.env.FORGEAX_ARTIFACT_EXPECTED_SHA;
  if (expectedSha && metadata.workflow_run?.head_sha !== expectedSha)
    throw new Error(`artifact ${artifactId} product SHA mismatch`);
  if (metadata.expired) throw new Error(`artifact ${artifactId} has expired`);
  if (typeof metadata.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(metadata.digest))
    throw new Error(`artifact ${artifactId} has invalid digest metadata`);
  return metadata;
}

export async function downloadArtifact(
  repository,
  artifactId,
  destination,
  { idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const metadata = await metadataFor(repository, artifactId, requestTimeoutMs, idleTimeoutMs);

  let transferController;
  let transferTimedOut = false;
  let transferTimer;
  const armTransferTimer = () => {
    clearTimeout(transferTimer);
    transferTimer = setTimeout(() => {
      transferTimedOut = true;
      transferController?.abort();
    }, idleTimeoutMs);
  };
  try {
    const responseResult = await responseFor(
      `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
      requestTimeoutMs,
    );
    transferController = responseResult.controller;
    const response = responseResult.response;
    if (!response.body) throw new Error(`artifact ${artifactId} response has no body`);
    armTransferTimer();
    const hash = createHash('sha256');
    let bytes = 0;
    const hashingTransform = new Transform({
      transform(chunk, _encoding, callback) {
        armTransferTimer();
        const buffer = Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.byteLength;
        callback(null, buffer);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      hashingTransform,
      createWriteStream(destination),
    );
    const digest = `sha256:${hash.digest('hex')}`;
    if (digest !== metadata.digest) throw new Error(`artifact ${artifactId} digest mismatch`);
    return bytes;
  } catch (error) {
    if (transferTimedOut)
      throw new Error(`artifact transfer idle timeout after ${idleTimeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(transferTimer);
  }
}

export async function ensureArtifactDestination(path) {
  await mkdir(path, { recursive: true });
}

export function artifactDestination(path, artifactName, mergeMultiple = false) {
  return mergeMultiple ? path : join(path, artifactName);
}

async function hydrateArtifact(repository, artifactId, path) {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-artifact-'));
  const archive = join(root, `${artifactId}.zip`);
  try {
    await ensureArtifactDestination(path);
    const hydrated = await retryArtifact(
      async () => {
        const bytes = await downloadArtifact(repository, artifactId, archive);
        execFileSync('unzip', ['-q', '-o', archive, '-d', path], { stdio: 'inherit' });
        return bytes;
      },
      {
        onRetry: async ({ attempt, error }) => {
          await rm(archive, { force: true });
          process.stdout.write(
            `artifact ${artifactId} transport retry ${attempt}/${RETRY_DELAYS_SECONDS.length}: ${errorText(error)}\n`,
          );
        },
      },
    );
    process.stdout.write(
      `artifact ${artifactId} hydrated on attempt ${hydrated.attempt} (${hydrated.value} bytes)\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const artifactIds = argument('--artifact-ids');
  const runIdArgument = argument('--run-id');
  const pattern = argument('--artifact-pattern');
  const expectedCountArgument = argument('--expected-count');
  const path = resolve(argument('--path') ?? '.');
  const mergeMultiple = process.argv.includes('--merge-multiple');
  const staggerSeconds = Number(argument('--stagger-seconds') ?? '0');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const exactIdMode = artifactIds !== null;
  const runPatternMode =
    runIdArgument !== null || pattern !== null || expectedCountArgument !== null;
  if (exactIdMode === runPatternMode)
    throw new Error(
      'choose exactly one artifact source: --artifact-ids or --run-id with --artifact-pattern and --expected-count',
    );
  if (mergeMultiple && exactIdMode)
    throw new Error('--merge-multiple requires run artifact discovery');
  if (!Number.isInteger(staggerSeconds) || staggerSeconds < 0)
    throw new Error('stagger seconds must be a non-negative integer');
  if (staggerSeconds > 0) {
    process.stdout.write(`staggering core artifact transfer for ${staggerSeconds} seconds\n`);
    await sleep(staggerSeconds);
  }
  if (exactIdMode) {
    for (const artifactId of parseArtifactIds(artifactIds))
      await hydrateArtifact(repository, artifactId, path);
    return;
  }
  const runId = positiveInteger(runIdArgument, 'run ID');
  const expectedCount = positiveInteger(expectedCountArgument, 'expected count');
  const artifacts = await discoverRunArtifacts(repository, runId, pattern, expectedCount);
  for (const artifact of artifacts) {
    await hydrateArtifact(
      repository,
      String(artifact.id),
      artifactDestination(path, artifact.name, mergeMultiple),
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    fail(errorText(error));
  });
}
