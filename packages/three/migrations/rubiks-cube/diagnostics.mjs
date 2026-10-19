export function attachDiagnostics(mode) {
  const { renderer, scene, camera } = window.game;
  const panel = document.createElement('aside');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:102;max-width:280px;padding:12px;background:#172333;color:white;border-radius:8px;font:13px/1.5 sans-serif';
  panel.innerHTML = `<strong>${mode === 'forgeax' ? 'Forgeax migration' : 'Three.js r184 reference'}</strong><br><span id="migration-status">Waiting for frames</span><br><button id="migration-capture">${mode === 'forgeax' ? 'Capture RHI frame' : 'Save reference frame'}</button><div id="migration-artifacts"></div><a href="provenance.json" style="color:#9cddff">Source and migration details</a>`;
  document.body.append(panel);
  const status = panel.querySelector('#migration-status');
  const button = panel.querySelector('#migration-capture');
  const artifacts = panel.querySelector('#migration-artifacts');
  const state = { mode, readyFrames: 0, errors: [], capture: undefined };
  window.threeMigration = state;
  const fail = (error) => {
    state.errors.push({ message: String(error), code: error?.code, detail: error?.detail });
    status.textContent = String(error);
  };
  window.addEventListener('error', event => fail(event.error));
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  const render = renderer.render.bind(renderer);
  renderer.render = (...args) => {
    const result = render(...args);
    const counted = () => {
      state.readyFrames++;
      status.textContent = `${state.readyFrames} ready frames`;
    };
    if (mode === 'reference') counted();
    else {
      const receipt = renderer.inspect().receipt;
      if (receipt?.presentation === 'ready')
        void receipt.completed.then(result => result.ok ? counted() : fail(result.error));
    }
    return result;
  };
  const urls = [];
  const download = (name, bytes, type = 'application/octet-stream') => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type }));
    urls.push(link.href);
    link.download = name;
    link.dataset.artifact = name;
    link.textContent = name;
    link.style.cssText = 'display:block;color:#9cddff';
    artifacts.append(link);
  };
  state.capture = async () => {
    button.disabled = true;
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    artifacts.replaceChildren();
    try {
      if (mode === 'forgeax') {
        const { decodeImage, toRgba8 } = await import('@forgeax/engine/rhi-debug');
        const capture = await renderer.captureFrame(scene, camera);
        const display = capture.observation.observations.find(item => item.domain === 'final-display');
        if (!display) throw new Error('Missing native final-display observation');
        download('frame.rgba', toRgba8(decodeImage(display.bytes, display.metadata).unwrap()));
        download('frame.rhitape', capture.tape.bytes);
        download('frame.sources.json', JSON.stringify({ frameId: capture.receipt.frameId,
          sources: capture.sources, display: display.metadata }, null, 2), 'application/json');
      } else {
        renderer.render(scene, camera);
        const gl = renderer.getContext();
        const { width, height } = renderer.domElement;
        const bottomUp = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
        const pixels = new Uint8Array(bottomUp.length);
        for (let y = 0; y < height; y++)
          pixels.set(bottomUp.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
        download('frame.rgba', pixels);
      }
      status.textContent = 'Frame saved';
    } finally { button.disabled = false; }
  };
  button.onclick = () => state.capture().catch(fail);
}
