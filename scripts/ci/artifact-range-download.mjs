import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { discardHttpResponse } from '../lib/http-deadline.mjs';
import { artifactResponseStream, withinArtifactDeadline } from './artifact-response.mjs';

export const ARTIFACT_RANGE_MINIMUM_BYTES = 128 * 1024 * 1024;
const CONNECTIONS = 4;

export class ArtifactRangesUnavailable extends Error {}

function rangeIdentity(response, metadata, minimumBytes) {
  const bytes = metadata.size_in_bytes;
  const etag = response.headers.get('etag');
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < Math.max(minimumBytes, CONNECTIONS) ||
    Number(response.headers.get('content-length')) !== bytes ||
    response.headers.get('accept-ranges')?.toLowerCase() !== 'bytes' ||
    !/^"[^"\r\n]+"$/.test(etag ?? '') ||
    !response.url ||
    (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity')
  )
    return null;
  return { bytes, etag, url: response.url };
}

async function rangeResponse(fetchFn, identity, start, end, controller, timeoutMs) {
  // The redirect already authorized this immutable blob. Never forward the
  // GitHub API bearer token to its storage origin.
  const response = await withinArtifactDeadline(
    () =>
      fetchFn(identity.url, {
        headers: {
          Range: `bytes=${start}-${end}`,
          'If-Match': identity.etag,
          'Accept-Encoding': 'identity',
        },
        signal: controller.signal,
      }),
    controller,
    timeoutMs,
    'request',
  );
  if (response.status === 200)
    throw new ArtifactRangesUnavailable('artifact storage ignored byte ranges');
  if (response.status !== 206)
    throw new Error(`HTTP ${response.status} while reading artifact range`);
  if (
    response.headers.get('content-range') !== `bytes ${start}-${end}/${identity.bytes}` ||
    Number(response.headers.get('content-length')) !== end - start + 1 ||
    response.headers.get('etag') !== identity.etag ||
    (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity') ||
    !response.body
  )
    throw new Error('artifact range response identity mismatch');
  return response;
}

async function writeRange(response, destination, start, end, controller, idleTimeoutMs) {
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(
        bytes > end - start + 1 ? new Error('artifact range body exceeds declared length') : null,
        chunk,
      );
    },
  });
  await pipeline(
    artifactResponseStream(response.body, controller, idleTimeoutMs),
    bounded,
    createWriteStream(destination, { flags: 'r+', start }),
  );
  if (bytes !== end - start + 1) throw new Error('artifact range body is truncated');
  return bytes;
}

/** Null preserves the original response; unsupported advertised ranges need a fresh full GET. */
export async function tryDownloadArtifactRanges({
  response,
  controller,
  metadata,
  destination,
  requestTimeoutMs,
  idleTimeoutMs,
  fetchFn = fetch,
  minimumBytes = ARTIFACT_RANGE_MINIMUM_BYTES,
}) {
  const identity = rangeIdentity(response, metadata, minimumBytes);
  if (identity === null) return null;
  discardHttpResponse(response, controller);
  const file = await open(destination, 'w');
  try {
    await file.truncate(identity.bytes);
  } finally {
    await file.close();
  }
  const controllers = Array.from({ length: CONNECTIONS }, () => new AbortController());
  const size = Math.ceil(identity.bytes / CONNECTIONS);
  const transfers = controllers.map(async (rangeController, index) => {
    const start = index * size;
    const end = Math.min(identity.bytes, start + size) - 1;
    const range = await rangeResponse(
      fetchFn,
      identity,
      start,
      end,
      rangeController,
      requestTimeoutMs,
    );
    return writeRange(range, destination, start, end, rangeController, idleTimeoutMs);
  });
  let counts;
  try {
    counts = await Promise.all(transfers);
  } catch (error) {
    for (const current of controllers) current.abort();
    // Close every writer before the caller retries or truncates this file.
    await Promise.allSettled(transfers);
    throw error;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  if (`sha256:${hash.digest('hex')}` !== metadata.digest)
    throw new Error('artifact digest mismatch after range transfer');
  return counts.reduce((sum, bytes) => sum + bytes, 0);
}
