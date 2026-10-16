// RHI Debug browser gate: capture a real frame in Chromium, replay it on a
// fresh Dawn device, compare live and replay pixels, and prove from the tape
// that the leaves use the specialized diffuse-transmission program with the
// compacted physical texture pair at bindings 68/69.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const luma = (pixels, width, x0, x1, y0, y1) => {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      sum += (0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]) / 255;
      count += 1;
    }
  return sum / count;
};

await verifyDemoCapture({
  pkg: '@forgeax/hello-foliage-transmission',
  label: 'hello-foliage-transmission',
  mode: 'pixel',
  liveHook: '__captureFoliage',
  rtIdx: 0,
  appDir: dirname(scriptsDir),
  // Shader modules, layouts and pipelines are created before the captured
  // frame, so they live in the tape bootstrap; the frame events prove use.
  assertCapture({ bootstrap, events }) {
    const created = bootstrap.map((entry) => entry.create).filter((create) => create !== undefined);
    const transmissive = created.filter(
      (create) => create.kind === 'createShaderModule' && /diffuseTransmissionTint/.test(create.wgslCode),
    );
    if (transmissive.length === 0) throw new Error('no captured shader carries the diffuse-transmission lobe');
    const masked = transmissive.filter(
      (create) =>
        /@group\(1\)\s*@binding\(68\)\s*var\s+diffuseTransmissionSampler/.test(create.wgslCode) &&
        /@group\(1\)\s*@binding\(69\)\s*var\s+diffuseTransmissionTexture/.test(create.wgslCode),
    );
    if (masked.length === 0) throw new Error('no captured shader binds diffuseTransmissionTexture at 68/69');
    const layouts = created.filter(
      (create) =>
        create.kind === 'createBindGroupLayout' &&
        create.desc.entries.some((entry) => entry.binding === 69 && entry.texture !== undefined) &&
        create.desc.entries.some((entry) => entry.binding === 68 && entry.sampler !== undefined),
    );
    if (layouts.length === 0) throw new Error('no captured material BGL declares the 68/69 diffuse-transmission pair');
    const transmissiveIds = new Set(transmissive.map((create) => create.handleId));
    const pipelines = new Set(
      created
        .filter((create) => create.kind === 'createRenderPipeline' && transmissiveIds.has(create.fragmentShaderModuleHandleId))
        .map((create) => create.handleId),
    );
    const bound = events.filter((event) => event.kind === 'setPipeline' && pipelines.has(event.pipelineHandleId));
    if (bound.length === 0) throw new Error('the captured frame never binds a diffuse-transmission pipeline');
    console.log(
      `[hello-foliage-transmission] tape: ${transmissive.length} transmission module(s), ${masked.length} masked, ${layouts.length} BGL(s) with 68/69, ${bound.length} bound pipeline(s)`,
    );
  },
  assertPixels({ pixels, width, height }) {
    const sx = width / 320;
    const sy = height / 180;
    const at = (x0, x1) => luma(pixels, width, Math.round(x0 * sx), Math.round(x1 * sx), Math.round(75 * sy), Math.round(105 * sy));
    const opaque = at(85, 105);
    const leaf = at(150, 170);
    const closed = at(202, 212);
    const open = at(238, 248);
    console.log(`[hello-foliage-transmission] live luma opaque=${opaque.toFixed(4)} leaf=${leaf.toFixed(4)} closed=${closed.toFixed(4)} open=${open.toFixed(4)}`);
    if (leaf < opaque + 0.15) throw new Error('live frame: transmissive leaf is not back-lit');
    if (open < closed + 0.15) throw new Error('live frame: diffuse-transmission mask has no effect');
  },
});
