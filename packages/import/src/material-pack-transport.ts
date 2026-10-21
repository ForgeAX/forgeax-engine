import { createMaterialArtifactDigest, encodeMaterialProgramWire } from '@forgeax/engine-pack';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Native bodies and published descriptors prove the same external byte fact. */
function matchesExternalBytes(inline: unknown, externalValue: unknown): boolean {
  const external = object(externalValue);
  if (external?.mediaType !== 'text/wgsl') return false;
  const body = external.bytes;
  if (body instanceof Uint8Array) {
    if (inline === body) return true;
    if (!(inline instanceof Uint8Array) && !Array.isArray(inline)) return false;
    if (inline.length !== body.length) return false;
    for (let index = 0; index < body.length; index++)
      if (inline[index] !== body[index]) return false;
    return true;
  }
  const integrity = object(external.integrity);
  if (
    integrity?.algorithm !== 'sha256' ||
    typeof integrity.digest !== 'string' ||
    !Number.isInteger(external.byteLength) ||
    (!(inline instanceof Uint8Array) && !Array.isArray(inline)) ||
    inline.length !== external.byteLength
  )
    return false;
  if (
    Array.isArray(inline) &&
    !inline.every(
      (byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255,
    )
  )
    return false;
  return (
    createMaterialArtifactDigest(
      inline instanceof Uint8Array ? inline : Uint8Array.from(inline),
    ) === integrity.digest
  );
}

/** Compact only a verified copy; retain mismatches for full material validation. */
export function projectMaterialPayloadTransport(
  payloadValue: unknown,
  artifactsValue: unknown,
): unknown {
  const payload = object(payloadValue);
  if (payload === undefined) return payloadValue;
  const field =
    payload.schemaVersion === 'material-cook/4'
      ? undefined
      : payload.cooked !== undefined
        ? 'cooked'
        : 'record';
  const cooked = object(field === undefined ? payload : payload[field]);
  if (cooked?.schemaVersion !== 'material-cook/4' || !Array.isArray(cooked.programs))
    return payloadValue;
  const artifacts = object(artifactsValue);
  let changed = false;
  const programs = cooked.programs.map((rawProgram: unknown) => {
    const program = object(rawProgram);
    const artifact = object(program?.artifact);
    if (
      program === undefined ||
      artifact?.mediaType !== 'text/wgsl' ||
      typeof artifact.path !== 'string' ||
      !matchesExternalBytes(artifact.bytes, artifacts?.[artifact.path])
    )
      return rawProgram;
    changed = true;
    const { bytes: _bytes, ...externalArtifact } = artifact;
    return { ...program, artifact: externalArtifact };
  });
  if (!changed) return payloadValue;
  const projected = { ...cooked, programs };
  return field === undefined ? projected : { ...payload, [field]: projected };
}

/** Omit only shader bytes whose verified external transport is already published. */
export function projectMaterialPackTransport(pack: unknown): unknown {
  if (pack === null || typeof pack !== 'object') return pack;
  const document = pack as Record<string, unknown>;
  if (!Array.isArray(document.assets)) return pack;
  return encodeMaterialProgramWire({
    ...document,
    assets: document.assets.map((raw: unknown) => {
      if (raw === null || typeof raw !== 'object') return raw;
      const asset = raw as Record<string, unknown>;
      if (asset.kind !== 'material') return raw;
      const payload = projectMaterialPayloadTransport(asset.payload, asset.artifacts);
      return payload === asset.payload ? raw : { ...asset, payload };
    }),
  });
}
