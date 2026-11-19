/** Prove complete recorded initialization before the buffer's first GPU read. */
export function recordedBufferInitialization(tape, resource, size, works) {
  const firstRead = Math.min(...resource.consumers
    .filter(entry => entry.access === 'read' && entry.workIndex !== null)
    .map(entry => entry.eventIndex), ...works.filter(work => work.bindings.some(
      binding => binding.resourceId === resource.resourceId && binding.access === 'read',
    )).map(work => work.eventIndex));
  const writes = tape.events.flatMap((event, eventIndex) =>
    event.kind === 'writeBuffer' && event.handleId === resource.resourceId && eventIndex < firstRead
      ? [{ eventIndex, offset: event.bufferOffset, size: event.size }]
      : []);
  let end = 0;
  for (const write of [...writes].sort((a, b) => a.offset - b.offset)) {
    if (write.offset > end || write.offset < 0 || write.offset + write.size > size)
      throw new Error('recorded buffer initialization has a hole or exceeds its allocation');
    end = Math.max(end, write.offset + write.size);
  }
  if (end !== size) throw new Error('recorded buffer is not fully initialized before its first GPU read');
  return { kind: 'recorded-buffer-upload', size, firstRead: Number.isFinite(firstRead) ? firstRead : null, writes };
}
