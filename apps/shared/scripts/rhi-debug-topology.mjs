// Several passes may resolve into the same view (for example opaque and
// transparent passes). Count target identities, not resolve operations.
export function countResolveTargets(report) {
  return new Set(report.events.flatMap((event) =>
    event.kind === 'beginRenderPass'
      ? (event.colorAttachmentResolveTargetHandleIds ?? []).filter((id) => id != null)
      : [],
  )).size;
}
