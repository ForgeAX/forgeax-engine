// Producer resolution: the identity producer returns the case's own mesh; the json producer reads an
// L2/L3 output file. Both pass through parseMesh, so every producer is judged on the same input contract.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CaseMeshes } from './cases.ts';
import { type EvalMesh, type InputIssue, parseMesh } from './mesh.ts';

export type Producer =
  | { readonly kind: 'identity' }
  | { readonly kind: 'json'; readonly path: string };

export type ProducerResult =
  | {
      readonly ok: true;
      readonly mesh: EvalMesh;
      readonly id: 'identity' | 'json';
      readonly inputDigest?: string;
    }
  | { readonly ok: false; readonly error: ProducerError };

/** Closed set of producer failures; the runner maps every one to exit code 2. */
export type ProducerError =
  | { readonly code: 'bad-producer-spec'; readonly spec: string }
  | { readonly code: 'read-failed'; readonly path: string }
  | { readonly code: 'not-json'; readonly path: string }
  | { readonly code: 'invalid-mesh'; readonly issue: InputIssue };

export function parseProducerSpec(
  spec: string,
): { ok: true; producer: Producer } | { ok: false; error: ProducerError } {
  if (spec === 'identity') return { ok: true, producer: { kind: 'identity' } };
  if (spec.startsWith('json:') && spec.length > 5)
    return { ok: true, producer: { kind: 'json', path: spec.slice(5) } };
  return { ok: false, error: { code: 'bad-producer-spec', spec } };
}

export function resolveProducer(producer: Producer, caseMeshes: CaseMeshes): ProducerResult {
  if (producer.kind === 'identity') return { ok: true, mesh: caseMeshes.identity, id: 'identity' };
  let text: string;
  try {
    text = readFileSync(producer.path, 'utf8');
  } catch {
    return { ok: false, error: { code: 'read-failed', path: producer.path } };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'not-json', path: producer.path } };
  }
  const parsed = parseMesh(value);
  if (!parsed.ok) return { ok: false, error: { code: 'invalid-mesh', issue: parsed.issue } };
  const inputDigest = createHash('sha256').update(text).digest('hex');
  return { ok: true, mesh: parsed.mesh, id: 'json', inputDigest };
}
