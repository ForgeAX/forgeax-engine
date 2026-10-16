// Explicit diagnostic preload: native calls and promises are returned unchanged.
// Observe the same host-owned inline-preview devices used by the original View probe.
(() => {
  if (!navigator.gpu) return;
  let count = 0;
  let devices = 0;
  const emit = (event) => {
    if (count++ >= 512) return;
    try {
      // biome-ignore lint/suspicious/noConsole: explicit native GPU diagnostic transport.
      console.info(
        '[inline-preview-gpu]',
        JSON.stringify({ epochMs: performance.timeOrigin + performance.now(), ...event }),
      );
    } catch {}
  };
  const observe = (promise, done, failed) => {
    promise.then(done, failed).catch(() => {});
  };
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = (...args) => {
    const result = requestAdapter(...args);
    observe(
      result,
      (adapter) => {
        if (!adapter) return;
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = (...args) => {
          const result = requestDevice(...args);
          observe(
            result,
            (device) => {
              const id = ++devices;
              emit({
                event: 'device',
                device: id,
                adapter: {
                  vendor: adapter.info?.vendor,
                  architecture: adapter.info?.architecture,
                  device: adapter.info?.device,
                  description: adapter.info?.description,
                },
              });
              for (const name of [
                'createRenderPipeline',
                'createRenderPipelineAsync',
                'createComputePipeline',
                'createComputePipelineAsync',
              ]) {
                const native = device[name].bind(device);
                device[name] = (...args) => {
                  const started = performance.now();
                  const label = args[0]?.label;
                  emit({ event: 'pipeline-start', device: id, name, label });
                  const result = native(...args);
                  const done = () =>
                    emit({
                      event: 'pipeline-done',
                      device: id,
                      name,
                      label,
                      elapsedMs: performance.now() - started,
                    });
                  if (result?.then)
                    observe(result, done, (error) =>
                      emit({
                        event: 'pipeline-error',
                        device: id,
                        name,
                        label,
                        error: String(error),
                      }),
                    );
                  else done();
                  return result;
                };
              }
              let submission = 0;
              const submit = device.queue.submit.bind(device.queue);
              device.queue.submit = (...args) => {
                const result = submit(...args);
                ++submission;
                if (submission <= 8) emit({ event: 'submit', device: id, submission });
                return result;
              };
              const completed = device.queue.onSubmittedWorkDone.bind(device.queue);
              device.queue.onSubmittedWorkDone = (...args) => {
                const selected = submission;
                const started = performance.now();
                const result = completed(...args);
                if (selected <= 8) emit({ event: 'fence-start', device: id, submission: selected });
                observe(
                  result,
                  () =>
                    selected <= 8 &&
                    emit({
                      event: 'fence-done',
                      device: id,
                      submission: selected,
                      elapsedMs: performance.now() - started,
                    }),
                  (error) =>
                    emit({
                      event: 'fence-error',
                      device: id,
                      submission: selected,
                      error: String(error),
                    }),
                );
                return result;
              };
              observe(device.lost, (info) =>
                emit({
                  event: 'device-lost',
                  device: id,
                  reason: info.reason,
                  message: info.message,
                }),
              );
            },
            (error) => emit({ event: 'device-error', error: String(error) }),
          );
          return result;
        };
      },
      (error) => emit({ event: 'adapter-error', error: String(error) }),
    );
    return result;
  };
})();
