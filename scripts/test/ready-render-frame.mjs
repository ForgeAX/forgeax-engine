/** Submit one ready scene picture without advancing the caller's World. */
export async function drawReadyFrame(renderer, request, observation) {
  return completeReadyFrame(() => {
    if (observation !== undefined) {
      const armed = renderer.requestObservation?.(observation);
      if (armed === undefined) throw new Error('Renderer observation is unavailable');
      if (!armed.ok) throw armed.error;
    }
    const submitted = renderer.draw(request);
    if (!submitted.ok) throw submitted.error;
    return submitted.value;
  });
}

/** The submitter owns packet admission/recycling; retries must not update World. */
export async function completeReadyFrame(submit) {
  const deadline = Date.now() + 15_000;
  do {
    const receipt = await submit();
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    if (receipt.presentation === 'ready') return receipt;
    // GPU completion of a preparation barrier does not qualify a scene frame.
    // Let native compilation progress, then retry this exact input snapshot.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (Date.now() < deadline);
  throw new Error('Renderer scene presentation did not become ready');
}

/** Advance an App clock until each requested picture has a ready receipt. */
export async function driveReadyAppFrames(renderer, tick, count = 1) {
  let receipt;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') receipt = event.receipt;
  });
  try {
    for (let frame = 0; frame < count; frame++) {
      await completeReadyFrame(async () => {
        receipt = undefined;
        if ((await tick()) === false) throw new Error('App did not schedule the next frame');
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (receipt === undefined) throw new Error('App did not submit a frame');
        return receipt;
      });
    }
    return count;
  } finally {
    unsubscribe();
  }
}
