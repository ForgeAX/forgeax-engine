/** Submit one ready scene picture without advancing the caller's World. */
export async function drawReadyFrame(renderer, request, observation, options) {
  let consumePending;
  return completeReadyFrame(async () => {
    // The previous receipt has settled preparation and GPU work. Recycle its
    // observation before admitting another frame, after both completion signals.
    await consumePending?.();
    consumePending = undefined;
    if (observation !== undefined) {
      const armed = renderer.requestObservation?.(observation);
      if (armed === undefined) throw new Error('Renderer observation is unavailable');
      if (!armed.ok) throw armed.error;
    }
    const submitted = renderer.draw(request);
    if (!submitted.ok) throw submitted.error;
    const receipt = submitted.value;
    if (observation !== undefined && receipt.presentation !== 'ready') {
      const domains = receipt.observationDomains;
      if (domains === undefined) throw new Error('Armed receipt has no observation-domain facts');
      if (domains.length !== 0) {
        consumePending = async () => {
          const observed = await renderer.observe(receipt, { include: domains });
          if (!observed.ok) throw observed.error;
        };
      }
    }
    return receipt;
  }, options);
}

/** The submitter owns packet admission/recycling; retries must not update World. */
export async function completeReadyFrame(submit, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const preparationTimeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Ready-frame owner timeout must be a positive safe integer');
  const deadline = Date.now() + timeoutMs;
  let pendingReason;
  let presentation;
  let frameId;
  let preparedColdScene = false;
  let attempts = 0;
  const unavailable = (phase, stageTimeoutMs) =>
    new Error(
      `Renderer scene presentation did not become ready: ${JSON.stringify({ phase, presentation, frameId, pendingReason, attempts, timeoutMs, stageTimeoutMs })}`,
    );
  const bounded = async (operation, phase, limitMs = timeoutMs) => {
    const stageDeadline = Math.min(deadline, Date.now() + limitMs);
    const remaining = stageDeadline - Date.now();
    if (remaining <= 0) throw unavailable(phase, Math.max(0, remaining));
    let timeout;
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(unavailable(phase, remaining)), remaining);
        }),
      ]);
      if (Date.now() >= stageDeadline) throw unavailable(phase, Math.max(0, remaining));
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };
  // Archive initialization can complete native preparation before its first
  // receipt. Retain that actual startup signal in the same cold-scene budget;
  // absence of a signal still keeps the ordinary 15-second GPU fence bound.
  if (options.preparationCompleted !== undefined) {
    const prepared = await bounded(
      () => options.preparationCompleted,
      'preparation',
      preparationTimeoutMs,
    );
    if (!prepared.ok) throw prepared.error;
    preparedColdScene = true;
  }
  for (;;) {
    const receipt = await bounded(submit, 'submission', 15_000);
    attempts++;
    presentation = receipt.presentation;
    frameId = receipt.frameId;
    pendingReason = receipt.presentationPendingReason;
    // Native pipeline preparation can occupy the browser GPU process. Its
    // Engine-owned signal precedes the pending frame's GPU fence wait.
    if (receipt.presentation !== 'ready' && receipt.preparationCompleted !== undefined) {
      const prepared = await bounded(
        () =>
          Promise.race([
            receipt.preparationCompleted,
            receipt.completed.then((completed) => {
              if (!completed.ok) throw completed.error;
              return receipt.preparationCompleted;
            }),
          ]),
        'preparation',
        preparationTimeoutMs,
      );
      if (!prepared.ok) throw prepared.error;
      // Geometry promotion can expose draw-entity-missing as the first blocker
      // while the receipt also owns real pending native pipeline preparation.
      // Keep that signalled cold scene within the same total owner deadline.
      preparedColdScene ||=
        pendingReason?.code?.includes('pipeline-preparation') === true ||
        pendingReason?.code === 'draw-entity-missing';
    } else if (
      receipt.presentation !== 'ready' &&
      pendingReason?.code?.includes('pipeline-preparation')
    ) {
      throw new Error(
        `Renderer omitted its compilation completion signal: ${JSON.stringify(pendingReason)}`,
      );
    }
    // Native software drivers may finish their first-use pipeline work only
    // with this actual GPU completion. Keep it inside the existing owner budget.
    const gpuBudget = receipt.presentation === 'ready' && preparedColdScene ? timeoutMs : 15_000;
    const completed = await bounded(() => receipt.completed, 'gpu-completion', gpuBudget);
    if (!completed.ok) throw completed.error;
    if (options.onCompleted !== undefined)
      await bounded(() => options.onCompleted(receipt), 'completion-consumer', 15_000);
    if (receipt.presentation === 'ready') return receipt;
    // The real queue/preparation completion admits the next attempt. Every
    // stage shares the owner's deadline; a late signal cannot submit again.
  }
}

/** Advance an App clock until each requested picture has a ready receipt. */
export async function driveReadyAppFrames(renderer, tick, count = 1) {
  let submitted;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') submitted?.(event.receipt);
  });
  try {
    for (let frame = 0; frame < count; frame++) {
      await completeReadyFrame(async () => {
        const receipt = new Promise((resolve) => {
          submitted = resolve;
        });
        if ((await tick()) === false) throw new Error('App did not schedule the next frame');
        return receipt;
      });
    }
    return count;
  } finally {
    submitted = undefined;
    unsubscribe();
  }
}
