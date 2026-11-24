#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";

import { Transform } from "@forgeax/engine-scene";
import { DIFFUSE_GI_TIER_BUDGETS, resolveDiffuseGiTier } from "@forgeax/engine-render";
import { summarizeGpuPassTimingIntervals } from "@forgeax/engine-render/internal";
import { attachRecorder } from "@forgeax/engine-rhi-debug";
import {
  createNativeWindow,
  installNavigatorGpu,
  nativeWgpuVersion,
} from "@forgeax/engine-rhi-wgpu-native";

import * as gi from "./gi-dawn.mjs";
import { createNativeSponzaStartup } from './native-sponza-startup.mjs';
import { optionReader } from "./gi-comparison.mjs";
import {
  captureNativeSurfaceAfterFrame,
  createNativeSponzaRendererHost,
  evaluateNativeSurfacePresentation,
  inspectNativeSponzaGi,
} from "./native-sponza-renderer.mjs";
import {
  advanceRoamCamera,
  consumeNativeWindowEvents,
  consumeNativePointerEvents,
  commandForKey,
  exposureForControls,
  initialHardwareRayTracing,
  createRoamCamera,
  roamCameraPose,
} from "./native-sponza-controls.mjs";
import { createNativeSponzaUi } from "./native-sponza-ui.mjs";
import {
  createNativeSponzaCapture,
  nativeSponzaCaptureBudgetsFromOptions,
} from "./native-sponza-capture.mjs";

const option = optionReader(process.argv.slice(2));
const dist = resolve(option("sponza-dist", resolve(gi.appRoot, "dist")));
const width = Number(option("width", "1600"));
const height = Number(option("height", "900"));
const warmupFrames = Number(option("warmup-frames", "120"));
const durationSeconds = Number(option("duration-seconds", "150"));
const maxFrames = Number(option("max-frames", "9000"));
// Interactive previews retain readiness/input receipts without collecting timings.
const collectTiming = option('collect-timing', 'false') === 'true';
const gpuTimingOption = option('gpu-pass-timing', 'false');
if (gpuTimingOption !== 'false' && gpuTimingOption !== 'true')
  throw new Error('--gpu-pass-timing must be true or false');
const collectGpuPassTiming = gpuTimingOption === 'true';
const captureRhiAfterReadyFrames = Number(option("capture-rhi-after-ready-frames", "0"));
const captureRhiBudgets = nativeSponzaCaptureBudgetsFromOptions(option);
const captureRhiMaxResourceMiB = captureRhiBudgets.maxResourceMiB;
const requestedMode = option("gi", "screen-probe");
const requestedHardwareRayTracing = initialHardwareRayTracing(option("hardware-ray-tracing", "on"));
const softwareTracing = option("software-tracing", "strict");
if (softwareTracing !== "strict" && softwareTracing !== "mesh-df")
  throw new Error(`invalid --software-tracing ${softwareTracing}; choose strict or mesh-df`);
const screenProbeTier = option("screen-probe-tier", "high");
if (screenProbeTier !== "high" && screenProbeTier !== "epic")
  throw new Error(`invalid --screen-probe-tier ${screenProbeTier}; choose high or epic`);
const presetProbes = DIFFUSE_GI_TIER_BUDGETS[screenProbeTier].probes;
const probeIrradiance = option("probe-irradiance", presetProbes?.irradiance ?? "directional");
if (!["directional", "probe-octahedral", "probe-sh3"].includes(probeIrradiance))
  throw new Error(`invalid --probe-irradiance ${probeIrradiance}`);
const probeIntegration = option(
  "probe-integration",
  probeIrradiance === "directional" ? "full" : presetProbes?.integration ?? "full",
);
if (probeIntegration !== "full" &&
    (probeIntegration !== "screen-space" || probeIrradiance === "directional"))
  throw new Error("--probe-integration supports full, or screen-space with preintegrated irradiance");
const out = resolve(
  option(
    "out",
    process.env.NATIVE_SPONZA_EVIDENCE ??
      resolve(tmpdir(), `forgeax-native-sponza-${process.pid}-${Date.now()}`),
  ),
);
const validModes = new Set(["off", "irradiance-field", "screen-probe"]);
if (!validModes.has(requestedMode))
  throw new Error(`invalid --gi ${requestedMode}; choose off, irradiance-field, or screen-probe`);
for (const [name, value] of Object.entries({
  width,
  height,
  warmupFrames,
  durationSeconds,
  maxFrames,
  captureRhiMaxResourceMiB,
}))
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`);
if (!Number.isSafeInteger(captureRhiAfterReadyFrames) || captureRhiAfterReadyFrames < 0)
  throw new Error("capture-rhi-after-ready-frames must be 0 or a positive integer");
if (durationSeconds > 160) throw new Error("--duration-seconds must be at most 160");

const FRAME_TARGET_MS = 1000 / 60;
// A sub-millisecond Node timer rounds up and can slip an entire Windows timer tick.
// Keep the absolute deadline so skipped short waits carry into the next frame.
const FRAME_PACING_EARLY_TOLERANCE_MS = 1;
const BLOCK_FRAMES = 60;
const GPU_TIMING_SAMPLE_LIMIT = 20;
const GPU_TIMING_SAMPLE_STRIDE = 4;
const sessionStartedAt = performance.now();
const outputFile = resolve(out, "session.json");
const frameSamplesFile = resolve(out, "frame-samples.json");
const rhiCaptureFile = resolve(out, "renderer-frame.rhitape");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const percentile = (values, quantile) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * quantile)];
};
const summary = (values) =>
  values.length === 0
    ? undefined
    : {
        samples: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: Math.max(...values),
        over16_67ms: values.filter((value) => value > FRAME_TARGET_MS).length,
      };
/** @type {Promise<void> | undefined} */
let progressWrite;
/** @type {{ error: unknown } | undefined} */
let progressWriteFailure;
const atomicWrite = async (value) => {
  const temporary = `${outputFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, outputFile);
};

const flushReport = async () => {
  await progressWrite;
  await atomicWrite(report);
};

await mkdir(out, { recursive: true });
for (const path of [
  outputFile,
  `${outputFile}.tmp`,
  frameSamplesFile,
  `${frameSamplesFile}.tmp`,
  ...(captureRhiAfterReadyFrames > 0 ? [rhiCaptureFile] : []),
]) {
  try {
    await readFile(path);
    throw new Error(`Refusing to overwrite existing native Sponza evidence: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const { SPONZA, tierSceneFor } = await import("../src/scenes.ts");
const { Camera: CameraComponent, perspective, TONEMAP_UE_FILMIC } = await import("@forgeax/engine-render");
const { propagateTransforms } = await import("@forgeax/engine-scene");
const { cameraTransform, spawnSponzaSky } = await import("../src/build-scene.ts");
let nativeWindow;
let nativeRhiCapture;
let debugUi;
const commands = [];
const pointerState = {};
/** @type {import('@forgeax/engine-render').Renderer | undefined} */
let renderer;
let running = true;
let stopReason;
let roamCamera;
let cameraTravelMeters = 0;
let lastQualifiedCompletedAt;
let lastCompletedAt;
let totalCompletedFrames = 0;
/** @type {number | undefined} */
let lastCompletedFrameId;
let readyFramesForMode = 0;
const heldKeys = new Set();
const frameSamples = [];
const errors = [];
const gpuTiming = collectGpuPassTiming
  ? {
      sampleLimit: GPU_TIMING_SAMPLE_LIMIT,
      /** @type {Record<string, unknown>[]} */
      samples: [],
    }
  : undefined;
const report = {
  status: "starting",
  startedAt: new Date().toISOString(),
  finishedAt: undefined,
  elapsedSeconds: undefined,
  stopReason: undefined,
  error: undefined,
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  engineCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gi.monorepoRoot })
    .toString()
    .trim(),
  nativeWgpuVersion: nativeWgpuVersion(),
  scene: "sponza",
  catalogPath: resolve(dist, "pack-index.json"),
  catalogSha256: undefined,
  shaderManifest: undefined,
  runtimeModules: undefined,
  requestedWindow: { width, height },
  requestedHardwareRayTracing,
  requestedSoftwareTracing: softwareTracing,
  requestedScreenProbeTier: screenProbeTier,
  requestedProbeIrradiance: probeIrradiance,
  requestedProbeIntegration: probeIntegration,
  timeLimit: { durationSeconds, maxFrames },
  timingCollection: collectTiming ? 'enabled' : 'disabled-interactive-preview',
  ...(gpuTiming === undefined ? {} : { gpuPassTiming: gpuTiming }),
  adapter: undefined,
  renderer: undefined,
  rhiCapture: /** @type {Record<string, unknown>} */ (
    captureRhiAfterReadyFrames === 0
      ? { status: "disabled" }
      : {
          status: "waiting-for-qualified-frame",
          afterReadyFrames: captureRhiAfterReadyFrames,
          outputPath: rhiCaptureFile,
          byteBudget: captureRhiBudgets.byteBudget,
          byteBudgetMiB: captureRhiBudgets.totalMiB,
          maxResourceBytes: captureRhiBudgets.maxResourceBytes,
        }
  ),
  controls: `WASD move, Q/E vertical, RMB drag or arrows look, Shift faster; 1 GI off, 2 irradiance field (Medium), 3 screen probe (${screenProbeTier}); H hardware Ray Query allowed/off, F auto exposure, [/] EV, R reset; left click debug buttons; Escape exits; auto-closes after ${durationSeconds}s or ${maxFrames} completed frames`,
  debugCommands: [],
  exposure: undefined,
  debugUi: undefined,
  hardwareRayTracing: undefined,
  mouseLook: { appliedBatches: 0, logicalDeltaX: 0, logicalDeltaY: 0, rightDown: 0, rightUp: 0 },
  warmupFrames,
  camera: undefined,
  inputEvents: {
    keyDown: 0,
    keyUp: 0,
    repeatedKeyDown: 0,
    focusLost: 0,
    focusGained: 0,
    closeRequested: 0,
    surfaceLost: 0,
    displayChanged: 0,
    visibilityChanged: 0,
    pressedByCode: {},
    releasedByCode: {},
  },
  displayEvents: undefined,
  startup: undefined,
  startupCoverFrames: undefined,
  currentFrame: undefined,
  frameReadiness: { byMode: {}, transitions: [] },
  completedFrames: 0,
  completedReadyFrames: 0,
  qualifiedFrames: 0,
  unqualifiedCompletedFrames: 0,
  modeChanges: [],
  frameBlocks: [],
  frameSamples: undefined,
  frameSamplesError: undefined,
  errors,
  teardownErrors: undefined,
};

const cameraSnapshot = (camera) => {
  const pose = roamCameraPose(camera);
  return {
    origin: [...pose.origin],
    target: [...pose.target],
    yawRadians: camera.yaw,
    pitchRadians: camera.pitch,
  };
};
/**
 * @param {readonly import('@forgeax/engine-rhi-wgpu-native').NativeWindowEvent[]} events
 * @param {import('@forgeax/engine-rhi-wgpu-native').NativeWindowFacts} windowFacts
 */
const recordWindowEvents = (events, windowFacts) => {
  for (const event of events) {
    switch (event.kind) {
      case "key-down":
        report.inputEvents.keyDown++;
        if (event.repeat) report.inputEvents.repeatedKeyDown++;
        else
          report.inputEvents.pressedByCode[event.code] =
            (report.inputEvents.pressedByCode[event.code] ?? 0) + 1;
        break;
      case "key-up":
        report.inputEvents.keyUp++;
        report.inputEvents.releasedByCode[event.code] =
          (report.inputEvents.releasedByCode[event.code] ?? 0) + 1;
        break;
      case "focus":
        if (event.focused) report.inputEvents.focusGained++;
        else report.inputEvents.focusLost++;
        break;
      case "close-requested":
        report.inputEvents.closeRequested++;
        break;
      case "surface-lost":
        report.inputEvents.surfaceLost++;
        break;
      case "display":
        report.inputEvents.displayChanged++;
        // Associate an event with the last completed receipt, not a guessed
        // upcoming GPU frame. Native display payloads retain their own fields.
        report.displayEvents ??= { capacity: 32, overflow: 0, entries: [] };
        if (report.displayEvents.entries.length === report.displayEvents.capacity) {
          report.displayEvents.entries.shift();
          report.displayEvents.overflow++;
        }
        report.displayEvents.entries.push({
          frameId: lastCompletedFrameId ?? null,
          elapsedSeconds: (performance.now() - sessionStartedAt) / 1000,
          event: structuredClone(event),
          window: { ...windowFacts },
        });
        break;
      case "visibility":
        report.inputEvents.visibilityChanged++;
        break;
      case "redraw":
        break;
    }
  }
};

const startup = createNativeSponzaStartup(requestedMode, sessionStartedAt);
try {
  startup.begin('catalog');
  const catalogBytes = await readFile(report.catalogPath);
  report.catalogSha256 = sha256(catalogBytes);
  startup.finish('catalog');
  startup.begin('renderer');
  nativeWindow = createNativeWindow({ title: "ForgeAX Native Sponza GI", width, height }).unwrap();
  installNavigatorGpu(nativeWindow.gpu).unwrap();
  let rendererRhi = nativeWindow.rhi;
  if (captureRhiAfterReadyFrames > 0) {
    const recorder = attachRecorder({
      rhi: nativeWindow.rhi,
      createShaderModule: nativeWindow.rhi.createShaderModule,
      createShaderModuleImmediate: nativeWindow.rhi.createShaderModuleImmediate,
    });
    if (recorder.ok === false)
      throw new Error(`cannot attach native RHI recorder: ${JSON.stringify(recorder.error)}`);
    nativeRhiCapture = createNativeSponzaCapture(recorder.value, {
      outputPath: rhiCaptureFile,
      snapshotTimeoutMs: 30_000,
      byteBudget: captureRhiBudgets.byteBudget,
      maxResourceBytes: captureRhiBudgets.maxResourceBytes,
    });
    const recordedRhi = /** @type {typeof import('@forgeax/engine-rhi-webgpu').rhi} */ (
      /** @type {unknown} */ (nativeRhiCapture.rhi)
    );
    if (
      typeof recordedRhi.createShaderModule !== "function" ||
      typeof recordedRhi.createShaderModuleImmediate !== "function"
    )
      throw new Error("the RHI Debug wrapper did not preserve the native shader factories");
    rendererRhi = recordedRhi;
  }
  const adapter = await nativeWindow.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) throw new Error("native window has no compatible high-performance adapter");
  if (adapter.isFallbackAdapter)
    throw new Error("native Sponza requires a non-fallback hardware adapter");

  const { url: shaderManifestUrl, ...shaderManifestFacts } = await gi.engineManifestDetails(dist, option('shader-manifest', undefined));
  report.shaderManifest = shaderManifestFacts;
  const runtimeModuleSpecifiers = {
    engineRuntime: "@forgeax/engine-runtime",
    rhiDebug: "@forgeax/engine-rhi-debug",
    nativeRhi: "@forgeax/engine-rhi-wgpu-native",
    engineRender: "@forgeax/engine-render",
    shaderPlugin: "@forgeax/engine-vite-plugin-shader",
  };
  report.runtimeModules = {};
  for (const [name, specifier] of Object.entries(runtimeModuleSpecifiers)) {
    const url = import.meta.resolve(specifier);
    if (!url.startsWith("file:"))
      throw new Error(`Runtime module did not resolve to a file: ${specifier}=${url}`);
    const bytes = await readFile(new URL(url));
    report.runtimeModules[name] = {
      specifier,
      url,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  }
  /** @type {Awaited<ReturnType<typeof createNativeSponzaRendererHost>>} */
  debugUi = await createNativeSponzaUi(nativeWindow.facts().unwrap(),
    (command, source) => commands.push({ command, source }), (error) => errors.push(error), true);
  const host = await createNativeSponzaRendererHost(
    nativeWindow.canvas,
    {
      rhi: rendererRhi,
      ui: debugUi.rendererUi,
      ...(gpuTiming === undefined ? {} : { gpuPassTiming: { maxPassesPerFrame: 1024 } }),
    },
    { shaderManifestUrl },
    errors,
  );
  renderer = host.renderer;
  startup.finish('renderer');
  const assets = host.assets;
  const world = host.world;
  const rendererCapabilities = renderer.inspect().capabilities;

  startup.begin('scene-assets');
  const scene = gi.spawnSponza(world, assets, dist, () => {
    startup.finish('scene-assets');
    startup.begin('scene-setup');
  });
  // A single loop owns the borrowed Surface, including these UI-only frames.
  // Do not block on the asset flight or draw concurrent with the scene loop.
  const sceneSettled = scene.then(() => true, () => true);
  do {
    nativeWindow.requestRedraw().unwrap();
    const events = nativeWindow.pollEvents().unwrap();
    const facts = nativeWindow.facts().unwrap();
    recordWindowEvents(events, facts);
    const input = consumeNativeWindowEvents(heldKeys, events);
    if (input.closeRequested || input.pressed.includes('Escape')) {
      stopReason = 'close-requested';
      running = false;
      break;
    }
    if (facts.visible && facts.width > 0 && facts.height > 0) {
      if (events.some((event) => event.kind === 'display'))
        debugUi.ui.resize(facts.width, facts.height, facts.scaleFactor);
      debugUi.updateStartup(startup.snapshot());
      const loading = renderer.draw({
        source: null,
        sampleTimeSeconds: performance.now() / 1000,
      });
      if (loading.ok === false)
        throw new Error(`native startup frame submission failed: ${JSON.stringify(loading.error)}`);
      const loadingCompleted = await loading.value.completed;
      if (loadingCompleted.ok === false)
        throw new Error(`native startup frame completion failed: ${JSON.stringify(loadingCompleted.error)}`);
      report.startupCoverFrames = (report.startupCoverFrames ?? 0) + 1;
      if (report.startupCoverFrames === 1) {
        report.startup = startup.snapshot();
        await flushReport();
      }
    }
  } while (!(await Promise.race([sceneSettled, delay(250, false)])));
  const cameraEntity = await scene;
  spawnSponzaSky(world);
  const initialFacts = nativeWindow.facts().unwrap();
  world
    .set(cameraEntity, CameraComponent, { aspect: initialFacts.width / initialFacts.height })
    .unwrap();
  roamCamera = createRoamCamera(SPONZA.camera);
  let automaticExposure = true;
  let exposureEv = 0;
  const applyExposure = () => {
    const value = perspective({ fov: SPONZA.camera.verticalFov, aspect: initialFacts.width / initialFacts.height,
      exposure: exposureForControls(automaticExposure, exposureEv, !startup.loading) });
    const { exposureMode, exposure, compensationEv, rangeEv, rates } = value;
    // The same filmic shoulder protects direct highlights in both exposure modes.
    world.set(cameraEntity, CameraComponent, {
      exposureMode, exposure, compensationEv, rangeEv, rates, tonemap: TONEMAP_UE_FILMIC,
    }).unwrap();
    report.exposure = { automatic: automaticExposure, ev: exposureEv };
  };
  applyExposure();
  report.camera = { start: cameraSnapshot(roamCamera) };
  const attached = renderer.attach(world);
  if (attached.ok === false)
    throw new Error(`cannot attach native Sponza World: ${JSON.stringify(attached.error)}`);
  const lease = attached.value;
  const baseProfile = gi.directProfile(renderer.inspect().profile);
  let mode = requestedMode;
  let hardwareRayTracing = requestedHardwareRayTracing;
  const profileFor = (next) => {
    if (next === 'off') return baseProfile;
    const tier = next === 'screen-probe' ? screenProbeTier : 'medium';
    const resolved = resolveDiffuseGiTier(tier, tierSceneFor(SPONZA), rendererCapabilities).unwrap();
    const diffuseGi = resolved.profile.diffuseGi;
    const profile = { ...baseProfile, ...resolved.profile };
    if (diffuseGi === undefined || !('field' in diffuseGi)) return profile;
    const selected = { ...diffuseGi, field: { ...diffuseGi.field, hardwareRayTracing } };
    if (selected.gather !== 'screen-probe') return { ...profile, diffuseGi: selected };
    const {
      irradiance: _irradiance, integration: _integration, interpolation, shortRangeAoMode, ...probeDefaults
    } = selected.probes;
    return { ...profile, diffuseGi: {
      ...selected,
      probes: {
        ...probeDefaults,
        ...(probeIrradiance !== 'directional' ? { irradiance: probeIrradiance } : {}),
        ...(probeIntegration === 'screen-space'
          ? {
              integration: probeIntegration,
              ...(interpolation === undefined ? {} : { interpolation }),
              ...(shortRangeAoMode === undefined ? {} : { shortRangeAoMode }),
            }
          : {}),
      },
      ...(softwareTracing === 'mesh-df' ? { softwareTracing: {
        nearDistance: 2,
        receiverBiasVoxels: 1,
        expansionVoxels: 0.5,
        maxErrorVoxels: 4,
      } } : {}),
    } };
  };
  const modeWarmupFrames = warmupFrames;
  let lastFrameId;
  const blockSamples = {
    warmup: {
      work: [],
      intervals: [],
      giSubmittedFrames: [],
      firstFrameId: undefined,
      lastFrameId: undefined,
    },
    steady: {
      work: [],
      intervals: [],
      giSubmittedFrames: [],
      firstFrameId: undefined,
      lastFrameId: undefined,
    },
  };
  let lastReadinessKey;
  let lastProgressWriteAt = performance.now();
  let nextFrameAt = performance.now();
  let nextUiUpdateAt = 0;

  const inspectGi = () => inspectNativeSponzaGi(renderer.inspect().diffuseGi);
  const recordFrameReadiness = (receipt, surfaceConfigured) => {
    const diffuseGi = inspectGi();
    const surfacePresentation = evaluateNativeSurfacePresentation(
      receipt.presentation,
      surfaceConfigured,
    );
    const presentationReady = surfacePresentation.ready;
    const giReady =
      mode === "off" || (diffuseGi.state === "ready" && diffuseGi.submittedFrames > 0);
    const qualified = presentationReady && giReady;
    const byMode = (report.frameReadiness.byMode[mode] ??= {
      completed: 0,
      surfaceConfigured: 0,
      presentationReady: 0,
      giReady: 0,
      qualified: 0,
      unqualified: 0,
    });
    byMode.completed++;
    if (surfaceConfigured) byMode.surfaceConfigured++;
    if (presentationReady) byMode.presentationReady++;
    if (giReady) byMode.giReady++;
    if (qualified) byMode.qualified++;
    else byMode.unqualified++;
    const readinessKey = `${mode}|${receipt.presentation}|${surfaceConfigured}|${diffuseGi.state}|${giReady}`;
    if (readinessKey !== lastReadinessKey) {
      report.frameReadiness.transitions.push({
        frameId: receipt.frameId,
        mode,
        presentation: receipt.presentation,
        surfaceConfigured,
        diffuseGi,
        qualified,
      });
      lastReadinessKey = readinessKey;
    }
    return {
      diffuseGi,
      presentationReady,
      invalidReadySurface: surfacePresentation.invalid,
      qualified,
    };
  };
  const setMode = (next, source, force = false) => {
    if (next === mode && !force) return;
    const profile = profileFor(next);
    const result = renderer.setProfile(profile);
    if (result.ok === false)
      throw new Error(`cannot select ${next} GI: ${JSON.stringify(result.error)}`);
    flushBlock("warmup", false);
    flushBlock("steady", false);
    mode = next;
    readyFramesForMode = 0;
    lastQualifiedCompletedAt = undefined;
    for (const phase of Object.values(blockSamples)) {
      phase.work.length = 0;
      phase.intervals.length = 0;
      phase.giSubmittedFrames.length = 0;
      phase.firstFrameId = undefined;
      phase.lastFrameId = undefined;
    }
    const diffuseGiState = inspectGi();
    report.modeChanges.push({
      at: new Date().toISOString(),
      frameId: lastFrameId,
      mode,
      source,
      hardwareRayTracing,
      diffuseGi: diffuseGiState,
    });
    console.log(`[native-sponza] GI ${mode}; ${JSON.stringify(diffuseGiState)}`);
  };
  const profileResult = renderer.setProfile(profileFor(mode));
  if (profileResult.ok === false)
    throw new Error(`cannot select initial ${mode} GI: ${JSON.stringify(profileResult.error)}`);
  startup.finish('scene-setup');

  const surfaceContext = nativeWindow.canvas.getContext("webgpu");
  let surfaceSnapshot;
  report.adapter = {
    surfaceCompatibleRequest: {
      info: adapter.info,
      fallback: adapter.isFallbackAdapter,
      features: [...adapter.features].sort(),
    },
    rendererDevice: undefined,
  };
  report.renderer = {
    backendKind: rendererCapabilities.backendKind,
    initialMode: mode,
    rayQuery: rendererCapabilities.rayQuery,
    display: initialFacts,
    surface: {
      state: "awaiting-first-completed-frame-configuration",
      supportedTextureUsages: surfaceContext?.supportedTextureUsages,
      supportedAlphaModes: [...(surfaceContext?.supportedAlphaModes ?? [])],
      observedWindowExtent: {
        width: initialFacts.width,
        height: initialFacts.height,
        scaleFactor: initialFacts.scaleFactor,
      },
    },
    surfaceConfiguredFrameId: undefined,
  };
  report.status = "running";
  report.modeChanges.push({
    at: new Date().toISOString(),
    mode,
    source: "startup",
    diffuseGi: inspectGi(),
  });
  await flushReport();
  console.log(
    `[native-sponza] compatible adapter request ${adapter.info.device} (${adapter.info.vendor}), Ray Query supported=${rendererCapabilities.rayQuery.supported}`,
  );
  console.log(`[native-sponza] catalog ${report.catalogPath}`);
  console.log(`[native-sponza] ${report.controls}`);
  console.log(`[native-sponza] evidence ${outputFile}`);

  const handleInput = (input) => {
    if (input.closeRequested) {
      stopReason ??= "close-requested";
      running = false;
    }
    if (input.surfaceLost) throw new Error("native presentation surface was lost");
    if (input.displayChanged) {
      const facts = nativeWindow.facts().unwrap();
      if (facts.width > 0 && facts.height > 0)
        world.set(cameraEntity, CameraComponent, { aspect: facts.width / facts.height }).unwrap();
      if (facts.width > 0 && facts.height > 0) debugUi.ui.resize(facts.width, facts.height, facts.scaleFactor);
    }
    for (const key of input.pressed) {
      if (key === "Escape") {
        stopReason ??= "escape";
        running = false;
      }
    }
  };

  const flushBlock = (phaseName, complete = true) => {
    const samples = blockSamples[phaseName];
    if (samples.work.length === 0) return;
    const submittedFrames = samples.giSubmittedFrames;
    report.frameBlocks.push({
      mode,
      phase: phaseName,
      complete: complete && samples.work.length === BLOCK_FRAMES,
      firstFrameId: samples.firstFrameId,
      lastFrameId: samples.lastFrameId,
      frameCount: samples.work.length,
      work: summary(samples.work),
      completionInterval: summary(samples.intervals),
      readiness: {
        presentation: "ready",
        surfaceConfigured: true,
        surfaceConfiguredFrameId: report.renderer.surfaceConfiguredFrameId,
        diffuseGiState: mode === "off" ? "off" : "ready",
        diffuseGiSubmittedFrames: {
          first: submittedFrames[0],
          last: submittedFrames.at(-1),
          minimum: Math.min(...submittedFrames),
          maximum: Math.max(...submittedFrames),
        },
      },
    });
    samples.work.length = 0;
    samples.intervals.length = 0;
    samples.giSubmittedFrames.length = 0;
    samples.firstFrameId = undefined;
    samples.lastFrameId = undefined;
  };

  let previousUpdate = performance.now();
  let sceneDrawStarted = false;
  process.on("SIGINT", () => {
    stopReason ??= "sigint";
    running = false;
  });
  while (running) {
    if (progressWriteFailure !== undefined) throw progressWriteFailure.error;
    if (performance.now() - sessionStartedAt >= durationSeconds * 1000) {
      stopReason = "duration-limit";
      break;
    }
    if (totalCompletedFrames >= maxFrames) {
      stopReason = "max-frames-limit";
      break;
    }
    nativeWindow.requestRedraw().unwrap();
    const events = nativeWindow.pollEvents().unwrap();
    const factsForInput = nativeWindow.facts().unwrap();
    // Native display events carry only their kind. Reuse the existing facts
    // query to associate each with this poll batch, not invented event dimensions.
    recordWindowEvents(events, factsForInput);
    const look = { x: 0, y: 0 };
    const input = consumeNativeWindowEvents(heldKeys, events, (event) => {
      if (event.kind.startsWith('pointer-'))
        report.inputEvents[event.kind] = (report.inputEvents[event.kind] ?? 0) + 1;
      if (event.button === 'right' && event.kind === 'pointer-down') report.mouseLook.rightDown++;
      if (event.button === 'right' && event.kind === 'pointer-up') report.mouseLook.rightUp++;
      if (event.kind === 'display' && factsForInput.width > 0 && factsForInput.height > 0)
        debugUi.ui.resize(factsForInput.width, factsForInput.height, factsForInput.scaleFactor);
      const delta = consumeNativePointerEvents(pointerState, [event], debugUi.ui.input, factsForInput.scaleFactor);
      look.x += delta.x;
      look.y += delta.y;
      if (event.kind === 'key-down' || event.kind === 'key-up') {
        const key = ({ Tab: 'Tab', Enter: 'Enter', Space: ' ' })[event.code];
        if (key) debugUi.ui.input.key({ type: event.kind === 'key-down' ? 'keydown' : 'keyup',
          key, code: event.code, repeat: event.repeat,
          shiftKey: heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight') });
        if (event.kind === 'key-down' && !event.repeat) {
          const command = commandForKey(event.code);
          if (command !== undefined) commands.push({ command, source: event.code });
        }
      }
    });
    if (startup.loading) {
      if (input.closeRequested || input.pressed.includes('Escape')) {
        stopReason = 'close-requested';
        running = false;
      }
      heldKeys.clear();
      commands.length = 0;
    } else {
      handleInput(input);
    }
    for (const { command, source } of commands.splice(0)) {
      if (validModes.has(command)) setMode(command, source);
      else if (command === 'toggle-hardware') {
        hardwareRayTracing = !hardwareRayTracing;
        setMode(mode, source, true);
      }
      else if (command === 'reset-camera') {
        roamCamera = createRoamCamera(SPONZA.camera);
        world.set(cameraEntity, Transform, cameraTransform(roamCameraPose(roamCamera))).unwrap();
      } else {
        if (command === 'toggle-exposure') automaticExposure = !automaticExposure;
        if (command === 'exposure-up') exposureEv = Math.min(8, exposureEv + 0.5);
        if (command === 'exposure-down') exposureEv = Math.max(-8, exposureEv - 0.5);
        applyExposure();
      }
      report.debugCommands.push({ frameId: lastFrameId, command, source });
      nextUiUpdateAt = 0;
    }
    if (!running) break;
    const display = nativeWindow.facts().unwrap();
    if (!display.visible || display.width === 0 || display.height === 0) {
      await delay(50);
      previousUpdate = performance.now();
      continue;
    }

    const now = performance.now();
    const deltaSeconds = Math.min(Math.max((now - previousUpdate) / 1000, 0), 0.05);
    previousUpdate = now;
    const nextCamera = advanceRoamCamera(roamCamera, heldKeys, deltaSeconds, look);
    if (look.x !== 0 || look.y !== 0) {
      report.mouseLook.appliedBatches++;
      report.mouseLook.logicalDeltaX += look.x;
      report.mouseLook.logicalDeltaY += look.y;
    }
    if (nextCamera !== roamCamera) {
      cameraTravelMeters += Math.hypot(
        nextCamera.origin[0] - roamCamera.origin[0],
        nextCamera.origin[1] - roamCamera.origin[1],
        nextCamera.origin[2] - roamCamera.origin[2],
      );
      roamCamera = nextCamera;
      /** @type {import('../src/scenes.ts').GiCamera} */
      const cameraPose = roamCameraPose(roamCamera);
      world.set(cameraEntity, Transform, cameraTransform(cameraPose)).unwrap();
    }
    world.update(deltaSeconds).unwrap();
    propagateTransforms(world).unwrap();
    if (now >= nextUiUpdateAt) {
      if (startup.loading) debugUi.updateStartup(startup.snapshot());
      const inspection = renderer.inspect();
      const gi = inspectNativeSponzaGi(inspection.diffuseGi);
      debugUi.update({ mode, automatic: automaticExposure, ev: exposureEv,
        giState: gi.state, fieldState: gi.fieldState,
        hardwareRayTracing, traversal: gi.traversal, traversalFallback: gi.traversalFallback,
        exposureState: automaticExposure ? (inspection.output.autoExposure?.actualState ?? 'preparing') : 'manual' });
      nextUiUpdateAt = now + 250;
    }

    const captureStart = await nativeRhiCapture?.beforeNextFrame();
    if (captureStart !== undefined) {
      report.rhiCapture = { ...report.rhiCapture, ...captureStart };
      await flushReport();
    }

    if (!sceneDrawStarted) {
      sceneDrawStarted = true;
      startup.beginSceneFrames();
    }
    const drawStarted = performance.now();
    const submitted = renderer.draw({
      source: lease,
      geometryLane: "direct",
      sampleTimeSeconds: drawStarted / 1000,
    });
    if (submitted.ok === false)
      throw new Error(`native draw failed: ${JSON.stringify(submitted.error)}`);
    const receipt = submitted.value;
    const completed = await receipt.completed;
    if (completed.ok === false)
      throw new Error(
        `native frame ${receipt.frameId} did not complete: ${JSON.stringify(completed.error)}`,
      );
    const completedAt = performance.now();
    const captured = await nativeRhiCapture?.afterFrame(receipt.frameId, mode);
    if (captured !== undefined) {
      report.rhiCapture = captured;
      await flushReport();
      console.log(`[native-sponza] RHI capture ${captured.status}; ${JSON.stringify(captured)}`);
    }
    lastFrameId = receipt.frameId;
    totalCompletedFrames++;
    report.completedFrames = totalCompletedFrames;
    lastCompletedFrameId = receipt.frameId;
    const workMs = collectTiming ? completedAt - drawStarted : undefined;
    const currentWindowFacts = nativeWindow.facts().unwrap();
    const observedSurface = captureNativeSurfaceAfterFrame(
      surfaceContext,
      adapter,
      receipt.frameId,
      currentWindowFacts,
    );
    if (observedSurface !== undefined) {
      surfaceSnapshot ??= observedSurface;
      report.adapter.rendererDevice = surfaceSnapshot.rendererDevice;
      report.renderer.surface = surfaceSnapshot.surface;
      report.renderer.surfaceConfiguredFrameId ??= receipt.frameId;
    } else {
      report.renderer.surface = {
        state: "unconfigured-after-completed-frame",
        lastObservedFrameId: receipt.frameId,
      };
    }
    // Keep surface/surfaceConfiguredFrameId as the initial configured identity.
    // Current facts reuse this frame's observation and the same native query.
    report.renderer.currentSurface = observedSurface?.surface ?? {
      state: "unconfigured-after-completed-frame",
      lastObservedFrameId: receipt.frameId,
    };
    report.renderer.currentSurfaceFrameId = receipt.frameId;
    report.renderer.currentWindow = currentWindowFacts;
    const frameReadiness = recordFrameReadiness(receipt, observedSurface !== undefined);
    if (startup.loading) {
      startup.observeFrame(frameReadiness, drawStarted, completedAt);
      if (!startup.loading) {
        // The first visible view uses its own histogram. The exposure owner
        // starts a new history when the Camera enters UE adaptation.
        if (automaticExposure) applyExposure();
        debugUi.updateStartup(startup.snapshot());
      }
    }
    if (frameReadiness.presentationReady) report.completedReadyFrames++;
    const completedIntervalMs =
      lastCompletedAt === undefined ? null : completedAt - lastCompletedAt;
    lastCompletedAt = completedAt;
    let qualifiedIntervalMs = null;
    if (frameReadiness.qualified && lastQualifiedCompletedAt !== undefined)
      qualifiedIntervalMs = completedAt - lastQualifiedCompletedAt;
    frameSamples.push({
      frameId: receipt.frameId,
      mode,
      presentation: receipt.presentation,
      surfaceConfigured: observedSurface !== undefined,
      surfaceConfiguredFrameId: report.renderer.surfaceConfiguredFrameId,
      presentationReady: frameReadiness.presentationReady,
      diffuseGi: frameReadiness.diffuseGi,
      qualifiedForTiming: collectTiming && frameReadiness.qualified,
      workMs,
      completedIntervalMs: collectTiming ? completedIntervalMs : undefined,
      qualifiedIntervalMs: collectTiming ? qualifiedIntervalMs : undefined,
    });
    if (frameReadiness.qualified) {
      report.qualifiedFrames++;
      lastQualifiedCompletedAt = completedAt;
      readyFramesForMode++;
      if (
        gpuTiming !== undefined &&
        gpuTiming.samples.length < gpuTiming.sampleLimit &&
        readyFramesForMode > modeWarmupFrames &&
        readyFramesForMode % GPU_TIMING_SAMPLE_STRIDE === 0
      ) {
        const observed = await renderer.observe(receipt, { include: ['timings'] });
        const timings = observed.ok ? observed.value.timings : undefined;
        const frame = timings?.status === 'complete' || timings?.status === 'partial'
          ? timings.frame
          : undefined;
        const sameFrame = frame?.frameId === receipt.frameId &&
          frame.deviceGeneration === receipt.deviceGeneration;
        // The envelope includes measured inter-pass gaps. It has no outer GPU timestamps.
        const intervals = sameFrame
          ? summarizeGpuPassTimingIntervals(frame.passes, frame.timestampPeriodNanoseconds)
          : undefined;
        gpuTiming.samples.push({
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          mode,
          traversal: frameReadiness.diffuseGi.traversal,
          sameFrame,
          ...(observed.ok === false ? { error: observed.error } : { timings }),
          intervals,
        });
      }
      if (nativeRhiCapture?.idle === true && readyFramesForMode >= captureRhiAfterReadyFrames) {
        report.rhiCapture = nativeRhiCapture.requestAfterCompletedFrame(receipt.frameId, mode);
        await flushReport();
        console.log(`[native-sponza] RHI capture armed after ready frame ${receipt.frameId}`);
      }
      const phaseName = readyFramesForMode <= modeWarmupFrames ? "warmup" : "steady";
      const samples = blockSamples[phaseName];
      samples.firstFrameId ??= receipt.frameId;
      samples.lastFrameId = receipt.frameId;
      if (collectTiming) samples.work.push(workMs);
      samples.giSubmittedFrames.push(frameReadiness.diffuseGi.submittedFrames);
      if (qualifiedIntervalMs !== null) samples.intervals.push(qualifiedIntervalMs);
      if (samples.work.length >= BLOCK_FRAMES) flushBlock(phaseName);
    } else {
      report.unqualifiedCompletedFrames++;
    }
    if (progressWrite === undefined && completedAt - lastProgressWriteAt >= 1000) {
      report.currentFrame = {
        frameId: receipt.frameId,
        mode,
        presentation: receipt.presentation,
        surfaceConfigured: observedSurface !== undefined,
        presentationReady: frameReadiness.presentationReady,
        completedReadyFrames: report.completedReadyFrames,
        diffuseGi: frameReadiness.diffuseGi,
        qualifiedForTiming: collectTiming && frameReadiness.qualified,
      };
      if (report.camera !== undefined) {
        report.camera.current = cameraSnapshot(roamCamera);
        report.camera.pathLengthMeters = cameraTravelMeters;
      }
      report.elapsedSeconds = (completedAt - sessionStartedAt) / 1000;
      report.startup = startup.snapshot();
      report.debugUi = debugUi.snapshot();
      report.hardwareRayTracing = { allowed: hardwareRayTracing, actual: inspectGi() };
      report.exposure.inspection = renderer.inspect().output.autoExposure;
      progressWrite = atomicWrite(report)
        .catch((error) => { progressWriteFailure = { error }; })
        .finally(() => { progressWrite = undefined; });
      lastProgressWriteAt = completedAt;
    }
    if (frameReadiness.invalidReadySurface)
      throw new Error(
        `native Renderer reported frame ${receipt.frameId} ready without configuring the real window Surface`,
      );
    if (errors.length > 0)
      throw new Error(
        `Renderer reported ${errors.length} error(s): ${JSON.stringify(errors.at(-1))}`,
      );

    nextFrameAt += FRAME_TARGET_MS;
    if (nextFrameAt < completedAt) nextFrameAt = completedAt;
    const waitMs = nextFrameAt - performance.now();
    if (waitMs > FRAME_PACING_EARLY_TOLERANCE_MS) await delay(waitMs);
  }

  flushBlock("warmup", false);
  flushBlock("steady", false);
  if (report.completedReadyFrames < 60)
    throw new Error(
      `native Sponza closed with ${report.completedReadyFrames} completed presentation-ready frames; requires 60`,
    );
  stopReason ??= "requested-stop";
  report.stopReason = stopReason;
  report.elapsedSeconds = (performance.now() - sessionStartedAt) / 1000;
  report.status = "closed";
} catch (error) {
  startup.stop('failed');
  report.status = "failed";
  report.error = { message: String(error), stack: error?.stack };
  report.stopReason = "error";
  throw error;
} finally {
  startup.stop('stopped');
  report.startup = startup.snapshot();
  startup.dispose();
  const teardownErrors = [];
  try {
    const disposed = await renderer?.dispose();
    if (disposed?.ok === false)
      teardownErrors.push({ step: "renderer.dispose", error: disposed.error });
  } catch (error) {
    teardownErrors.push(String(error));
  }
  try {
    debugUi?.ui.dispose();
  } catch (error) {
    teardownErrors.push(String(error));
  }
  if (nativeRhiCapture !== undefined) {
    try {
      const captureCleanup = await nativeRhiCapture.dispose();
      const captureStatus = report.rhiCapture?.status;
      if (
        typeof captureStatus === "string" &&
        ["waiting-for-qualified-frame", "armed", "recording"].includes(captureStatus)
      )
        report.rhiCapture = captureCleanup;
    } catch (error) {
      teardownErrors.push(String(error));
    }
  }
  if (nativeWindow !== undefined) {
    try {
      const closed = nativeWindow.close();
      if (closed.ok === false) teardownErrors.push(JSON.stringify(closed.error));
    } catch (error) {
      teardownErrors.push(String(error));
    }
  }
  if (roamCamera !== undefined) {
    const end = cameraSnapshot(roamCamera);
    const start = report.camera?.start;
    report.camera = {
      ...report.camera,
      end,
      pathLengthMeters: cameraTravelMeters,
      netDisplacementMeters:
        start === undefined
          ? undefined
          : Math.hypot(
              end.origin[0] - start.origin[0],
              end.origin[1] - start.origin[1],
              end.origin[2] - start.origin[2],
            ),
      yawDeltaRadians: start === undefined ? undefined : end.yawRadians - start.yawRadians,
      pitchDeltaRadians: start === undefined ? undefined : end.pitchRadians - start.pitchRadians,
    };
  }
  await progressWrite;
  if (progressWriteFailure !== undefined) {
    teardownErrors.push({ step: "progressReport", error: String(progressWriteFailure.error) });
  }
  report.finishedAt = new Date().toISOString();
  report.elapsedSeconds = (performance.now() - sessionStartedAt) / 1000;
  report.teardownErrors = teardownErrors;
  if (teardownErrors.length > 0) {
    report.status = "failed";
    process.exitCode = 1;
  }
  try {
    const frameBytes = Buffer.from(`${JSON.stringify(frameSamples, null, 2)}\n`);
    await writeFile(`${frameSamplesFile}.tmp`, frameBytes);
    await rename(`${frameSamplesFile}.tmp`, frameSamplesFile);
    report.frameSamples = {
      path: frameSamplesFile,
      count: frameSamples.length,
      bytes: frameBytes.byteLength,
      sha256: sha256(frameBytes),
      allCompletedFrames: frameSamples.length === report.completedFrames,
      workMs: collectTiming ? summary(frameSamples.map((sample) => sample.workMs)) : undefined,
      completedIntervalMs: !collectTiming ? undefined : summary(
        frameSamples.map((sample) => sample.completedIntervalMs).filter((value) => value !== null),
      ),
      qualifiedIntervalMs: !collectTiming ? undefined : summary(
        frameSamples.map((sample) => sample.qualifiedIntervalMs).filter((value) => value !== null),
      ),
    };
  } catch (error) {
    report.status = "failed";
    report.frameSamplesError = { message: String(error), stack: error?.stack };
    process.exitCode = 1;
  }
  await flushReport();
}
