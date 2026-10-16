// A host contract that starts using graphics must move to the native GPU path.
// Fail before device/context acquisition instead of silently using a fallback.
function rejectGraphics() {
  throw new Error('Browser host contract requested graphics; use the native GPU test config');
}

Object.defineProperty(navigator, 'gpu', {
  value: Object.freeze({ requestAdapter: rejectGraphics }),
});

for (const prototype of [HTMLCanvasElement.prototype, OffscreenCanvas.prototype]) {
  const getContext = prototype.getContext;
  Object.defineProperty(prototype, 'getContext', {
    value: function (kind, ...options) {
      kind = `${kind}`;
      if (['webgpu', 'webgl', 'webgl2', 'experimental-webgl'].includes(kind)) rejectGraphics();
      return Reflect.apply(getContext, this, [kind, ...options]);
    },
  });
}
