/**
 * Select the displayed attachment from recorded resource provenance, not pass order.
 * Node verification and fresh browser replay share this one selection rule.
 */
export function selectCaptureWorkIndex(model, mode, workIndex) {
  if (typeof workIndex === 'number') return workIndex;
  if (mode === 'structural') {
    return model.works.find((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0)
      ?.workIndex;
  }
  const swapchainTextures = new Set(
    model.resources
      .filter(
        (resource) =>
          resource.descriptor?.kind === 'createTexture' &&
          resource.descriptor.origin === 'swapchain',
      )
      .map((resource) => resource.resourceId),
  );
  const swapchainViews = new Set(
    model.resources
      .filter(
        (resource) =>
          resource.descriptor?.kind === 'createTextureView' &&
          swapchainTextures.has(resource.descriptor.sourceHandleId),
      )
      .map((resource) => resource.resourceId),
  );
  return (
    model.works.findLast((work) =>
      work.attachments?.colorViewHandleIds.some((id) => swapchainViews.has(id)),
    )?.workIndex ?? model.works.at(-1)?.workIndex
  );
}
