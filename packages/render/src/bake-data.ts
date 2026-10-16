import type { SceneEntityRef } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Identity of one baked lighting record: a persistent scene entity plus the LOD
 * level it covers. `'shared'` marks the LOD0 lightmap sampled by every level
 * (lightmap UV storage `shared`); a number marks a level baked on its own.
 * Runtime-spawned entities have no persistent address and are never baked.
 */
export interface BakeDataKey extends SceneEntityRef {
  readonly lod: number | 'shared';
}

/**
 * Everything a baked record depends on, re-derived from the live scene when the
 * record is read. The baker writes `bakeFingerprint(input)` next to its output;
 * a later field joins this record without changing the existing ones.
 */
export interface BakeFingerprintInput {
  /** Mesh content hash, including the lightmap UV set. */
  readonly meshContentHash: string;
  /** Column-major 4x4 world transform of the entity. */
  readonly worldTransform: ArrayLike<number>;
  /** Hash of the material parameters that affect diffuse and emissive response. */
  readonly materialHash: string;
  /** One parameter hash per light contributing baked lighting; order-insensitive. */
  readonly lightHashes: readonly string[];
  readonly settingsHash: string;
  /** Engine bake algorithm version. */
  readonly algorithmVersion: number;
}

export interface BakeDataRecord {
  readonly key: BakeDataKey;
  /** `bakeFingerprint` of the inputs at bake time. */
  readonly fingerprint: string;
}

/** One diagnostic per scene: these records are ignored and lit in realtime. */
export interface BakeDataStaleDiagnostic {
  readonly code: 'bake-data-stale';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sceneSourceKey: string;
    readonly stale: readonly BakeDataKey[];
  };
}

export interface BakeDataResolution {
  /** Records whose fingerprint matches the live scene; only these may be sampled. */
  readonly baked: readonly BakeDataRecord[];
  readonly diagnostics: readonly BakeDataStaleDiagnostic[];
}

const FINGERPRINT_SCHEMA = 'forgeax-bake-fingerprint/1';

/** SHA-256 over a canonical encoding of the bake inputs, as lowercase hex. */
export function bakeFingerprint(input: BakeFingerprintInput): string {
  const canonical = JSON.stringify({
    schema: FINGERPRINT_SCHEMA,
    meshContentHash: input.meshContentHash,
    worldTransform: Array.from(input.worldTransform),
    materialHash: input.materialHash,
    lightHashes: [...input.lightHashes].sort(),
    settingsHash: input.settingsHash,
    algorithmVersion: input.algorithmVersion,
  });
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/**
 * Accept baked records whose fingerprint matches `current(key)`. A mismatch, or
 * a key whose inputs can no longer be derived, falls back to realtime lighting:
 * the record is left out of `baked` and reported once per scene. Stale data is
 * never sampled.
 */
export function resolveBakeData(
  records: readonly BakeDataRecord[],
  current: (key: BakeDataKey) => BakeFingerprintInput | undefined,
): BakeDataResolution {
  const baked: BakeDataRecord[] = [];
  const staleByScene = new Map<string, BakeDataKey[]>();
  for (const record of records) {
    const input = current(record.key);
    if (input !== undefined && bakeFingerprint(input) === record.fingerprint) {
      baked.push(record);
      continue;
    }
    const stale = staleByScene.get(record.key.sceneSourceKey) ?? [];
    stale.push(record.key);
    staleByScene.set(record.key.sceneSourceKey, stale);
  }
  const diagnostics = [...staleByScene].map(
    ([sceneSourceKey, stale]): BakeDataStaleDiagnostic => ({
      code: 'bake-data-stale',
      expected: 'baked lighting whose input fingerprint matches the live scene',
      hint: 'rebake the scene; affected entities use realtime lighting until then',
      detail: { sceneSourceKey, stale },
    }),
  );
  return { baked, diagnostics };
}
