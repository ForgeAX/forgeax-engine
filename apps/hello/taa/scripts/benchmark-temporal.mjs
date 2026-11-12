import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "@forgeax/engine-ecs";
import { createPrimitiveMesh } from "@forgeax/engine-geometry";
import * as render from "@forgeax/engine-render";
import { constructRuntimeRendererHost } from "@forgeax/engine-runtime/internal/renderer-host";
import { Transform } from "@forgeax/engine-scene";
import { attachRecorder, buildFrameModel, decodeTape, tapeDigest } from "@forgeax/engine/rhi-debug";
import * as webgpu from "@forgeax/engine/rhi-webgpu";
import { drawReadyFrame } from "../../../../scripts/test/ready-render-frame.mjs";
import { setupGpuShim } from "../../triangle/scripts/smoke-helpers.mjs";

const output = process.env.FORGEAX_TSR_BENCH_OUTPUT;
if (!output) throw new Error("set FORGEAX_TSR_BENCH_OUTPUT to a path outside the checkout");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const width = 1920,
  height = 1080,
  warmup = 60,
  samples = 120;
const value = (result) => {
  if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
  return result.value;
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
// Preserve this budget when a run fails; never tune it from measured results.
const budget = {
  completeFrameP95Ms: 16.67,
  temporalPassP95Ms: 2,
  retainedBytes: 128 * 1024 * 1024,
};
const changed = [
  ...new Set([
    ...git("diff", "--name-only", "HEAD").trim().split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "packages", "apps", "schemas")
      .trim()
      .split("\n"),
  ]),
]
  .filter(Boolean)
  .sort();
const sourceFiles = await Promise.all(
  changed.map(async (path) => ({ path, sha256: hash(await readFile(resolve(root, path))) })),
);
const temporal = (
  await readFile(resolve(root, "packages/shader/src/scene-temporal.wgsl"), "utf8")
).replace(/^#define_import_path.*$/gm, "");
const common = await readFile(resolve(root, "packages/shader/src/tsr-common.wgsl"), "utf8");
const expectedShaders = Object.fromEntries(
  await Promise.all(
    [
      ["tsr_measure_opaque", "opaque"],
      ["tsr_analyze", "analyze"],
      ["tsr_reconstruct", "reconstruct"],
    ].map(async ([entry, stage]) => [
      entry,
      hash(
        `${temporal}\n${common}\n${await readFile(resolve(root, `packages/shader/src/tsr-${stage}.wgsl`), "utf8")}`,
      ),
    ]),
  ),
);
const shim = await setupGpuShim({
  width,
  height,
  backendArgs: ["disable-dawn-features=timestamp_quantization"],
  rerunCmd: "FORGEAX_TSR_BENCH_OUTPUT=<external.json> node scripts/benchmark-temporal.mjs",
});
const recorder = attachRecorder(webgpu).unwrap();
const manifest = await readFile(new URL("../dist/shaders/manifest.json", import.meta.url), "utf8");
const host = value(
  await constructRuntimeRendererHost(
    shim.mockCanvas,
    {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: { resolveSurfaceDevice: recorder.backend.unwrapDeviceForSurface },
      gpuPassTiming: { maxPassesPerFrame: 64, retentionFrames: 8 },
    },
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` },
  ),
);
value(await host.initialization);
const renderer = host.renderer,
  errors = [];
renderer.subscribe((event) => {
  if (event.kind === "error") errors.push(event.error);
});
const world = new World({ assets: host.assets });
const cube = host.assets.create(value(createPrimitiveMesh("cube"))).unwrap();
const white = host.assets.create(render.Materials.unlit([4, 4, 4, 1])).unwrap();
for (let i = 0; i < 32; i++)
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, -2.4 + i * 0.15, 0],
          scale: [8, 0.025, 0.025],
          quat: [0, 0, Math.sin((0.12 + i * 0.006) / 2), Math.cos((0.12 + i * 0.006) / 2)],
        },
      },
      { component: render.MeshFilter, data: { assetHandle: cube } },
      { component: render.MeshRenderer, data: { materials: [white] } },
    )
    .unwrap();
const camera = world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 6] } },
    {
      component: render.Camera,
      data: {
        ...render.perspective({ fov: Math.PI / 3, aspect: width / height }),
        antialias: render.ANTIALIAS_TAA,
      },
    },
  )
  .unwrap();
const lease = value(renderer.attach(world));
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
const routes = [];
try {
  for (const [mode, scale] of [
    ["taa", 1],
    ["taa", 0.5],
    ["tsr", 1],
    ["tsr", 0.5],
  ]) {
    world
      .set(camera, render.Camera, {
        antialias: mode === "tsr" ? render.ANTIALIAS_TSR : render.ANTIALIAS_TAA,
      })
      .unwrap();
    if (scale === 1) {
      if (world.hasComponent(camera, render.DynamicResolution))
        world.removeComponent(camera, render.DynamicResolution).unwrap();
    } else
      world
        .addComponent(camera, {
          component: render.DynamicResolution,
          data: { minScale: scale, maxScale: scale, targetGpuMs: 16.67 },
        })
        .unwrap();
    const cpu = [],
      gpu = [],
      temporalCosts = [],
      frames = [];
    for (let i = 0; i < warmup + samples; i++) {
      const start = performance.now();
      world.set(camera, Transform, { pos: [Math.sin(i * 0.02) * 0.05, 0, 6] }).unwrap();
      world.update(1 / 60).unwrap();
      const receipt = await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
        sampleTimeSeconds: i / 60,
        profileFrame: { captureId: `temporal-${mode}-${scale}`, frameId: i + 1 },
      });
      const elapsed = performance.now() - start;
      if (i < warmup) continue;
      const observation = value(await renderer.observe(receipt, { include: ["timings"] }));
      const timing = observation.timings;
      if (timing?.status !== "complete")
        throw new Error(`timestamp evidence unavailable: ${JSON.stringify(timing)}`);
      const measured = timing.frame.passes.filter((p) => p.status === "measured");
      const ticks = measured.flatMap((p) => [BigInt(p.beginningTick), BigInt(p.endTick)]);
      const begin = ticks.reduce((a, b) => (a < b ? a : b)),
        end = ticks.reduce((a, b) => (a > b ? a : b));
      cpu.push(elapsed);
      gpu.push((Number(end - begin) * timing.frame.timestampPeriodNanoseconds) / 1e6);
      temporalCosts.push(
        measured
          .filter((p) => /^(taa-resolve|tsr-)/.test(p.passName))
          .reduce((s, p) => s + p.durationNanoseconds / 1e6, 0),
      );
      frames.push(timing.frame);
    }
    // Provenance frame is outside the timed interval. Compare the executed WGSL
    // with the authored source, rather than trusting a dist timestamp.
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await drawReadyFrame(renderer, {
      leases: [lease],
      camera: { lease },
      environment: { lease },
      sampleTimeSeconds: (warmup + samples) / 60,
    });
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await capture).unwrap();
    const model = buildFrameModel(decodeTape(artifact.bytes).unwrap());
    const shaders = Object.fromEntries(
      model.works.flatMap((work) =>
        work.pipeline.shaders
          .filter((s) => s.entryPoint?.startsWith("tsr_"))
          .map((s) => [s.entryPoint, hash(s.source)]),
      ),
    );
    if (mode === "tsr" && JSON.stringify(shaders) !== JSON.stringify(expectedShaders))
      throw new Error("executed TSR source differs from the source checkout");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(`${output}.${mode}-${scale}.rhitape`, artifact.bytes);
    routes.push({
      mode,
      scale,
      completedFrames: warmup + samples + 1,
      completeFrameP50Ms: percentile(cpu, 0.5),
      completeFrameP95Ms: percentile(cpu, 0.95),
      gpuEnvelopeP50Ms: percentile(gpu, 0.5),
      gpuEnvelopeP95Ms: percentile(gpu, 0.95),
      temporalPassP95Ms: percentile(temporalCosts, 0.95),
      history: renderer.inspect().temporal,
      dynamicResolution: renderer.inspect().dynamicResolution,
      shaders,
      tapeDigest: await tapeDigest(artifact.bytes),
      frames,
    });
  }
  const report = {
    source: git("rev-parse", "HEAD").trim(),
    dirty: git("status", "--porcelain", "--untracked-files=no").length > 0 || changed.length > 0,
    sourceFiles,
    diffSha256: hash(git("diff", "--binary", "HEAD")),
    manifestSha256: hash(manifest),
    expectedShaders,
    width,
    height,
    warmup,
    samples,
    adapter: shim.adapterInfo,
    timestampQuantization: "disabled",
    capabilities: renderer.inspect().capabilities,
    budget,
    routes,
    errors,
  };
  report.budgetMet = routes.every(
    (r) =>
      r.completeFrameP95Ms <= budget.completeFrameP95Ms &&
      r.temporalPassP95Ms <= budget.temporalPassP95Ms &&
      r.history.historyBytes <= budget.retainedBytes,
  );
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ ...report, routes: routes.map(({ frames, ...route }) => route) }, null, 2),
  );
  if (errors.length || !report.budgetMet) process.exitCode = 1;
} finally {
  lease.dispose();
  value(await renderer.dispose());
  (await recorder.dispose()).unwrap();
}

// The standalone Dawn carrier retains device polling while module globals live.
// All receipts, provenance files and teardown above have completed at this point.
process.exit(process.exitCode ?? 0);
