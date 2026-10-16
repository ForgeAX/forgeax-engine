const referenceCanvas = document.querySelector('canvas');

export const benchmarkHost = {
  referenceCanvas,
  performance,
  requestAnimationFrame: (callback) => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  display: () => ({ width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio }),
  attachInput(ui, onError, canvas) {
    canvas.tabIndex = 0;
    const releases = [];
    const listen = (kind, listener) => {
      const handle = (event) => {
        try {
          listener(event);
        } catch (error) {
          onError(error);
        }
      };
      canvas.addEventListener(kind, handle, { passive: false });
      releases.push(() => canvas.removeEventListener(kind, handle));
    };
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    for (const [kind, phase] of [
      ['pointerdown', 'down'],
      ['pointermove', 'move'],
      ['pointerup', 'up'],
      ['pointercancel', 'cancel'],
    ])
      listen(kind, (event) => {
        event.preventDefault();
        if (phase === 'down') {
          canvas.focus({ preventScroll: true });
          canvas.setPointerCapture(event.pointerId);
        }
        ui.input.pointer({
          phase,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          ...point(event),
          pressure: event.pressure,
        });
      });
    listen('wheel', (event) => {
      event.preventDefault();
      ui.input.wheel({ ...point(event), deltaX: event.deltaX, deltaY: event.deltaY });
    });
    for (const type of ['keydown', 'keyup'])
      listen(type, (event) => {
        if (
          ui.input.key({
            type,
            key: event.key,
            code: event.code,
            repeat: event.repeat,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          })
        )
          event.preventDefault();
      });
    return () => {
      for (const release of releases.reverse()) release();
    };
  },
  facts: { kind: 'browser', clock: 'performance.now milliseconds' },
  resources: Promise.all(
    ['ui.wasm', 'font.bin'].map(
      async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
    ),
  ).then(([wasm, font]) => ({
    font,
    wasm: {
      readWasm: async () => wasm,
      instantiate: (imports) => WebAssembly.instantiate(wasm, imports),
    },
  })),
  createGpuCanvas: () => document.createElement('canvas'),
  initializeWgpu: (backend) => backend.ensureReady(),
  showGpuCanvas(canvas) {
    referenceCanvas.style.display = 'none';
    referenceCanvas.after(canvas);
  },
  dispose() {},
};
