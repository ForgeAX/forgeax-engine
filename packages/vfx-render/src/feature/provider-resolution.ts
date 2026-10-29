import type { RenderFeaturePlanContext } from '@forgeax/engine-render';
import type { Result, TextureAsset } from '@forgeax/engine-types';
import {
  type VfxDataInterfaceResource,
  type VfxDataInterfaceToken,
  type VfxForceFieldError,
  type VfxGpuTickIntent,
  vfxForceFieldFailure,
} from '@forgeax/engine-vfx';
import type { VfxDataInterfaceRegistry } from '../host/data-interface-providers.js';
import type { createVfxForceFieldPreparation, PreparedVfxForceFields } from './force-fields.js';

export function resolveFields(
  emitter: VfxGpuTickIntent['emitter'],
  input: VfxGpuTickIntent['forceFields'],
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
  prepare: ReturnType<typeof createVfxForceFieldPreparation>,
): Result<PreparedVfxForceFields, VfxForceFieldError> | undefined {
  if (emitter.forceFields === undefined) return undefined;
  if (input === undefined)
    return vfxForceFieldFailure('vfx-field-asset-missing', 'forceFields', 'tick inputs');
  if (!input.ok) return input;
  const textures: {
    handle: number;
    revision: number;
    value: TextureAsset;
    delta?: import('@forgeax/engine-assets-runtime/internal').AssetVersionDelta;
  }[] = [];
  for (const reference of input.value) {
    const asset = context.resolveAsset?.(sourceWorldIndex, reference.handle, reference.revision);
    if (!asset?.ok || asset.value.kind !== 'texture')
      return vfxForceFieldFailure(
        'vfx-field-asset-missing',
        'forceFields.texture',
        'a retained exact Texture version',
      );
    textures.push({ ...reference, value: asset.value });
  }
  return prepare(emitter.forceFields, textures);
}

export function resolveDataInterfaces(
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'instanceGeneration'>,
  registry: Pick<VfxDataInterfaceRegistry, 'resolve'> | undefined,
): ReadonlyMap<VfxDataInterfaceToken, VfxDataInterfaceResource> | undefined {
  const requirements = intent.emitter.reflection.dataInterfaces ?? [];
  const resources = new Map<VfxDataInterfaceToken, VfxDataInterfaceResource>();
  for (const requirement of requirements) {
    const resolved = registry?.resolve([requirement], intent.instanceGeneration);
    if (resolved === undefined) continue;
    if (!resolved.ok) {
      const error = resolved.error;
      // Missing providers or resident payloads use Renderer-owned producers.
      // Explicit unavailability and invalid provider contracts remain barriers.
      if (
        error?.code === 'vfx-data-interface-missing' &&
        (error.detail.providerId === undefined || error.detail.expectedResourceKind !== undefined)
      )
        continue;
      return undefined;
    }
    const resource = resolved.value.resources.find((entry) => entry.token === requirement.token);
    if (resource?.resource !== undefined) resources.set(requirement.token, resource);
  }
  return resources;
}
