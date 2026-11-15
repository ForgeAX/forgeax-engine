import {
  type GraphTexture,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { featureScopeKey } from './frame-plan';
import type { RenderFeaturePlanExecution } from './host';
import type { RenderFeatureGraphTargetResolver } from './render-graph-raster';
import { isRenderFeatureGraphTextureTarget, type RenderFeatureTargetHandle } from './targets';
import { isRenderFeatureTextureReference } from './texture-source';

export interface RenderFeatureGraphTextureTargets {
  readonly textures: Map<string, GraphTexture>;
  readonly views: Map<string, GraphTextureView>;
  readonly descriptors: Map<string, string>;
  readonly targets: Map<
    RenderFeatureTargetHandle,
    {
      readonly texture: GraphTexture;
      readonly view: GraphTextureView;
      readonly label: string;
      readonly scope: string;
    }
  >;
}

export function createRenderFeatureGraphTextureTargets(): RenderFeatureGraphTextureTargets {
  return { textures: new Map(), views: new Map(), descriptors: new Map(), targets: new Map() };
}

/** Imported targets retain the same allocation/view route as locally created targets. */
export function retainImportedGraphTextureTarget(
  state: RenderFeatureGraphTextureTargets,
  target: RenderFeatureTargetHandle,
  resolved: {
    readonly texture: GraphTexture;
    readonly view: GraphTextureView;
    readonly label: string;
    readonly scope: string;
  },
): void {
  const fingerprint = descriptorFingerprint(target);
  if (fingerprint === undefined) throw new Error('Shared graph target descriptor is invalid');
  const scope = target.allocationScope ?? resolved.scope;
  const allocationKey = JSON.stringify([scope, target.allocationKey]);
  const previousFingerprint = state.descriptors.get(allocationKey);
  if (previousFingerprint !== undefined && previousFingerprint !== fingerprint)
    throw allocationDescriptorConflict(target, previousFingerprint, fingerprint);
  const previousTexture = state.textures.get(allocationKey);
  if (previousTexture !== undefined && previousTexture !== resolved.texture)
    throw new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'one shared graph texture for each owner-scoped allocation key',
      hint: 'use distinct allocation keys for distinct shared resources',
      detail: {
        resourceLabel: target.name ?? 'feature-texture',
        field: 'allocationKey',
        expected: 'one physical resource',
        actual: 'multiple imports',
      },
    });
  state.textures.set(allocationKey, resolved.texture);
  state.views.set(targetKey(scope, target), resolved.view);
  state.descriptors.set(allocationKey, fingerprint);
  state.targets.set(target, resolved);
}

function allocationDescriptorConflict(
  target: RenderFeatureTargetHandle,
  expected: string,
  actual: string,
): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'one immutable graph texture descriptor for each owner-scoped allocation key',
    hint: 'use a distinct allocationKey when a feature needs another texture descriptor',
    detail: {
      resourceLabel: target.name ?? 'feature-texture',
      field: 'descriptor',
      expected,
      actual,
    },
  });
}

function targetKey(scope: string, target: RenderFeatureTargetHandle): string {
  const view = target.view ?? {};
  return JSON.stringify([
    target.allocationScope ?? scope,
    target.allocationKey,
    view.dimension ?? '',
    view.baseMipLevel ?? 0,
    view.mipLevelCount ?? '',
    view.baseArrayLayer ?? 0,
    view.arrayLayerCount ?? '',
    view.aspect ?? '',
    view.format ?? '',
  ]);
}

function collectTargets(
  executions: readonly RenderFeaturePlanExecution[],
): Array<{ scope: string; target: RenderFeatureTargetHandle }> {
  const result = new Map<RenderFeatureTargetHandle, string>();
  for (const execution of executions) {
    for (const target of execution.materialTextureTargets ?? [])
      if (isRenderFeatureGraphTextureTarget(target)) result.set(target, execution.scope ?? '');
    for (const pass of execution.passes) collectPassTargets(pass, execution.scope, result);
  }
  return [...result].map(([target, scope]) => ({ target, scope }));
}

function descriptorFingerprint(target: RenderFeatureTargetHandle): string | undefined {
  const descriptor = target.descriptor;
  if (descriptor === undefined) return undefined;
  const { size } = descriptor;
  const width = size.width;
  const height = size.height;
  const depthOrArrayLayers = size.depthOrArrayLayers ?? 1;
  if (
    descriptor.format !== target.format ||
    (descriptor.sampleCount ?? 1) !== target.sampleCount ||
    ![width, height, depthOrArrayLayers].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    return undefined;
  const view = target.view ?? {};
  if (
    view.format !== undefined &&
    view.format !== descriptor.format &&
    !(descriptor.viewFormats ?? []).includes(view.format)
  )
    return undefined;
  if (!validGraphTextureViewRange(target)) return undefined;
  return JSON.stringify({
    format: descriptor.format,
    lifetime: descriptor.lifetime ?? 'transient',
    width,
    height,
    depthOrArrayLayers,
    usage: descriptor.usage ?? 0,
    mipLevelCount: descriptor.mipLevelCount ?? 1,
    sampleCount: descriptor.sampleCount ?? 1,
    dimension: descriptor.dimension ?? '2d',
    viewFormats: [...(descriptor.viewFormats ?? [])].sort(),
    domain: descriptor.domain ?? '',
  });
}

export function prepareRenderFeatureGraphTextureTargets<Frame extends RenderGraphFrame>(
  builder: RenderGraphBuilder<Frame>,
  state: RenderFeatureGraphTextureTargets,
  executions: readonly RenderFeaturePlanExecution[],
): Result<void, RenderGraphError> {
  for (const { target, scope } of collectTargets(executions)) {
    const targetAllocationKey = target.allocationKey;
    if (targetAllocationKey === undefined)
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'a graph texture target with an allocation key',
          hint: 'declare a stable allocationKey for each graph texture target',
          detail: {
            resourceLabel: target.name ?? 'feature-texture',
            field: 'allocationKey',
            expected: 'string',
            actual: 'missing',
          },
        }),
      );
    if (invalidGraphAllocationScope(target))
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'a non-empty graph texture allocation scope override',
          hint: 'use a stable feature resource owner scope for an explicit override',
          detail: {
            resourceLabel: target.name ?? 'feature-texture',
            field: 'allocationScope',
            expected: 'string',
            actual: typeof target.allocationScope,
          },
        }),
      );
    const key = targetKey(scope, target);
    if (state.targets.has(target)) continue;
    const allocationScope = target.allocationScope ?? scope;
    const allocationKey = JSON.stringify([allocationScope, targetAllocationKey]);
    const fingerprint = descriptorFingerprint(target);
    if (fingerprint === undefined)
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected:
            'a graph texture target descriptor and view range consistent with its format and sample count',
          hint: 'declare a valid immutable texture descriptor and an in-bounds view',
          detail: {
            resourceLabel: target.name ?? 'feature-texture',
            field: 'descriptor',
            expected: 'valid',
            actual: 'inconsistent',
          },
        }),
      );
    const previousFingerprint = state.descriptors.get(allocationKey);
    if (previousFingerprint !== undefined && previousFingerprint !== fingerprint)
      return err(allocationDescriptorConflict(target, previousFingerprint, fingerprint));
    let texture = state.textures.get(allocationKey);
    const label = `feature-texture:${allocationKey}`;
    if (texture === undefined) {
      if (target.descriptor === undefined)
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'a graph texture target with an immutable texture descriptor',
            hint: 'declare the graph-texture resource descriptor in the feature plan',
            detail: {
              resourceLabel: target.name ?? 'feature-texture',
              field: 'descriptor',
              expected: 'present',
              actual: 'missing',
            },
          }),
        );
      const created = builder.createTexture(label, target.descriptor);
      if (!created.ok) return created;
      texture = created.value;
      state.textures.set(allocationKey, texture);
      state.descriptors.set(allocationKey, fingerprint);
    }
    let view = state.views.get(key);
    if (view === undefined) {
      const created = builder.view(texture, target.view ?? {});
      if (!created.ok) return created;
      view = created.value;
      state.views.set(key, view);
    }
    state.targets.set(target, { texture, view, label, scope });
  }
  return ok(undefined);
}

export function graphTextureTargetResolver(
  state: RenderFeatureGraphTextureTargets,
  fallback: RenderFeatureGraphTargetResolver,
): RenderFeatureGraphTargetResolver {
  return (target) => {
    if (isRenderFeatureTextureReference(target)) {
      const matches = [...state.targets].filter(
        ([handle, resolved]) =>
          handle.producerIdentity === target.featureIdentity &&
          handle.name === target.name &&
          handle.format === target.format &&
          resolved.scope === featureScopeKey({ view: target.viewIdentity }),
      );
      return matches.length === 1 ? matches[0]?.[1] : undefined;
    }
    if (typeof target === 'object' && isRenderFeatureGraphTextureTarget(target)) {
      const resolved = state.targets.get(target);
      if (resolved !== undefined) return resolved;
      const scope = target.allocationScope;
      if (scope === undefined) return undefined;
      const allocationKey = JSON.stringify([scope, target.allocationKey]);
      if (state.descriptors.get(allocationKey) !== descriptorFingerprint(target)) return undefined;
      const texture = state.textures.get(allocationKey);
      const view = state.views.get(targetKey(scope, target));
      return texture === undefined || view === undefined ? undefined : { texture, view };
    }
    return fallback(target);
  };
}

function validGraphTextureViewRange(target: RenderFeatureTargetHandle): boolean {
  const descriptor = target.descriptor;
  if (descriptor === undefined) return false;
  const view = target.view ?? {};
  const baseArrayLayer = view.baseArrayLayer ?? 0;
  const arrayLayerCount =
    view.arrayLayerCount ?? (descriptor.size.depthOrArrayLayers ?? 1) - baseArrayLayer;
  const baseMipLevel = view.baseMipLevel ?? 0;
  const mipLevelCount = view.mipLevelCount ?? (descriptor.mipLevelCount ?? 1) - baseMipLevel;
  if (
    invalidGraphTextureLayers(baseArrayLayer, arrayLayerCount, descriptor) ||
    invalidGraphTextureMips(baseMipLevel, mipLevelCount, descriptor)
  )
    return false;
  return true;
}

function collectPassTargets(
  pass: RenderFeaturePlanExecution['passes'][number],
  scope: string | undefined,
  result: Map<RenderFeatureTargetHandle, string>,
): void {
  for (const readback of pass.textureReadbacks ?? [])
    if (isRenderFeatureGraphTextureTarget(readback.target))
      result.set(readback.target, scope ?? '');
  collectGraphicsAttachmentTargets(pass, scope, result);
  for (const target of pass.resolvedGpuCompute?.sampledTargets ?? [])
    if (isRenderFeatureGraphTextureTarget(target)) result.set(target, scope ?? '');
  for (const target of pass.resolvedGpuCompute?.storageTargets ?? [])
    if (isRenderFeatureGraphTextureTarget(target)) result.set(target, scope ?? '');
  collectGraphicsBindingTargets(pass, scope, result);
}

function invalidGraphTextureLayers(
  baseArrayLayer: number,
  arrayLayerCount: number,
  descriptor: NonNullable<RenderFeatureTargetHandle['descriptor']>,
): boolean {
  return (
    !Number.isSafeInteger(baseArrayLayer) ||
    !Number.isSafeInteger(arrayLayerCount) ||
    baseArrayLayer < 0 ||
    arrayLayerCount < 1 ||
    baseArrayLayer + arrayLayerCount > (descriptor.size.depthOrArrayLayers ?? 1)
  );
}
function invalidGraphTextureMips(
  baseMipLevel: number,
  mipLevelCount: number,
  descriptor: NonNullable<RenderFeatureTargetHandle['descriptor']>,
): boolean {
  return (
    !Number.isSafeInteger(baseMipLevel) ||
    !Number.isSafeInteger(mipLevelCount) ||
    baseMipLevel < 0 ||
    mipLevelCount < 1 ||
    baseMipLevel + mipLevelCount > (descriptor.mipLevelCount ?? 1)
  );
}

function collectGraphicsBindingTargets(
  pass: RenderFeaturePlanExecution['passes'][number],
  scope: string | undefined,
  result: Map<RenderFeatureTargetHandle, string>,
): void {
  for (const draw of pass.graphics?.draws ?? [])
    for (const reference of draw.bindings) {
      const binding = pass.resolvedGraphics?.resolve(reference);
      if (binding?.kind !== 'bindings') continue;
      for (const target of Object.values(binding.descriptor?.values ?? {}))
        if (isRenderFeatureGraphTextureTarget(target)) result.set(target, scope ?? '');
    }
}

function invalidGraphAllocationScope(target: RenderFeatureTargetHandle): boolean {
  return (
    target.allocationScope !== undefined &&
    (typeof target.allocationScope !== 'string' || target.allocationScope.length === 0)
  );
}

function collectGraphicsAttachmentTargets(
  pass: RenderFeaturePlanExecution['passes'][number],
  scope: string | undefined,
  result: Map<RenderFeatureTargetHandle, string>,
): void {
  for (const attachment of pass.graphics?.attachments.colors ?? [])
    if (isRenderFeatureGraphTextureTarget(attachment.resource))
      result.set(attachment.resource, scope ?? '');
  const depth = pass.graphics?.attachments.depthStencil?.resource;
  if (isRenderFeatureGraphTextureTarget(depth)) result.set(depth, scope ?? '');
  for (const target of pass.graphics?.sampledTargets ?? [])
    if (isRenderFeatureGraphTextureTarget(target)) result.set(target, scope ?? '');
}
