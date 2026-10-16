// Diagnostic preload only: forwards every native call and promise unchanged.
export function observeIblStartup() {
  if (!navigator.gpu || globalThis.__viewIblObserved) return;
  globalThis.__viewIblObserved = true;
  const emit = (event) => {
    try {
      // biome-ignore lint/suspicious/noConsole: explicit diagnostic transport from the actual Worker.
      console.info(
        '[view-ibl-startup]',
        JSON.stringify({
          epochMs: performance.timeOrigin + performance.now(),
          realm: typeof document === 'undefined' ? 'worker' : 'host',
          ...event,
        }),
      );
    } catch {
      /* Logging cannot reject a native operation's observation branch. */
    }
  };
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  emit({ event: 'observer-installed' });
  navigator.gpu.requestAdapter = (...args) => {
    const result = requestAdapter(...args);
    result
      .then((adapter) => {
        if (!adapter) return;
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = (...args) => {
          const result = requestDevice(...args);
          result
            .then((device) => {
              const commands = new WeakMap();
              const createEncoder = device.createCommandEncoder.bind(device);
              device.createCommandEncoder = (...args) => {
                const encoder = createEncoder(...args);
                const labels = [];
                const begin = encoder.beginRenderPass.bind(encoder);
                encoder.beginRenderPass = (descriptor) => {
                  if (descriptor.label?.startsWith('ibl-')) labels.push(descriptor.label);
                  return begin(descriptor);
                };
                const finish = encoder.finish.bind(encoder);
                encoder.finish = (...args) => {
                  const result = finish(...args);
                  if (labels.length) commands.set(result, labels);
                  return result;
                };
                return encoder;
              };
              for (const name of ['createRenderPipeline', 'createRenderPipelineAsync']) {
                const original = device[name].bind(device);
                device[name] = (...args) => {
                  const label = args[0]?.label;
                  if (!label?.startsWith('ibl-')) return original(...args);
                  const started = performance.now();
                  emit({ event: 'pipeline-start', name, label });
                  const result = original(...args);
                  const settled = () =>
                    emit({
                      event: 'pipeline-done',
                      name,
                      label,
                      elapsedMs: performance.now() - started,
                    });
                  if (result?.then)
                    result.then(settled, (error) =>
                      emit({ event: 'pipeline-error', label, error: String(error) }),
                    );
                  else settled();
                  return result;
                };
              }
              let submitted;
              const submit = device.queue.submit.bind(device.queue);
              device.queue.submit = (buffers) => {
                const list = Array.from(buffers);
                submitted = list.flatMap((buffer) => commands.get(buffer) ?? []);
                const result = submit(list);
                if (submitted.length) emit({ event: 'submit', labels: submitted });
                return result;
              };
              const done = device.queue.onSubmittedWorkDone.bind(device.queue);
              device.queue.onSubmittedWorkDone = () => {
                const labels = submitted;
                submitted = undefined;
                const started = performance.now();
                const result = done();
                if (labels?.length) {
                  emit({ event: 'fence-start', labels });
                  result.then(
                    () =>
                      emit({ event: 'fence-done', labels, elapsedMs: performance.now() - started }),
                    (error) => emit({ event: 'fence-error', labels, error: String(error) }),
                  );
                }
                return result;
              };
            })
            .catch((error) => emit({ event: 'observer-error', error: String(error) }));
          return result;
        };
      })
      .catch((error) => emit({ event: 'observer-error', error: String(error) }));
    return result;
  };
}
