import type { RenderFeaturePlanContext } from '@forgeax/engine-render';
import type { Result, TextureAsset } from '@forgeax/engine-types';
import {
  requiresExactVfxRecovery,
  type VfxDataInterfaceError,
  type VfxDataInterfaceKind,
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
    const asset = context.resolveAsset?.(reference.handle, reference.revision);
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
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'instanceGeneration'> &
    Partial<Pick<VfxGpuTickIntent, 'recovering' | 'recoveryContext'>>,
  registry: Pick<VfxDataInterfaceRegistry, 'resolve'> | undefined,
  portable?: readonly VfxDataInterfaceResource[],
): ReadonlyMap<VfxDataInterfaceToken, VfxDataInterfaceResource> | undefined {
  const requirements = intent.emitter.reflection.dataInterfaces ?? [];
  const resources = new Map<VfxDataInterfaceToken, VfxDataInterfaceResource>();
  for (const requirement of requirements) {
    if (intent.recovering && requirement.kind === 'gpu-events') continue;
    if (intent.recovering && requiresExactVfxRecovery(intent)) {
      if (requirement.kind === 'force-fields') continue;
      const resolveHistoricalResource = (): VfxDataInterfaceResource | undefined => {
        const context = intent.recoveryContext;
        const captured = context?.dataInterfaces.find(
          (row) => row.token === requirement.token && row.generation === intent.instanceGeneration,
        );
        if (!context || !captured?.resource) return undefined;
        if (captured.kind !== requirement.kind || captured.bindingType !== requirement.bindingType)
          return undefined;
        if (
          captured.resource.kind === 'uniform-data' ||
          captured.resource.kind === 'storage-data'
        ) {
          return captured;
        }
        const snapshot = captured.recovery;
        if (
          !snapshot ||
          snapshot.frameNumber !== context.frameNumber ||
          snapshot.version.length === 0
        )
          return undefined;
        return { ...captured, resource: snapshot.resource };
      };
      const historical = resolveHistoricalResource();
      if (!historical) return undefined;
      resources.set(requirement.token, historical);
      continue;
    }
    const projected = portable?.find(
      (row) => row.token === requirement.token && row.generation === intent.instanceGeneration,
    );
    if (projected) {
      if (
        projected.kind !== requirement.kind ||
        projected.bindingType !== requirement.bindingType ||
        !projected.resource
      )
        return undefined;
      resources.set(requirement.token, projected);
      continue;
    }
    const resolved = registry?.resolve([requirement], intent.instanceGeneration);
    if (resolved === undefined) continue;
    if (!resolved.ok) {
      const error = resolved.error;
      // Missing providers or resident payloads use Renderer-owned producers.
      // Explicit unavailability and invalid provider contracts remain barriers.
      if (rendererCanProduce(error, requirement.kind)) continue;
      return undefined;
    }
    const resource = resolved.value.resources.find((entry) => entry.token === requirement.token);
    if (resource?.resource !== undefined) resources.set(requirement.token, resource);
  }
  return resources;
}

/** Only interfaces with native default producers may defer to Render. */
function rendererCanProduce(
  error: VfxDataInterfaceError | undefined,
  kind: VfxDataInterfaceKind,
): boolean {
  if (kind === 'water-surface' || kind === 'structured-input') return false;
  return (
    error?.code === 'vfx-data-interface-missing' &&
    (error.detail.providerId === undefined || error.detail.expectedResourceKind !== undefined)
  );
}
