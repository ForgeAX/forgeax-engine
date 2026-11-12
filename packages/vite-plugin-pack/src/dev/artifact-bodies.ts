import { createHash } from 'node:crypto';
import type { HttpArtifact } from '../http-artifact.js';

interface BodyGroup {
  bytes: Uint8Array;
}

/** Share only immutable bodies admitted to this still-private publication. */
export function shareArtifactBodies(artifacts: Map<string, HttpArtifact>): void {
  const hashes = new WeakMap<Uint8Array, string>();
  const groups = new Map<string, BodyGroup[]>();
  const memberships = new WeakMap<HttpArtifact, BodyGroup>();
  for (const artifact of artifacts.values()) {
    if (memberships.has(artifact)) continue;
    const bytes = artifact.bytes;
    let hash = hashes.get(bytes);
    if (hash === undefined) {
      hash = createHash('sha256').update(bytes).digest('hex');
      hashes.set(bytes, hash);
    }
    const key = `${artifact.mimeType}:${bytes.byteLength}:${hash}`;
    const matches = groups.get(key);
    let group = matches?.find((candidate) => Buffer.compare(candidate.bytes, bytes) === 0);
    if (group === undefined) {
      group = { bytes };
      if (matches === undefined) groups.set(key, [group]);
      else matches.push(group);
    } else if (bytes.buffer.byteLength < group.bytes.buffer.byteLength) {
      // Prefer the smaller existing backing, including exact DDC readbacks,
      // rather than pinning a large V8 payload through a tiny equal subview.
      group.bytes = bytes;
    }
    memberships.set(artifact, group);
  }
  for (const [path, artifact] of artifacts) {
    const group = memberships.get(artifact);
    if (group !== undefined && group.bytes !== artifact.bytes)
      artifacts.set(path, { ...artifact, bytes: group.bytes });
  }
}
