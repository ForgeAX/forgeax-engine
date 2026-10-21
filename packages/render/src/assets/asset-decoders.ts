import { createMaterialLoader } from '@forgeax/engine-assets-runtime/internal';
import {
  type AddressMode,
  type AssetDecoderContribution,
  AssetError,
  type AssetKind,
  type AssetLoadError,
  type CompareFunction,
  err,
  type FilterMode,
  isMaterialStaticSwitches,
  isMaterialTextureParameterType,
  MATERIAL_CHILD_FORBIDDEN_FIELDS,
  type MaterialAsset,
  type MaterialChildAsset,
  type MaterialRootAsset,
  type MaterialTextureCoordinates,
  ok,
  type RenderPipelineAsset,
  resolveMaterialTextureCoordinates,
  type SamplerAsset,
} from '@forgeax/engine-types';

import { resolveSsaoParameters } from '../ssao-config';

function invalid(guid: string, expected: string, reason: string) {
  return err({
    code: 'asset-package-invalid' as const,
    expected,
    hint: 'recook the render asset and publish its complete cooked payload',
    detail: { guid, reason },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validMaterial(value: unknown): value is MaterialAsset {
  if (!record(value) || value.kind !== 'material') return false;
  if (value.staticSwitches !== undefined && !isMaterialStaticSwitches(value.staticSwitches))
    return false;
  if (
    value.parent !== undefined &&
    typeof value.parent !== 'string' &&
    !(value.parent instanceof Uint8Array && value.parent.length === 16) &&
    !Number.isSafeInteger(value.parent)
  )
    return false;
  if (value.parent === undefined && (!Array.isArray(value.passes) || value.passes.length === 0))
    return false;
  if (value.passes !== undefined && !Array.isArray(value.passes)) return false;
  if (value.parameters !== undefined && !Array.isArray(value.parameters)) return false;
  if (
    value.parent !== undefined &&
    MATERIAL_CHILD_FORBIDDEN_FIELDS.some((field) => Object.hasOwn(value, field))
  ) {
    return false;
  }
  return value.values === undefined || record(value.values);
}

function resolveMaterialWireRef(
  value: unknown,
  refs: readonly string[],
  field: string,
  guid: string,
): ReturnType<typeof ok<string | number>> | ReturnType<typeof err<AssetLoadError>> {
  if (typeof value !== 'number') return ok(value as string | number);
  if (!Number.isSafeInteger(value) || value < 0 || refs[value] === undefined) {
    return err<AssetLoadError>({
      code: 'asset-package-invalid',
      expected: `${field} to reference a GUID through the material Pack refs[] table`,
      hint: 'recook the material so every texture or sampler ref has a matching refs[] entry',
      detail: { guid, reason: `${field} refs[${value}] is out of bounds` },
    });
  }
  return ok(refs[value] as string);
}

function isIdentityTextureCoordinates(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const coordinates = value as Record<string, unknown>;
  if (Object.keys(coordinates).some((key) => key !== 'set' && key !== 'transform')) return false;
  const transform = coordinates.transform;
  if (
    transform !== undefined &&
    (typeof transform !== 'object' || transform === null || Array.isArray(transform))
  ) {
    return false;
  }
  if (
    transform !== undefined &&
    Object.keys(transform as Record<string, unknown>).some(
      (key) => key !== 'offset' && key !== 'scale' && key !== 'rotation',
    )
  ) {
    return false;
  }
  const resolved = resolveMaterialTextureCoordinates(coordinates as MaterialTextureCoordinates);
  return (
    resolved.set === 0 &&
    resolved.transform.offset[0] === 0 &&
    resolved.transform.offset[1] === 0 &&
    resolved.transform.scale[0] === 1 &&
    resolved.transform.scale[1] === 1 &&
    resolved.transform.rotation === 0
  );
}

function compactTextureValue(value: Record<string, unknown>): unknown {
  const compact = { ...value };
  if (isIdentityTextureCoordinates(compact.coordinates)) delete compact.coordinates;
  return compact;
}

function resolveMaterialWireRefs(
  value: MaterialAsset,
  refs: readonly string[],
  guid: string,
): ReturnType<typeof ok<MaterialAsset>> | ReturnType<typeof err<AssetLoadError>> {
  if (refs.length === 0) return ok(value);

  let changed = false;
  const wire = value as unknown as { readonly parent?: unknown };
  let parent = wire.parent;
  if (typeof parent === 'number') {
    const resolved = resolveMaterialWireRef(parent, refs, 'parent', guid);
    if (!resolved.ok) return resolved;
    parent = resolved.value;
    changed = true;
  }

  if (value.values === undefined) {
    if (!changed) return ok(value);
    if (parent !== undefined) {
      const child = value as MaterialChildAsset;
      return ok({ ...child, parent: parent as unknown as MaterialChildAsset['parent'] });
    }
    return ok(value);
  }

  const textureFields = new Set(
    value.parameters === undefined
      ? []
      : value.parameters
          .filter((parameter) => isMaterialTextureParameterType(parameter.type))
          .map((parameter) => parameter.name),
  );
  const values = { ...value.values };
  for (const [field, raw] of Object.entries(values)) {
    if (typeof raw === 'number' && textureFields.has(field)) {
      const resolved = resolveMaterialWireRef(raw, refs, field, guid);
      if (!resolved.ok) return resolved;
      values[field] = { texture: resolved.value } as NonNullable<MaterialAsset['values']>[string];
      changed = true;
      continue;
    }
    if (!record(raw)) continue;
    const rawRecord = raw as unknown as Record<string, unknown>;
    let rewritten: Record<string, unknown> | undefined;
    for (const key of ['texture', 'sampler'] as const) {
      if (!(key in rawRecord)) continue;
      const resolved = resolveMaterialWireRef(rawRecord[key], refs, `${field}.${key}`, guid);
      if (!resolved.ok) return resolved;
      if (resolved.value !== rawRecord[key]) {
        rewritten ??= { ...rawRecord };
        rewritten[key] = resolved.value;
        changed = true;
      }
    }
    if (rewritten !== undefined) {
      values[field] = compactTextureValue(rewritten) as NonNullable<
        MaterialAsset['values']
      >[string];
    }
  }
  if (!changed) return ok(value);
  if (parent !== undefined) {
    const child = value as MaterialChildAsset;
    return ok({
      ...child,
      parent: parent as unknown as MaterialChildAsset['parent'],
      values,
    });
  }
  return ok({ ...value, values } as MaterialRootAsset);
}

export const materialContribution: AssetDecoderContribution<MaterialAsset, 'material'> = {
  kind: { kind: 'material' } as AssetKind<MaterialAsset, 'material'>,
  consumer: 'Render MaterialScene',
  decoder: {
    async decode({ envelope, artifacts }) {
      let payload: unknown = envelope.payload;
      if (
        record(payload) &&
        record(payload.cooked) &&
        payload.cooked.schemaVersion === 'material-cook/4' &&
        Array.isArray(payload.cooked.programs)
      ) {
        const programs = [...payload.cooked.programs];
        const cooked = payload.cooked;
        // Hydrate unique bytes in bounded parallel work before the one complete Cook validation.
        const requests = new Map<
          string,
          { descriptor: (typeof envelope.artifacts)[string]; indices: number[] }
        >();
        for (const [index, program] of programs.entries()) {
          if (!record(program) || !record(program.artifact)) continue;
          const artifact = program.artifact;
          const path = artifact.path;
          const descriptor = typeof path === 'string' ? envelope.artifacts[path] : undefined;
          if (artifact.bytes !== undefined && descriptor === undefined) continue;
          if (
            typeof path !== 'string' ||
            descriptor === undefined ||
            (artifacts.locate !== undefined && artifacts.locate(descriptor) === undefined)
          )
            return invalid(
              envelope.guid,
              'a verified external artifact for each compact material program',
              'compact material program artifact descriptor or digest mismatch',
            );
          const request = requests.get(path);
          if (request === undefined) requests.set(path, { descriptor, indices: [index] });
          else request.indices.push(index);
        }
        const distinct = [...requests.values()];
        const results: Awaited<ReturnType<typeof artifacts.read>>[] = new Array(distinct.length);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(8, distinct.length) }, async () => {
            while (cursor < distinct.length) {
              const index = cursor++;
              const request = distinct[index];
              if (request !== undefined) results[index] = await artifacts.read(request.descriptor);
            }
          }),
        );
        // Keep declaration-order failure precedence even when later reads finish first.
        for (const [index, request] of distinct.entries()) {
          const loaded = results[index];
          if (loaded === undefined) throw new Error('material artifact read did not complete');
          if (!loaded.ok) return loaded;
          for (const programIndex of request.indices) {
            const program = programs[programIndex] as Record<string, unknown>;
            const inline = (program.artifact as Record<string, unknown>).bytes;
            if (
              inline !== undefined &&
              (!(Array.isArray(inline) || inline instanceof Uint8Array) ||
                inline.length !== loaded.value.length ||
                loaded.value.some((byte, offset) => byte !== inline[offset]))
            )
              return invalid(
                envelope.guid,
                'inline bytes matching the verified external program',
                'inline material program bytes differ from their external artifact',
              );
            programs[programIndex] = {
              ...program,
              artifact: { ...(program.artifact as object), bytes: loaded.value },
            };
          }
        }
        payload = { ...payload, cooked: { ...cooked, programs } };
      }
      if (!validMaterial(payload)) {
        return invalid(
          envelope.guid,
          'a material payload with cooked passes, parameters, and values',
          'material owner validation failed',
        );
      }
      if (record(payload) && payload.cooked !== undefined) {
        const cooked = payload.cooked;
        const programs = record(cooked) && Array.isArray(cooked.programs) ? cooked.programs : [];
        const ready = await createMaterialLoader({
          loadPublication: async () => ({
            guid: envelope.guid,
            record: cooked,
            artifacts: Object.fromEntries(
              programs.flatMap((program) =>
                record(program) &&
                record(program.artifact) &&
                typeof program.artifact.path === 'string'
                  ? [
                      [
                        program.artifact.path,
                        {
                          bytes: program.artifact.bytes as Uint8Array,
                          digest: program.artifact.digest as string,
                        },
                      ],
                    ]
                  : [],
              ),
            ),
          }),
        }).load({
          guid: envelope.guid,
          specializationKey:
            record(cooked) && typeof cooked.specializationKey === 'string'
              ? cooked.specializationKey
              : '',
        });
        if (ready.status === 'Error')
          return err({
            code: 'asset-decode-failed',
            expected: ready.error.expected,
            hint: ready.error.hint,
            detail: { guid: envelope.guid, kind: 'material', cause: ready.error },
          });
        payload = { ...payload, cooked: ready.record };
      }
      return resolveMaterialWireRefs(payload as MaterialAsset, envelope.refs, envelope.guid);
    },
  },
};

const filters = new Set<FilterMode>(['nearest', 'linear']);
const addressModes = new Set<AddressMode>(['clamp-to-edge', 'repeat', 'mirror-repeat']);
const compareFunctions = new Set<CompareFunction>([
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
]);

function samplerDescriptor(payload: Record<string, unknown>): SamplerAsset | undefined {
  const stringField = <T extends string>(
    key: string,
    allowed: ReadonlySet<T>,
  ): T | undefined | null => {
    const value = payload[key];
    if (value === undefined) return undefined;
    return typeof value === 'string' && allowed.has(value as T) ? (value as T) : null;
  };
  const magFilter = stringField('magFilter', filters);
  const minFilter = stringField('minFilter', filters);
  const mipmapFilter = stringField('mipmapFilter', filters);
  const addressModeU = stringField('addressModeU', addressModes);
  const addressModeV = stringField('addressModeV', addressModes);
  const addressModeW = stringField('addressModeW', addressModes);
  const compare = stringField('compare', compareFunctions);
  if (
    magFilter === null ||
    minFilter === null ||
    mipmapFilter === null ||
    addressModeU === null ||
    addressModeV === null ||
    addressModeW === null ||
    compare === null
  ) {
    return undefined;
  }
  const numericField = (key: string): number | undefined | null => {
    const value = payload[key];
    if (value === undefined) return undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const lodMinClamp = numericField('lodMinClamp');
  const lodMaxClamp = numericField('lodMaxClamp');
  const maxAnisotropy = numericField('maxAnisotropy');
  if (
    lodMinClamp === null ||
    lodMaxClamp === null ||
    maxAnisotropy === null ||
    (lodMinClamp ?? 0) < 0 ||
    (lodMaxClamp ?? 32) < (lodMinClamp ?? 0) ||
    !Number.isInteger(maxAnisotropy ?? 1) ||
    (maxAnisotropy ?? 1) < 1 ||
    (maxAnisotropy ?? 1) > 16 ||
    ((maxAnisotropy ?? 1) > 1 &&
      (magFilter !== 'linear' || minFilter !== 'linear' || mipmapFilter !== 'linear'))
  )
    return undefined;
  return {
    kind: 'sampler',
    ...(magFilter === undefined ? {} : { magFilter }),
    ...(minFilter === undefined ? {} : { minFilter }),
    ...(mipmapFilter === undefined ? {} : { mipmapFilter }),
    ...(addressModeU === undefined ? {} : { addressModeU }),
    ...(addressModeV === undefined ? {} : { addressModeV }),
    ...(addressModeW === undefined ? {} : { addressModeW }),
    ...(lodMinClamp === undefined ? {} : { lodMinClamp }),
    ...(lodMaxClamp === undefined ? {} : { lodMaxClamp }),
    ...(compare === undefined ? {} : { compare }),
    ...(maxAnisotropy === undefined ? {} : { maxAnisotropy }),
  };
}

export const samplerContribution: AssetDecoderContribution<SamplerAsset, 'sampler'> = {
  kind: { kind: 'sampler' } as AssetKind<SamplerAsset, 'sampler'>,
  consumer: 'Render DeviceScope',
  decoder: {
    prepare(input) {
      const value =
        record(input) && input.kind === 'sampler' ? samplerDescriptor(input) : undefined;
      return value === undefined
        ? err(
            new AssetError({
              code: 'asset-invalid-value',
              expected:
                'a valid sampler descriptor with ordered nonnegative LOD bounds and integer anisotropy in [1, 16]',
              hint: 'use linear mag, min and mip filters when enabling anisotropy',
            }),
          )
        : ok(value);
    },
    async decode({ envelope }) {
      const value =
        record(envelope.payload) && envelope.payload.kind === 'sampler'
          ? samplerDescriptor(envelope.payload)
          : undefined;
      return value === undefined
        ? invalid(envelope.guid, 'a valid sampler descriptor', 'sampler owner validation failed')
        : ok(value);
    },
  },
};

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value > 0;
}

function validRenderPipelineConfig(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  const passCount = value.passCount;
  if (passCount !== undefined && !positiveInteger(passCount)) return false;
  const clusterGrid = value.clusterGrid;
  if (clusterGrid !== undefined) {
    if (
      !record(clusterGrid) ||
      !['x', 'y', 'z'].every((axis) => {
        const size = clusterGrid[axis];
        return positiveInteger(size) && size <= 64;
      })
    ) {
      return false;
    }
  }
  const ssao = value.ssao;
  if (
    ssao !== undefined &&
    (!record(ssao) || typeof ssao.enabled !== 'boolean' || !resolveSsaoParameters(ssao).ok)
  )
    return false;
  const outputDither = value.outputDither;
  if (outputDither !== undefined && typeof outputDither !== 'boolean') return false;
  const gpuOcclusion = value.gpuOcclusion;
  if (gpuOcclusion !== undefined && typeof gpuOcclusion !== 'boolean') return false;
  const postEffects = value.postEffects;
  return (
    postEffects === undefined ||
    (Array.isArray(postEffects) &&
      postEffects.every((effect) => typeof effect === 'string' && effect.length > 0))
  );
}

function renderPipelineDescriptor(value: Record<string, unknown>): RenderPipelineAsset | undefined {
  if (value.kind !== 'render-pipeline') return undefined;
  const pipelineId = value.pipelineId;
  if (pipelineId !== 'forgeax::standard') return undefined;
  const renderPath = value.renderPath;
  if (renderPath !== undefined && renderPath !== 'forward' && renderPath !== 'deferred') {
    return undefined;
  }
  const config = value.config;
  if (config !== undefined && !validRenderPipelineConfig(config)) return undefined;
  return {
    kind: 'render-pipeline',
    pipelineId,
    ...(renderPath === undefined ? {} : { renderPath }),
    ...(config === undefined
      ? {}
      : { config: config as NonNullable<RenderPipelineAsset['config']> }),
  };
}

export const renderPipelineContribution: AssetDecoderContribution<
  RenderPipelineAsset,
  'render-pipeline'
> = {
  kind: { kind: 'render-pipeline' } as AssetKind<RenderPipelineAsset, 'render-pipeline'>,
  consumer: 'Render Pipeline',
  decoder: {
    prepare(input) {
      const value = record(input) ? renderPipelineDescriptor(input) : undefined;
      return value === undefined
        ? err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'a complete render-pipeline descriptor with valid settings',
              hint: 'supply the Standard pipeline id, a supported render path and finite in-range configuration',
            }),
          )
        : ok(value);
    },
    async decode({ envelope, artifacts }) {
      let payload: unknown = envelope.payload;
      const descriptor = envelope.artifacts.body ?? Object.values(envelope.artifacts)[0];
      if (descriptor !== undefined) {
        const bytes = await artifacts.read(descriptor);
        if (!bytes.ok) return bytes;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes.value));
        } catch {
          return invalid(
            envelope.guid,
            'a render-pipeline JSON descriptor artifact',
            'invalid JSON',
          );
        }
      }
      const value = record(payload) ? renderPipelineDescriptor(payload) : undefined;
      return value === undefined
        ? invalid(
            envelope.guid,
            'a complete render-pipeline descriptor',
            'render-pipeline owner validation failed',
          )
        : ok(value);
    },
  },
};
