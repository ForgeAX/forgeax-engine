// The native instance must outlive destruction and queued completion callbacks.
// Keep this ordering shared by Vitest and standalone Dawn smoke processes.
export async function teardownDawnInstance(devices, releaseGpu, reportError) {
  const owned = [...devices];
  const failures = [];
  const attempt = async (step, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
      reportError?.(step, error);
    }
  };
  // Destruction is synchronous; destroy every device before yielding to callbacks.
  for (const device of owned) {
    try {
      device.destroy?.();
    } catch (error) {
      failures.push(error);
      reportError?.('device.destroy', error);
    }
  }
  for (const device of owned)
    await attempt('onSubmittedWorkDone', () => device.queue?.onSubmittedWorkDone?.());
  owned.length = 0;
  await attempt('release GPU reference', releaseGpu);
  // Yield to the native pthread cleanup before Node tears down its environment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (failures.length && reportError === undefined)
    throw new AggregateError(failures, 'Dawn teardown failed');
}
