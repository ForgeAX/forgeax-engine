import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  isMaterialTextureParameterType,
  MATERIAL_TEXTURE_SLOTS,
  type MaterialAsset,
  type MaterialChildAsset,
  type MaterialRootAsset,
  ok,
  type RenderPipelineAsset,
  type SamplerAsset,
} from '@forgeax/engine-types';

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
  if (value.cooked !== undefined && !validateCookedMaterialRecord(value.cooked).ok) {
    return false;
  }
  if (value.passes !== undefined && !Array.isArray(value.passes)) return false;
  if (value.parameters !== undefined && !Array.isArray(value.parameters)) return false;
  if (
    value.parent !== undefined &&
    ['colorSpace', 'passes', 'parameters'].some((field) => Object.hasOwn(value, field))
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
      ? MATERIAL_TEXTURE_SLOTS
      : value.parameters
          .filter((parameter) => isMaterialTextureParameterType(parameter.type))
          .map((parameter) => parameter.name),
  );
  const values = { ...value.values };
  for (const [field, raw] of Object.entries(values)) {
    if (typeof raw === 'number' && textureFields.has(field)) {
      const resolved = resolveMaterialWireRef(raw, refs, field, guid);
      if (!resolved.ok) return resolved;
      values[field] = resolved.value as NonNullable<MaterialAsset['values']>[string];
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
      values[field] = rewritten as unknown as NonNullable<MaterialAsset['values']>[string];
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
        const verified = new Map<string, Uint8Array>();
        for (const [index, program] of programs.entries()) {
          if (!record(program) || !record(program.artifact) || program.artifact.bytes !== undefined)
            continue;
          const artifact = program.artifact;
          const path = artifact.path;
          const descriptor = typeof path === 'string' ? envelope.artifacts[path] : undefined;
          if (
            typeof path !== 'string' ||
            descriptor === undefined ||
            descriptor.integrity?.digest !== artifact.digest ||
            (artifacts.locate !== undefined && artifacts.locate(descriptor) === undefined)
          )
            return invalid(
              envelope.guid,
              'a verified external artifact for each compact material program',
              'compact material program artifact descriptor or digest mismatch',
            );
          let bytes = verified.get(path);
          if (bytes === undefined) {
            const loaded = await artifacts.read(descriptor);
            if (!loaded.ok) return loaded;
            bytes = loaded.value;
            verified.set(path, bytes);
          }
          programs[index] = { ...program, artifact: { ...artifact, bytes } };
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
      return resolveMaterialWireRefs(payload, envelope.refs, envelope.guid);
    },
  },
};

export const samplerContribution: AssetDecoderContribution<SamplerAsset, 'sampler'> = {
  kind: { kind: 'sampler' } as AssetKind<SamplerAsset, 'sampler'>,
  consumer: 'Render DeviceScope',
  decoder: {
    async decode({ envelope }) {
      return envelope.payload.kind === 'sampler'
        ? ok(envelope.payload)
        : invalid(envelope.guid, 'a sampler payload', 'sampler owner validation failed');
    },
  },
};

export const renderPipelineContribution: AssetDecoderContribution<
  RenderPipelineAsset,
  'render-pipeline'
> = {
  kind: { kind: 'render-pipeline' } as AssetKind<RenderPipelineAsset, 'render-pipeline'>,
  consumer: 'Render Pipeline',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      return payload.kind === 'render-pipeline' && payload.pipelineId.trim().length > 0
        ? ok(payload)
        : invalid(
            envelope.guid,
            'a render-pipeline payload with a pipelineId',
            'render-pipeline owner validation failed',
          );
    },
  },
};
