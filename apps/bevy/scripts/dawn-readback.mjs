// Dawn-node harness for Bevy shadow smokes that falsify rendered pixels:
// one captured device, a copyable mock canvas, frame readback, and a pinhole
// projection that maps authored world points onto the readback grid.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function openDawnCanvas(width, height) {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  // Dawn-node prefers bgra8unorm; the readback below decodes RGBA bytes.
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  let device;
  let target;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await requestDevice(descriptor);
      device ??= created;
      return created;
    };
    return adapter;
  };
  const ensureTarget = (owner, format) => {
    target ??= owner.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return target;
  };
  const canvas = {
    width,
    height,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor) { ensureTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'); },
        unconfigure() {},
        getCurrentTexture() {
          if (device === undefined) throw new Error('no Dawn device captured');
          return ensureTarget(device, 'rgba8unorm');
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return {
    canvas,
    /** Restore the adapter hook once the renderer owns its device. */
    release() { gpu.requestAdapter = requestAdapter; },
    get device() { return device; },
    async readback() {
      if (device === undefined || target === undefined) throw new Error('no rendered canvas to read back');
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      return createFrame(bytes, bytesPerRow, width, height);
    },
  };
}

function createFrame(bytes, bytesPerRow, width, height) {
  const texel = (x, y) => {
    const offset = y * bytesPerRow + x * 4;
    return [bytes[offset] / 255, bytes[offset + 1] / 255, bytes[offset + 2] / 255];
  };
  return {
    width,
    height,
    /** Mean encoded RGB over a (2r+1)^2 window clamped to the frame. */
    sample([px, py], radius = 1) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = Math.round(py) - radius; y <= Math.round(py) + radius; y++) {
        for (let x = Math.round(px) - radius; x <= Math.round(px) + radius; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const rgb = texel(x, y);
          for (let c = 0; c < 3; c++) sum[c] += rgb[c];
          count++;
        }
      }
      return sum.map((value) => value / Math.max(count, 1));
    },
    /** Write a binary PPM for PR evidence when SMOKE_CAPTURE_DIR is set. */
    capture(name) {
      const directory = process.env.SMOKE_CAPTURE_DIR;
      if (directory === undefined) return;
      const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
      const body = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = y * bytesPerRow + x * 4;
          body.set(bytes.subarray(offset, offset + 3), (y * width + x) * 3);
        }
      }
      writeFileSync(resolve(directory, `${name}.ppm`), Buffer.concat([header, body]));
    },
  };
}

export const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Perspective pinhole matching `perspective({ fov })` with a vertical fov and a look-at camera. */
export function createProjector({ position, target, fov, width, height }) {
  const sub = (a, b) => a.map((value, i) => value - b[i]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = (a) => a.map((value) => value / Math.hypot(...a));
  const forward = normalize(sub(target, position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = 1 / Math.tan(fov / 2);
  const aspect = width / height;
  return (point) => {
    const d = sub(point, position);
    const depth = dot(d, forward);
    const ndcX = (dot(d, right) * focal) / (depth * aspect);
    const ndcY = (dot(d, up) * focal) / depth;
    return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
  };
}
