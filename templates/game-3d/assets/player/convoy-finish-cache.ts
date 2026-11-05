import { createHash } from 'node:crypto';
import { deserialize, Serializer } from 'node:v8';
import type { NativeCookDraft } from '@forgeax/engine/pack/native-cooker';
import type { ByteCache, TextureAsset } from '@forgeax/engine/types';

type BakeFacts = Omit<NativeCookDraft<TextureAsset>, 'guid' | 'payload'>;
export interface ConvoyFinish {
  readonly textures: Record<string, TextureAsset>;
  readonly facts: Record<string, BakeFacts>;
}
const SCHEMA = 'convoy-finish/1';
const MAPS = ['normal', 'ormh', 'baseColor', 'emissive', 'coat'];

function fingerprint(value: ConvoyFinish): string {
  const hash = createHash('sha256').update(JSON.stringify(value.facts));
  for (const name of MAPS) {
    const { data, ...metadata } = value.textures[name]!;
    hash.update(JSON.stringify([name, metadata]));
    hash.update(data as Uint8Array);
  }
  return hash.digest('hex');
}

function valid(value: ConvoyFinish): boolean {
  if (!value || typeof value.textures !== 'object' || typeof value.facts !== 'object') return false;
  if (Object.keys(value.textures).length !== MAPS.length) return false;
  return MAPS.filter(name => name !== 'coat').every(name => value.facts[name] !== undefined)
    && MAPS.every(name => {
    const texture = value.textures[name];
    return texture?.kind === 'texture' && texture.data instanceof Uint8Array
      && texture.shape?.viewDimension === '2d' && texture.mips?.kind === 'packed';
  }) && Object.values(value.facts).every(fact => typeof fact.inputFingerprint === 'string'
    && Array.isArray(fact.refs) && typeof fact.artifacts === 'object');
}

function canonical(value: unknown, parents: readonly object[] = []): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Convoy cache inputs must be finite');
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (typeof value !== 'object' || parents.includes(value)) throw new TypeError('Convoy cache inputs must be plain acyclic data');
  const next = [...parents, value];
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, next)).join(',')}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Convoy cache inputs must be plain objects');
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `${prototype === null ? 'null:' : ''}{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, next)}`).join(',')}}`;
}

/** Source bytes, bake producer identity and finish version own this build-only entry. */
export function convoyFinishKey(input: unknown): string {
  return `${SCHEMA}:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}

export function readConvoyFinish(cache: ByteCache | undefined, key: string): ConvoyFinish | undefined {
  return decodeConvoyFinish(cache?.get(key), key);
}

function decodeConvoyFinish(bytes: Uint8Array | undefined, key: string): ConvoyFinish | undefined {
  if (bytes === undefined) return undefined;
  try {
    const record = deserialize(bytes) as { schema: string; key: string; digest: string; value: ConvoyFinish };
    if (record.schema !== SCHEMA || record.key !== key || !valid(record.value)) return undefined;
    return fingerprint(record.value) === record.digest ? record.value : undefined;
  } catch {
    return undefined;
  }
}

export function writeConvoyFinish(cache: ByteCache | undefined, key: string, value: ConvoyFinish): void {
  if (cache === undefined) return;
  // Base Serializer restores each typed array's own backing buffer. A texture
  // must not borrow the whole cached atlas set when the host clones one output.
  const serializer = new Serializer();
  serializer.writeHeader();
  serializer.writeValue({ schema: SCHEMA, key, digest: fingerprint(value), value });
  cache.put(key, serializer.releaseBuffer());
}
