// RHI Debug browser gate: capture a real frame in Chromium, replay it on a
// fresh Dawn device, compare live and replay pixels, and prove from the tape
// that the frame binds the triplanar and object-space-normal Standard
// specializations (texture-mask override bits 29/30) and the unlit program
// carrying the matcap lookup.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const { STANDARD_OBJECT_SPACE_NORMAL_BIT, STANDARD_TEXTURE_MASK_OVERRIDE, STANDARD_TRIPLANAR_PROJECTION_BIT } = await import(
  '@forgeax/engine-shader'
);
const { BOTTOM_Y, SPHERE_X, WIDTH, HEIGHT, toPixel } = await import(pathToFileURL(resolve(appDir, 'src', 'scene.ts')).href);

const mean = (pixels, width, x0, x1, y0, y1) => {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += pixels[offset + channel] / 255;
      count += 1;
    }
  return sum.map((value) => value / count);
};

await verifyDemoCapture({
  pkg: '@forgeax/hello-material-projection',
  label: 'hello-material-projection',
  mode: 'pixel',
  liveHook: '__captureProjection',
  // Every subject edge is a hard silhouette on black, and SwiftShader and
  // lavapipe snap sub-pixel coverage differently; a fresh replay in the same
  // browser owns the strict pixel gate, Node Dawn stays mandatory evidence.
  browserReplayHook: '__replayProjectionCapture',
  pixelVerdictOwner: 'browser-fresh',
  rtIdx: 0,
  appDir,
  // Shader modules and pipelines are created before the captured frame, so
  // they live in the tape bootstrap; the frame events prove use.
  assertCapture({ bootstrap, events }) {
    const created = bootstrap.map((entry) => entry.create).filter((create) => create !== undefined);
    const bound = new Set(events.filter((event) => event.kind === 'setPipeline').map((event) => event.pipelineHandleId));
    const pipelines = created.filter((create) => create.kind === 'createRenderPipeline' && bound.has(create.handleId));
    // Pipeline constants are keyed by the override's numeric @id, not its name.
    const withBit = (bit) =>
      pipelines.filter(
        (create) => (Number(create.desc.fragment?.constants?.[STANDARD_TEXTURE_MASK_OVERRIDE] ?? 0) & bit) !== 0,
      );
    const triplanar = withBit(STANDARD_TRIPLANAR_PROJECTION_BIT);
    const objectNormal = withBit(STANDARD_OBJECT_SPACE_NORMAL_BIT);
    if (triplanar.length === 0) throw new Error('the captured frame binds no triplanar-specialized Standard pipeline');
    if (objectNormal.length === 0) throw new Error('the captured frame binds no object-space-normal Standard pipeline');
    const modules = new Map(created.filter((create) => create.kind === 'createShaderModule').map((create) => [create.handleId, create.wgslCode]));
    for (const pipeline of [...triplanar, ...objectNormal]) {
      const code = modules.get(pipeline.fragmentShaderModuleHandleId) ?? '';
      if (!/surfaceTriplanarSamples/.test(code) || !/surfaceObjectNormalToWorld/.test(code))
        throw new Error(`pipeline ${pipeline.handleId} lacks the projection surface helpers`);
    }
    const matcap = pipelines.filter((create) => /unlitMatcapUv/.test(modules.get(create.fragmentShaderModuleHandleId) ?? ''));
    if (matcap.length === 0) throw new Error('the captured frame binds no unlit pipeline with the matcap lookup');
    console.log(
      `[hello-material-projection] tape: ${pipelines.length} bound pipeline(s), ${triplanar.length} triplanar, ${objectNormal.length} object-normal, ${matcap.length} unlit/matcap`,
    );
  },
  assertPixels({ pixels, width, height }) {
    const sx = width / WIDTH;
    const sy = height / HEIGHT;
    const at = (x, dx, dy) => {
      const [px, py] = toPixel(x, BOTTOM_Y);
      const cx = (px + dx) * sx;
      const cy = (py + dy) * sy;
      return mean(pixels, width, Math.round(cx - 3 * sx), Math.round(cx + 3 * sx), Math.round(cy - 3 * sy), Math.round(cy + 3 * sy));
    };
    const matcapLeft = at(SPHERE_X.matcap, -22, 0);
    const matcapRight = at(SPHERE_X.matcap, 22, 0);
    const normalLeft = at(SPHERE_X.normal, -22, 0);
    const normalRight = at(SPHERE_X.normal, 22, 0);
    const fmt = (rgb) => `[${rgb.map((value) => value.toFixed(3)).join(',')}]`;
    console.log(
      `[hello-material-projection] live matcap left=${fmt(matcapLeft)} right=${fmt(matcapRight)} normal left=${fmt(normalLeft)} right=${fmt(normalRight)}`,
    );
    if (!(matcapLeft[0] > matcapLeft[2] + 0.1 && matcapRight[2] > matcapRight[0] + 0.1))
      throw new Error('live frame: matcap does not follow the view normal');
    if (!(normalRight[0] > normalLeft[0] + 0.2)) throw new Error('live frame: normal visualization does not follow view x');
  },
});
