/** Prove captured initialization; only unused output staging tails may remain unwritten. */
export function rasterInitialization(model) {
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  return model.unseededResources.map(({ resourceId, kind }) => {
    const descriptor = model.resources.find((r) => r.resourceId === resourceId)?.descriptor?.desc;
    const aliases = new Set([
      resourceId,
      ...model.resources
        .filter((r) => r.descriptor?.sourceHandleId === resourceId)
        .map((r) => r.resourceId),
    ]);
    const firstConsumer = model.works.find((w) =>
      w.bindings.some((b) => aliases.has(b.resourceId)),
    );
    const before = firstConsumer?.eventIndex ?? Infinity;
    if (kind === 'texture') {
      require((descriptor?.size?.depthOrArrayLayers ?? 1) === 1 &&
        (descriptor?.mipLevelCount ?? 1) ===
          1, `Raster initialization proof requires a single subresource: ${resourceId}`);
      const first = model.commands.find(
        (c) =>
          c.kind === 'beginRenderPass' &&
          (aliases.has(c.params.depthStencilViewHandleId) ||
            c.params.colorAttachmentViewHandleIds.some((id) => aliases.has(id))),
      );
      require(first &&
        first.eventIndex <
          before, `Texture consumed before captured initialization: ${resourceId}`);
      const p = first.params;
      const depth = aliases.has(p.depthStencilViewHandleId);
      const attachment = depth
        ? p.desc.depthStencilAttachment
        : p.desc.colorAttachments[
            p.colorAttachmentViewHandleIds.findIndex((id) => aliases.has(id))
          ];
      require(depth
        ? attachment.depthLoadOp === 'clear' && attachment.stencilLoadOp === 'clear'
        : attachment.loadOp === 'clear', `First attachment use does not clear ${resourceId}`);
      return {
        resourceId,
        operation: 'attachment-clear',
        eventIndex: first.eventIndex,
        firstConsumerWork: firstConsumer?.workIndex ?? null,
      };
    }
    const writes = model.commands.filter(
      (c) =>
        c.eventIndex < before &&
        (((c.kind === 'writeBuffer' || c.kind === 'clearBuffer') &&
          c.params.handleId === resourceId) ||
          (c.kind === 'copyBufferToBuffer' && c.params.destinationHandleId === resourceId) ||
          (c.kind === 'copyTextureToBuffer' && c.params.destination.bufferHandleId === resourceId)),
    );
    const ranges = writes
      .map((c) => {
        const p = c.params;
        if (c.kind === 'copyTextureToBuffer')
          return [
            p.destination.offset ?? 0,
            (p.destination.offset ?? 0) + p.destination.bytesPerRow * p.copySize.height,
          ];
        const start =
          c.kind === 'writeBuffer'
            ? p.bufferOffset
            : c.kind === 'clearBuffer'
              ? (p.offset ?? 0)
              : p.destinationOffset;
        return [start, start + (p.size ?? descriptor.size - start)];
      })
      .sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [start, stop] of ranges) {
      require(start <= end, `Uninitialized buffer gap: ${resourceId}`);
      end = Math.max(end, stop);
    }
    // MAP_READ | COPY_DST cannot feed legal GPU work. Timing readback copies
    // only resolved timestamps, leaving an allocation tail that no shader reads.
    const outputStaging =
      descriptor.usage === 9 &&
      !firstConsumer &&
      !model.commands.some(
        (c) =>
          c.params.sourceHandleId === resourceId ||
          c.params.source?.bufferHandleId === resourceId ||
          c.params.bufferHandleId === resourceId,
      );
    require(outputStaging ||
      end >=
        descriptor.size, `Buffer not fully initialized: ${resourceId} (${end}/${descriptor.size})`);
    return {
      resourceId,
      operation: 'buffer-write-clear-or-copy',
      eventIndices: writes.map((c) => c.eventIndex),
      initializedBytes: end,
      allocationBytes: descriptor.size,
      uninitializedTailBytes: Math.max(0, descriptor.size - end),
      firstConsumerWork: firstConsumer?.workIndex ?? null,
    };
  });
}
