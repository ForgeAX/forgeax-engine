const REFERENCE_WIDTH = 1280;
const REFERENCE_HEIGHT = 720;

export const FOG_ROI_POINTS = Object.freeze({
  nearGate: Object.freeze([0.5, 370 / REFERENCE_HEIGHT]),
  midGate: Object.freeze([0.5, 360 / REFERENCE_HEIGHT]),
  farGate: Object.freeze([0.5, 330 / REFERENCE_HEIGHT]),
  lowMarker: Object.freeze([484 / REFERENCE_WIDTH, 375 / REFERENCE_HEIGHT]),
  highMarker: Object.freeze([799 / REFERENCE_WIDTH, 251 / REFERENCE_HEIGHT]),
});

export function sampleFogRois(bytes, width, height) {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error('Fog ROI readback must be an RGBA byte array');
  }
  if (bytes.length !== width * height * 4) {
    throw new Error(`Fog ROI readback shape mismatch: ${bytes.length} for ${width}x${height}`);
  }
  const radius = Math.max(1, Math.round(width / REFERENCE_WIDTH));
  return Object.fromEntries(
    Object.entries(FOG_ROI_POINTS).map(([name, [xRatio, yRatio]]) => {
      const centerX = Math.min(width - 1, Math.max(0, Math.round(xRatio * width)));
      const centerY = Math.min(height - 1, Math.max(0, Math.round(yRatio * height)));
      const rgba = [0, 0, 0, 0];
      let count = 0;
      for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
        for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
          const offset = (y * width + x) * 4;
          rgba[0] += (bytes[offset] ?? 0) / 255;
          rgba[1] += (bytes[offset + 1] ?? 0) / 255;
          rgba[2] += (bytes[offset + 2] ?? 0) / 255;
          rgba[3] += (bytes[offset + 3] ?? 0) / 255;
          count += 1;
        }
      }
      return [name, {
        center: [centerX, centerY],
        radius,
        rgba: rgba.map((value) => value / count),
      }];
    }),
  );
}
