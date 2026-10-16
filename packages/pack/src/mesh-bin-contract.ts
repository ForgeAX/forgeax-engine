/** Canonical mesh binary wire facts shared by build-time and runtime owners. */

export const MESH_BIN_VERSION = 5 as const;
export const MESH_BIN_PROJECTION_VERSION = 1 as const;
export const MESH_BIN_HEADER_BYTES = 80;
export const MESH_BIN_DIGEST_BYTES = 32;

export interface MeshBinHeader {
  readonly version: 4 | 5;
  readonly projectionVersion: 1;
  readonly mask: number;
  readonly digest: string;
  readonly stride: number;
  readonly vertexCount: number;
  readonly vertexBytes: number;
  readonly indexCount: number;
  readonly indexWidth: 0 | 2 | 4;
  readonly indexBytes: number;
  readonly jsonBytes: number;
  readonly morphBytes: number;
}

export interface MeshBinContractError {
  readonly code:
    | 'mesh-bin-header-truncated'
    | 'mesh-bin-version-unsupported'
    | 'mesh-bin-header-invalid';
  readonly subject: 'mesh-bin';
  readonly sourceKey: string;
  readonly expected: string;
  readonly actual: string;
  readonly recovery: string;
}

export type MeshBinHeaderResult =
  | { readonly ok: true; readonly value: MeshBinHeader }
  | { readonly ok: false; readonly error: MeshBinContractError };

function failure(
  code: MeshBinContractError['code'],
  sourceKey: string,
  expected: string,
  actual: string,
): MeshBinHeaderResult {
  return {
    ok: false,
    error: {
      code,
      subject: 'mesh-bin',
      sourceKey,
      expected,
      actual,
      recovery: 're-cook the source with its Meta sidecar through the build-time importer',
    },
  };
}

function digestBytes(digest: string): Uint8Array {
  const bytes = new Uint8Array(MESH_BIN_DIGEST_BYTES);
  bytes.set(new TextEncoder().encode(digest).subarray(0, MESH_BIN_DIGEST_BYTES));
  return bytes;
}

function readDigest(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/u, '');
}

export function writeMeshBinHeader(header: MeshBinHeader, out: Uint8Array): void {
  if (out.byteLength < MESH_BIN_HEADER_BYTES) {
    throw new RangeError('mesh-bin header output is truncated');
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, header.version, true);
  view.setUint32(4, header.projectionVersion, true);
  view.setUint32(8, header.mask, true);
  view.setUint32(12, header.stride, true);
  view.setUint32(16, header.vertexCount, true);
  view.setUint32(20, header.vertexBytes, true);
  view.setUint32(24, header.indexCount, true);
  view.setUint32(28, header.indexWidth, true);
  view.setUint32(32, header.indexBytes, true);
  view.setUint32(36, header.jsonBytes, true);
  view.setUint32(40, header.version === 5 ? header.morphBytes : 0, true);
  view.setUint32(44, 0, true);
  out.set(digestBytes(header.digest), 48);
}

export function decodeMeshBinHeader(
  bytes: Uint8Array,
  sourceKey = '<unknown mesh source>',
): MeshBinHeaderResult {
  if (bytes.byteLength < MESH_BIN_HEADER_BYTES) {
    return failure(
      'mesh-bin-header-truncated',
      sourceKey,
      `mesh-bin v4/v5 header (${MESH_BIN_HEADER_BYTES} bytes)`,
      `${bytes.byteLength} bytes`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true);
  if (version !== 4 && version !== MESH_BIN_VERSION) {
    return failure(
      'mesh-bin-version-unsupported',
      sourceKey,
      'mesh-bin v4 or v5',
      `version ${version}`,
    );
  }
  const projectionVersion = view.getUint32(4, true);
  const mask = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  const vertexCount = view.getUint32(16, true);
  const vertexBytes = view.getUint32(20, true);
  const indexCount = view.getUint32(24, true);
  const indexWidth = view.getUint32(28, true);
  const indexBytes = view.getUint32(32, true);
  const jsonBytes = view.getUint32(36, true);
  const morphBytes = version === 5 ? view.getUint32(40, true) : 0;
  const digest = readDigest(bytes.subarray(48, 48 + MESH_BIN_DIGEST_BYTES));
  if (
    projectionVersion !== MESH_BIN_PROJECTION_VERSION ||
    mask === 0 ||
    morphBytes % 4 !== 0 ||
    (version === 5 && view.getUint32(44, true) !== 0) ||
    stride === 0 ||
    !Number.isSafeInteger(vertexCount) ||
    !Number.isSafeInteger(vertexBytes) ||
    !Number.isSafeInteger(indexCount) ||
    !Number.isSafeInteger(indexBytes) ||
    !Number.isSafeInteger(jsonBytes) ||
    (indexCount === 0 && indexWidth !== 0) ||
    (indexCount > 0 && indexWidth !== 2 && indexWidth !== 4) ||
    indexBytes !== indexCount * indexWidth ||
    vertexBytes !== vertexCount * stride ||
    digest.length === 0
  ) {
    return failure(
      'mesh-bin-header-invalid',
      sourceKey,
      'safe mesh projection, stride, cardinality, and payload byte lengths',
      `projection=${projectionVersion}; mask=${mask}; stride=${stride}; vertexBytes=${vertexBytes}; indexBytes=${indexBytes}; digest=${digest}`,
    );
  }
  return {
    ok: true,
    value: {
      version,
      projectionVersion: 1,
      mask,
      digest,
      stride,
      vertexCount,
      vertexBytes,
      indexCount,
      indexWidth: indexWidth as 0 | 2 | 4,
      indexBytes,
      jsonBytes,
      morphBytes,
    },
  };
}

/** Low bits declare channels; corresponding bits shifted by three elide all-positive-zero lanes. */
export const MESH_BIN_MORPH_CHANNELS = [
  { key: 'position', mask: 1, components: 3 },
  { key: 'normal', mask: 2, components: 3 },
  { key: 'tangent', mask: 4, components: 4 },
] as const;

/** Decode v5 morph lanes into private arrays; both mesh readers use this wire contract. */
export function decodeMeshBinMorphs(
  bytes: Uint8Array,
  vertexCount: number,
  masks: unknown,
): ReadonlyArray<Record<string, Float32Array>> | undefined {
  if (masks === undefined) {
    if (bytes.byteLength !== 0) throw new TypeError('morph bytes require target masks');
    return undefined;
  }
  if (!Array.isArray(masks) || masks.length < 1 || masks.length > 8)
    throw new TypeError('expected one to eight morph target masks');
  let expected = 0;
  for (const mask of masks) {
    if (
      !Number.isInteger(mask) ||
      mask < 1 ||
      mask > 63 ||
      !(mask & 7) ||
      ((mask >> 3) & ~(mask & 7)) !== 0
    )
      throw new TypeError('unknown or empty morph channel mask');
    for (const channel of MESH_BIN_MORPH_CHANNELS)
      if (mask & channel.mask && !(mask & (channel.mask << 3)))
        expected += vertexCount * channel.components * 4;
  }
  if (!Number.isSafeInteger(expected) || expected !== bytes.byteLength)
    throw new TypeError('morph lane byte length differs from target cardinality');
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  return masks.map((mask: number) => {
    const target: Record<string, Float32Array> = {};
    for (const channel of MESH_BIN_MORPH_CHANNELS) {
      if (!(mask & channel.mask)) continue;
      const values = new Float32Array(vertexCount * channel.components);
      if (mask & (channel.mask << 3)) {
        target[channel.key] = values;
        continue;
      }
      if (littleEndian)
        new Uint8Array(values.buffer).set(bytes.subarray(offset, offset + values.byteLength));
      for (let i = 0; i < values.length; i++) {
        if (!littleEndian) values[i] = view.getFloat32(offset + i * 4, true);
        if (!Number.isFinite(values[i])) throw new TypeError('non-finite morph lane');
      }
      offset += values.byteLength;
      target[channel.key] = values;
    }
    return target;
  });
}
