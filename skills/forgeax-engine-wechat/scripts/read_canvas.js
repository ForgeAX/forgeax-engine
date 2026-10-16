function readCanvasSample(options) {
  const region = options?.region;
  if (
    !Array.isArray(region) ||
    region.length !== 4 ||
    !region.every(Number.isSafeInteger) ||
    region[0] < 0 ||
    region[1] < 0 ||
    region[2] <= 0 ||
    region[3] <= 0 ||
    region[2] * region[3] > 3072 ||
    typeof options.selector !== 'string' ||
    !options.selector.trim() ||
    options.selector.length > 1024
  ) {
    return {
      status: 'unavailable',
      reason: 'bounded-region-and-positive-selector-required',
    };
  }
  const driver = typeof GameGlobal === 'object' ? GameGlobal : undefined;
  const game = driver?.__gameContextWindow;
  const inspection = game?.__forgeaxGameInspection;
  const canvases = Array.from(
    driver?.document?.querySelectorAll?.('canvas') ?? [],
  );
  const facts = canvases
    .slice(0, 8)
    .map((canvas) => ({ width: canvas.width, height: canvas.height }));
  if (
    canvases.length !== 1 ||
    typeof inspection?.ui !== 'function' ||
    typeof inspection.renderer !== 'function'
  )
    return {
      status: 'unavailable',
      reason: 'unique-canvas-and-live-inspection-required',
      canvases: facts,
    };
  const canvas = canvases[0];
  const gl = canvas.getContext('webgl2');
  if (!gl || gl.isContextLost())
    return {
      status: 'unavailable',
      reason: 'live-WebGL2-required',
      canvases: facts,
    };
  const ui = inspection.ui({
    selector: options.selector,
    styles: ['font-size'],
    // The limit counts every visited element, including unmatched ancestors.
    limit: 256,
  });
  const window = game.wx.getWindowInfo();
  const button =
    ui.ok &&
    !ui.value?.truncated &&
    ui.value?.nodes?.find(
      (node) => node.rect.width > 0 && node.rect.height > 0,
    );
  if (!button)
    return {
      status: 'unavailable',
      reason: 'visible-positive-control-required',
      ui,
      canvases: facts,
    };
  const ratio = window.pixelRatio;
  const width = canvas.width,
    height = canvas.height;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    width < 32 ||
    height < 32 ||
    region[0] + region[2] > width ||
    region[1] + region[3] > height
  ) {
    return {
      status: 'unavailable',
      reason: 'crop-outside-current-display',
      width,
      height,
      window,
    };
  }
  const centerX = Math.round((button.rect.x + button.rect.width / 2) * ratio);
  const centerY = Math.round((button.rect.y + button.rect.height / 2) * ratio);
  if (centerX < 0 || centerX >= width || centerY < 0 || centerY >= height) {
    return {
      status: 'unavailable',
      reason: 'positive-control-outside-display',
      ui,
    };
  }
  const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
  const crops = [
    {
      name: 'region',
      x: region[0],
      y: region[1],
      width: region[2],
      height: region[3],
    },
    {
      name: 'positive-control',
      x: clamp(centerX - 16, width - 32),
      y: clamp(centerY - 16, height - 32),
      width: 32,
      height: 32,
    },
  ];
  const base64 = (bytes) => {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const value =
        (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      result +=
        alphabet[(value >>> 18) & 63] +
        alphabet[(value >>> 12) & 63] +
        (i + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=') +
        (i + 2 < bytes.length ? alphabet[value & 63] : '=');
    }
    return result;
  };
  const receipt = () => {
    const value = inspection.renderer();
    return {
      frame: value.frame,
      completed: value.completed,
      presented: value.presented,
      phase: value.phase,
      error: value.lastError
        ? String(value.lastError.message || value.lastError)
        : null,
    };
  };
  return new Promise((resolve) => {
    let pending;
    const raf = game.requestAnimationFrame?.bind(game);
    const caf = game.cancelAnimationFrame?.bind(game);
    if (!raf || !caf)
      return resolve({
        status: 'unavailable',
        reason: 'game-frame-scheduler-required',
      });
    const timeout = setTimeout(() => {
      caf(pending);
      resolve({ status: 'unavailable', reason: 'frame-timeout' });
    }, 5000);
    pending = raf(() => {
      clearTimeout(timeout);
      let before, saved, result;
      try {
        before = receipt();
        saved = {
          read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
          pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
          alignment: gl.getParameter(gl.PACK_ALIGNMENT),
          rowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
          skipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS),
          skipRows: gl.getParameter(gl.PACK_SKIP_ROWS),
        };
        if (
          canvas.width !== width ||
          canvas.height !== height ||
          gl.isContextLost()
        )
          throw Error('display changed before sampling');
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
        const pixels = crops.map((crop) => {
          const bytes = new Uint8Array(crop.width * crop.height * 4);
          gl.readPixels(
            crop.x,
            height - crop.y - crop.height,
            crop.width,
            crop.height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bytes,
          );
          return {
            ...crop,
            rgbaBase64: base64(bytes),
            rowOrder: 'bottom-to-top',
            nonzeroChannels: bytes.reduce(
              (count, value) => count + Number(value !== 0),
              0,
            ),
          };
        });
        result = {
          status: 'captured',
          atUtc: new Date().toISOString(),
          width,
          height,
          window,
          contextAttributes: gl.getContextAttributes(),
          before,
          after: receipt(),
          ui,
          pixels,
        };
      } catch (error) {
        result = {
          status: 'unavailable',
          reason: String(error.message || error),
          before,
        };
      } finally {
        if (saved)
          try {
            gl.pixelStorei(gl.PACK_ALIGNMENT, saved.alignment);
            gl.pixelStorei(gl.PACK_ROW_LENGTH, saved.rowLength);
            gl.pixelStorei(gl.PACK_SKIP_PIXELS, saved.skipPixels);
            gl.pixelStorei(gl.PACK_SKIP_ROWS, saved.skipRows);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.pack);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
          } catch (error) {
            result = {
              status: 'unavailable',
              reason:
                'GL-state-restoration-failed: ' +
                String(error.message || error),
              before,
            };
          }
      }
      result.bindingsRestored =
        !!saved &&
        gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === saved.read &&
        gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) === saved.pack &&
        gl.getParameter(gl.PACK_ALIGNMENT) === saved.alignment &&
        gl.getParameter(gl.PACK_ROW_LENGTH) === saved.rowLength &&
        gl.getParameter(gl.PACK_SKIP_PIXELS) === saved.skipPixels &&
        gl.getParameter(gl.PACK_SKIP_ROWS) === saved.skipRows;
      resolve(result);
    });
  });
}
