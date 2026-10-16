import type { ViewerModel, ViewerResource, ViewerWork } from './viewer-model';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resolve either a texture or texture-view handle to the producer-owned texture resource. */
export function resolveTextureResource(
  model: ViewerModel,
  resourceId: string,
): ViewerResource | undefined {
  const resource = model.resources.find((candidate) => candidate.resourceId === resourceId);
  if (resource?.kind === 'texture') return resource;
  if (resource?.kind !== 'texture-view') return undefined;
  const sourceId = record(resource.descriptor)?.sourceHandleId;
  if (typeof sourceId !== 'string') return undefined;
  return model.resources.find(
    (candidate) => candidate.resourceId === sourceId && candidate.kind === 'texture',
  );
}

/**
 * The Draw Call Viewer derives its texture set from one work only: attachments first,
 * then texture bindings. It never falls back to the frame-global resource table.
 */
export function drawCallTextures(
  model: ViewerModel,
  work: ViewerWork | undefined,
): readonly ViewerResource[] {
  if (work === undefined) return [];
  const ids = [
    ...(work.attachments?.colorViewHandleIds ?? []),
    ...(work.attachments?.depthStencilViewHandleId
      ? [work.attachments.depthStencilViewHandleId]
      : []),
    ...work.bindings.flatMap((binding) =>
      binding.resourceId === null ? [] : [binding.resourceId],
    ),
  ];
  const seen = new Set<string>();
  const textures: ViewerResource[] = [];
  for (const id of ids) {
    const texture = resolveTextureResource(model, id);
    if (texture === undefined || seen.has(texture.resourceId)) continue;
    seen.add(texture.resourceId);
    textures.push(texture);
  }
  return textures;
}
