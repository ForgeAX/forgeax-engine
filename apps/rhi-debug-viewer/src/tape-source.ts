import { decodeTape, type RhiDebugError, type V7Tape } from '@forgeax/engine-rhi-debug';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { ViewerArtifactRef } from './viewer-model';

export interface LoadedTape {
  readonly tape: V7Tape;
  readonly artifactRef: ViewerArtifactRef;
}

export type TapeLoadError = RhiDebugError;

export function loadTapeFromBytes(bytes: Uint8Array): Result<V7Tape, TapeLoadError> {
  return decodeTape(bytes);
}

export async function loadTapeFromFile(file: File): Promise<Result<LoadedTape, TapeLoadError>> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const tape = loadTapeFromBytes(bytes);
    if (!tape.ok) return tape;
    return ok({
      tape: tape.value,
      artifactRef: {
        kind: 'rhi-tape',
        digest: await digestBytes(bytes),
        source: 'viewer.import',
        path: file.name,
      },
    });
  } catch (cause) {
    return err({
      code: 'tape-invalid',
      expected: 'a readable v7 RHI debug tape',
      hint: 'obtain complete .rhitape bytes and retry',
      detail: { stage: 'decode', cause: String(cause) },
    });
  }
}

export async function loadTapeFromFiles(
  files: readonly File[],
): Promise<Result<LoadedTape, TapeLoadError>> {
  if (files.length !== 1 || !files[0]?.name.endsWith('.rhitape')) {
    return err({
      code: 'tape-invalid',
      expected: 'exactly one .rhitape file',
      hint: 'drop exactly one v7 .rhitape artifact',
      detail: { stage: 'validate', cause: 'viewer import cardinality or extension mismatch' },
    });
  }
  return loadTapeFromFile(files[0]);
}

export async function loadTapeFromUrl(url: string): Promise<Result<LoadedTape, TapeLoadError>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return err({
        code: 'tape-invalid',
        expected: 'a fetchable v7 RHI debug tape',
        hint: 'verify the tape URL and retry',
        detail: { stage: 'decode', cause: `HTTP ${response.status}` },
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const tape = loadTapeFromBytes(bytes);
    if (!tape.ok) return tape;
    return ok({
      tape: tape.value,
      artifactRef: {
        kind: 'rhi-tape',
        digest: await digestBytes(bytes),
        source: 'viewer.url',
        path: url,
      },
    });
  } catch (cause) {
    return err({
      code: 'tape-invalid',
      expected: 'a fetchable v7 RHI debug tape',
      hint: 'verify the tape URL and retry',
      detail: { stage: 'decode', cause: String(cause) },
    });
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  try {
    if (typeof globalThis.crypto?.subtle?.digest === 'function') {
      // Copy into a fresh ArrayBuffer-backed view so older and newer TypeScript
      // lib.dom definitions agree on the `BufferSource` input type.
      const digestInput = new Uint8Array(bytes.byteLength);
      digestInput.set(bytes);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
      return `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
  } catch {
    // Fall through to the deterministic local digest when Web Crypto is absent.
  }
  let hash = 2166136261;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}
