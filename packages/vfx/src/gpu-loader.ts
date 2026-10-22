import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type {
  AssetDecoderContribution,
  AssetKind,
  AssetLoadError,
  Result,
} from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import {
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_PROGRAM_FORMAT,
  type VfxGpuEffectAsset,
  type VfxGpuEmitterProgram,
} from './gpu-program.js';
import { prepareRuntimeParticleEffect } from './runtime-prepare.js';

export interface VfxGpuAssetError {
  readonly code:
    | 'vfx-asset-version-unsupported'
    | 'vfx-asset-v3-invalid'
    | 'vfx-asset-v3-program-missing'
    | 'vfx-asset-v3-fingerprint-mismatch';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly guid: string; readonly path: string };
}

interface VfxProgramInput {
  readonly guid: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly artifacts: Readonly<
    Record<
      string,
      {
        readonly descriptor: { readonly path: string; readonly mediaType: string };
        readonly bytes: Uint8Array;
      }
    >
  >;
}

function failure(
  code: VfxGpuAssetError['code'],
  guid: string,
  path: string,
  expected: string,
  hint: string,
): Result<never, VfxGpuAssetError> {
  return err({ code, expected, hint, detail: { guid, path } });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return `sha256:${hex(await globalThis.crypto.subtle.digest('SHA-256', source))}`;
}

function freezeProgramJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProgramJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate cooked bytes before code-created or source-loaded effects are adopted. */
export async function prepareVfxGpuEffect(
  input: VfxProgramInput,
): Promise<Result<VfxGpuEffectAsset, VfxGpuAssetError>> {
  const schemaVersion = input.payload.schemaVersion;
  if (schemaVersion !== 3) {
    return failure(
      'vfx-asset-version-unsupported',
      input.guid,
      'schemaVersion',
      'schemaVersion 3 / forgeax-vfx-program-4',
      'cold-cook the older source and publish a program format 4 payload; older versions are not executable',
    );
  }
  const invalidCode = 'vfx-asset-v3-invalid' as const;
  const missingCode = 'vfx-asset-v3-program-missing' as const;
  const fingerprintCode = 'vfx-asset-v3-fingerprint-mismatch' as const;
  const expectedFormat = VFX_GPU_PROGRAM_FORMAT;
  if (
    input.payload.kind !== 'particle-effect' ||
    !Array.isArray(input.payload.emitters) ||
    typeof input.payload.programFingerprint !== 'string'
  ) {
    return failure(
      invalidCode,
      input.guid,
      'payload',
      'a schemaVersion 3 particle payload with its emitters and program fingerprint',
      'cold-cook the source with the current VFX compiler and retry the load',
    );
  }
  const artifact = input.artifacts[VFX_GPU_PROGRAM_ARTIFACT_KEY];
  if (artifact === undefined) {
    return failure(
      missingCode,
      input.guid,
      VFX_GPU_PROGRAM_ARTIFACT_KEY,
      'the asset-local cooked VFX program',
      'recook the particle effect and retry the load',
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(artifact.bytes));
  } catch {
    return failure(
      invalidCode,
      input.guid,
      VFX_GPU_PROGRAM_ARTIFACT_KEY,
      'canonical JSON program bytes',
      'recook the particle effect and retry the load',
    );
  }
  if (!record(decoded) || decoded.format !== expectedFormat || !Array.isArray(decoded.emitters)) {
    return failure(
      invalidCode,
      input.guid,
      VFX_GPU_PROGRAM_ARTIFACT_KEY,
      `a ${expectedFormat} managed GPU program`,
      'recook with the current VFX compiler ABI',
    );
  }
  // The artifact is the only program copy; the payload carries its fingerprint.
  const decodedEmitters = decoded.emitters as VfxGpuEmitterProgram[];
  const actualFingerprint = await fingerprint(artifact.bytes);
  if (actualFingerprint !== input.payload.programFingerprint) {
    return failure(
      fingerprintCode,
      input.guid,
      'payload.programFingerprint',
      'payload and program artifact fingerprints to match',
      'cold-cook the particle asset so payload and artifact publish atomically',
    );
  }
  const emitters = input.payload.emitters.map((value) => {
    if (!record(value) || typeof value.id !== 'string' || !Number.isInteger(value.capacity)) {
      return undefined;
    }
    return { id: value.id, capacity: value.capacity as number };
  });
  if (
    emitters.some((value) => value === undefined) ||
    emitters.length !== decodedEmitters.length ||
    emitters.some(
      (value, index) =>
        value?.id !== decodedEmitters[index]?.id ||
        value?.capacity !== decodedEmitters[index]?.capacity,
    )
  ) {
    return failure(
      invalidCode,
      input.guid,
      'payload.emitters',
      'payload emitter identities and capacities to match the program',
      'recook the particle effect atomically',
    );
  }
  const prepared = prepareRuntimeParticleEffect({
    guid: input.guid,
    kind: 'particle-effect' as const,
    schemaVersion: 3,
    programFingerprint: actualFingerprint,
    emitters: freezeProgramJson(emitters as { id: string; capacity: number }[]),
    program: {
      format: expectedFormat,
      fingerprint: actualFingerprint,
      emitters: decodedEmitters,
    },
  });
  return prepared.ok
    ? prepared
    : failure(invalidCode, input.guid, 'program', prepared.error.expected, prepared.error.hint);
}

/** VFX owner decoder contribution for the core registry's typed map. */
export const particleEffectContribution: AssetDecoderContribution<
  VfxGpuEffectAsset,
  'particle-effect'
> = {
  kind: { kind: 'particle-effect' } as AssetKind<VfxGpuEffectAsset, 'particle-effect'>,
  consumer: 'VfxGpuRuntime',
  decoder: {
    prepare: prepareRuntimeParticleEffect,
    async decode({ envelope, artifacts }) {
      const descriptor = envelope.artifacts[VFX_GPU_PROGRAM_ARTIFACT_KEY];
      const bytes = descriptor === undefined ? undefined : await artifacts.read(descriptor);
      if (bytes !== undefined && !bytes.ok) return bytes;
      const result = await prepareVfxGpuEffect({
        guid: envelope.guid,
        kind: envelope.kind,
        payload: envelope.payload as unknown as Record<string, unknown>,
        artifacts:
          bytes === undefined || descriptor === undefined
            ? {}
            : {
                [VFX_GPU_PROGRAM_ARTIFACT_KEY]: {
                  descriptor: { path: descriptor.path, mediaType: descriptor.mediaType },
                  bytes: bytes.value,
                },
              },
      });
      if (result.ok) return result;
      const error: AssetLoadError = {
        code: 'asset-package-invalid',
        expected: result.error.expected,
        hint: result.error.hint,
        detail: { guid: envelope.guid, reason: result.error.code },
      };
      return err(error);
    },
  },
};

export function loadVfxGpuEffect(registry: AssetRegistry, guid: string) {
  return registry.load(guid, particleEffectContribution.kind);
}
