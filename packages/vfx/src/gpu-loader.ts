import type {
  AssetRegistry as LegacyAssetRegistry,
  RuntimeAssetRegistry,
} from '@forgeax/engine-assets-runtime';
import type {
  AssetDecoderContribution,
  AssetKind,
  AssetLoadError,
  LoadContext,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { validateVfxForceFields } from './force-fields.js';
import {
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_PROGRAM_FORMAT,
  type VfxGpuEffectAssetAny,
  type VfxGpuEmitterProgramV3,
} from './gpu-program.js';

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

interface PackLoaderInput {
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

function validReflectionLayout(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || value.version !== 3) return false;
  if (!record(value.parameters) || !Array.isArray(value.parameters.fields)) return false;
  if (!record(value.custom) || !Array.isArray(value.custom.fields)) return false;
  if (value.version === 3) {
    if (!record(value.core) || value.core.name !== 'VfxParticle' || value.core.stride !== 112) {
      return false;
    }
    if (!record(value.customLayout) || value.customLayout.name !== 'VfxCustom') return false;
  }
  return typeof value.fingerprint === 'string' && value.fingerprint.startsWith('sha256:');
}

function stableLayouts(emitters: readonly VfxGpuEmitterProgramV3[]): boolean {
  const fingerprints = emitters
    .map((emitter) => emitter.reflection.layout?.fingerprint)
    .filter((fingerprint): fingerprint is string => fingerprint !== undefined);
  return fingerprints.every((fingerprint) => fingerprint === fingerprints[0]);
}

function validInstanceCompute(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    record(value) &&
    typeof value.format === 'string' &&
    value.format !== 'forgeax-vfx-instance-compute-1'
  )
    return true;
  if (
    !record(value) ||
    value.format !== 'forgeax-vfx-instance-compute-1' ||
    value.jobBytes !== 336 ||
    typeof value.wgsl !== 'string' ||
    value.wgsl.length === 0 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length !== 1
  )
    return false;
  const group = value.bindings[0];
  if (!record(group) || !Array.isArray(group.entries) || group.entries.length !== 9) return false;
  const slots = [0, 1, 2, 3, 4, 5, 6, 11, 12];
  return group.entries.every(
    (entry: unknown, index: number) =>
      record(entry) &&
      entry.binding === slots[index] &&
      entry.visibility === 4 &&
      record(entry.buffer) &&
      entry.buffer.type ===
        (slots[index] === 1 ? 'read-only-storage' : slots[index] === 12 ? 'uniform' : 'storage') &&
      entry.buffer.hasDynamicOffset !== true,
  );
}

function validEmitter(value: unknown): boolean {
  const reflection = record(value) && record(value.reflection) ? value.reflection : undefined;
  const layout = reflection !== undefined ? reflection.layout : undefined;
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.module === 'string' &&
    value.module.length > 0 &&
    Number.isInteger(value.capacity) &&
    (value.capacity as number) > 0 &&
    record(value.backend) &&
    value.backend.required === 'gpu' &&
    Object.keys(value.backend).length === 1 &&
    typeof value.wgsl === 'string' &&
    value.wgsl.length > 0 &&
    validInstanceCompute(value.instanceCompute) &&
    (value.forceFields === undefined || validateVfxForceFields(value.forceFields).ok) &&
    validForceFieldBinding(value.forceFields, reflection) &&
    record(value.reflection) &&
    validReflectionLayout(layout) &&
    Array.isArray(value.reflection.entryPoints) &&
    value.reflection.entryPoints.includes('forgeax_vfx_spawn_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_compact_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_billboard_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_mesh_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_ribbon_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_trail_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_beam_main') &&
    layout !== undefined &&
    record(layout) &&
    Array.isArray(reflection?.bindings) &&
    Array.isArray(reflection?.dataInterfaces) &&
    Array.isArray(reflection?.renderers) &&
    Array.isArray(reflection?.resources)
  );
}

function validForceFieldBinding(
  fields: unknown,
  reflection: Record<string, unknown> | undefined,
): boolean {
  if (!Array.isArray(reflection?.dataInterfaces)) return false;
  const requirements = reflection.dataInterfaces.filter(
    (entry: unknown) => record(entry) && entry.kind === 'force-fields',
  );
  if (fields === undefined) return requirements.length === 0;
  if (requirements.length !== 1) return false;
  const requirement = requirements[0];
  if (
    !record(requirement) ||
    requirement.token !== 'vfx:force-fields' ||
    requirement.binding !== 17 ||
    requirement.bindingType !== 'read-only-storage' ||
    requirement.lifetime !== 'generation'
  )
    return false;
  return (
    Array.isArray(reflection.bindings) &&
    reflection.bindings.some(
      (group: unknown) =>
        record(group) &&
        group.label === '@group(0)' &&
        Array.isArray(group.entries) &&
        group.entries.some(
          (entry: unknown) =>
            record(entry) &&
            entry.binding === 17 &&
            record(entry.buffer) &&
            entry.buffer.type === 'read-only-storage',
        ),
    )
  );
}

/** Admission belongs to the cooked-program loader, without a payload mirror. */
class LoadedVfxEffect {
  #immutable = true;
  declare readonly guid: VfxGpuEffectAssetAny['guid'];
  declare readonly kind: VfxGpuEffectAssetAny['kind'];
  declare readonly schemaVersion: VfxGpuEffectAssetAny['schemaVersion'];
  declare readonly programFingerprint: VfxGpuEffectAssetAny['programFingerprint'];
  declare readonly emitters: VfxGpuEffectAssetAny['emitters'];
  declare readonly program: VfxGpuEffectAssetAny['program'];

  constructor(payload: VfxGpuEffectAssetAny) {
    Object.assign(this, payload);
    // Keep the public POD shape; the private field is not serialized.
    Object.setPrototypeOf(this, Object.prototype);
    Object.freeze(this);
  }

  static owns(value: object): boolean {
    return #immutable in value;
  }
}

/** Only verified, recursively frozen loader-owned JSON can omit per-frame definitions. */
export function isImmutableVfxGpuEffect(value: VfxGpuEffectAssetAny): boolean {
  return value !== null && typeof value === 'object' && LoadedVfxEffect.owns(value);
}

function freezeProgramJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProgramJson(child);
    Object.freeze(value);
  }
  return value;
}

export const vfxGpuEffectPackLoader = {
  kind: 'particle-effect',
  async load(
    input: PackLoaderInput,
    _context: LoadContext,
  ): Promise<Result<VfxGpuEffectAssetAny, VfxGpuAssetError>> {
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
      typeof input.payload.programFingerprint !== 'string' ||
      !record(input.payload.program)
    ) {
      return failure(
        invalidCode,
        input.guid,
        'payload',
        'a schemaVersion 3 particle payload with its complete cooked program and fingerprint',
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
    if (
      !record(decoded) ||
      decoded.format !== expectedFormat ||
      !Array.isArray(decoded.emitters) ||
      !decoded.emitters.every((emitter) => validEmitter(emitter)) ||
      !stableLayouts(decoded.emitters as VfxGpuEmitterProgramV3[])
    ) {
      return failure(
        invalidCode,
        input.guid,
        VFX_GPU_PROGRAM_ARTIFACT_KEY,
        `a ${expectedFormat} managed GPU program`,
        'recook with the current VFX compiler ABI',
      );
    }
    const decodedEmitters = decoded.emitters as VfxGpuEmitterProgramV3[];
    if (
      input.payload.program.format !== expectedFormat ||
      input.payload.program.fingerprint !== input.payload.programFingerprint ||
      !Array.isArray(input.payload.program.emitters)
    ) {
      return failure(
        invalidCode,
        input.guid,
        'payload.program',
        'the complete canonical program matching payload.programFingerprint',
        'recook the particle effect atomically',
      );
    }
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
    return ok(
      new LoadedVfxEffect({
        guid: input.guid,
        kind: 'particle-effect' as const,
        schemaVersion: 3,
        programFingerprint: actualFingerprint,
        emitters: freezeProgramJson(emitters as { id: string; capacity: number }[]),
        program: Object.freeze({
          format: expectedFormat,
          fingerprint: actualFingerprint,
          emitters: freezeProgramJson(decodedEmitters),
        }),
      } as VfxGpuEffectAssetAny) as VfxGpuEffectAssetAny,
    );
  },
};

/** VFX owner decoder contribution for the core registry's typed map. */
export const vfxGpuEffectContribution: AssetDecoderContribution<
  VfxGpuEffectAssetAny,
  'particle-effect'
> = {
  kind: { kind: 'particle-effect' } as AssetKind<VfxGpuEffectAssetAny, 'particle-effect'>,
  consumer: 'VfxGpuRuntime',
  decoder: {
    async decode({ envelope, artifacts }) {
      const descriptor = envelope.artifacts[VFX_GPU_PROGRAM_ARTIFACT_KEY];
      const bytes = descriptor === undefined ? undefined : await artifacts.read(descriptor);
      if (bytes !== undefined && !bytes.ok) return bytes;
      const result = await vfxGpuEffectPackLoader.load(
        {
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
        },
        {} as LoadContext,
      );
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

export async function loadVfxGpuEffect(
  registry: LegacyAssetRegistry | RuntimeAssetRegistry,
  guid: string,
): Promise<Result<VfxGpuEffectAssetAny, unknown>> {
  if ('load' in registry) {
    return registry.load(guid, vfxGpuEffectContribution.kind);
  }
  let parsed: ReturnType<LegacyAssetRegistry['parseGuid']>;
  try {
    parsed = registry.parseGuid(guid);
  } catch (error) {
    return err(error);
  }
  return registry.loadByGuid<VfxGpuEffectAssetAny>(parsed);
}
