/** Completion timing never opts a Renderer into GPU timestamp observation. */
export async function observeBenchmarkReceipt(renderer, receipt, gpuTiming = false) {
  if (!gpuTiming) {
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    return undefined;
  }
  const observed = await renderer.observe(receipt, { include: ['timings'] });
  if (!observed.ok) throw observed.error;
  if (observed.value.timings?.status !== 'complete')
    throw new Error('GPU diagnostic receipt lacks complete timestamp evidence');
  return observed.value.timings;
}
