/** Runs in the page and observes only App-owned successful ready completions. */
export function waitForCompletedAppFrames({
  count,
  timeoutMs = 30_000,
  canvas = document.querySelector('#app'),
}) {
  if (!Number.isInteger(count) || count < 1) {
    return Promise.reject(new RangeError('completed frame count must be a positive integer'));
  }
  if (canvas === null) return Promise.reject(new Error('M7 App canvas is missing'));
  return new Promise((resolve, reject) => {
    let completed = 0;
    let generation;
    let world;
    let lastFrame = -1;
    const finish = (error) => {
      clearTimeout(timer);
      canvas.removeEventListener('forgeax:frame-completed', observe);
      if (error === undefined) resolve(completed);
      else reject(error);
    };
    const observe = (event) => {
      const frame = event.detail;
      const submitted = canvas.forgeaxFrameProgress?.submitted;
      if (frame?.presentation !== 'ready' || submitted === undefined) return;
      if (
        generation !== undefined &&
        (frame.deviceGeneration !== generation || frame.worldIdentity !== world)
      ) {
        finish(
          new Error('M7 device generation or World changed while waiting for completed frames'),
        );
        return;
      }
      if (
        frame.deviceGeneration !== submitted.deviceGeneration ||
        frame.worldIdentity !== submitted.worldIdentity ||
        !(
          frame.frameId === submitted.frameId ||
          (frame.frameId < submitted.frameId && submitted.receipt?.presentation === 'ready')
        )
      )
        return;
      if (generation === undefined) {
        generation = frame.deviceGeneration;
        world = frame.worldIdentity;
      }
      if (frame.frameId <= lastFrame) return;
      lastFrame = frame.frameId;
      completed += 1;
      if (completed === count) finish();
    };
    const timer = setTimeout(() => {
      finish(new Error(`M7 completed ${completed}/${count} ready frames within ${timeoutMs}ms`));
    }, timeoutMs);
    canvas.addEventListener('forgeax:frame-completed', observe);
  });
}
