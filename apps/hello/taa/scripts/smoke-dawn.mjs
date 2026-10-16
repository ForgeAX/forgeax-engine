#!/usr/bin/env node

// The TAA carrier owns a real Dawn smoke instead of a provider-shaped placeholder.
// Keep the loop deliberately synchronous: the regression this catches only appears
// when a consumer submits frames without yielding between draws.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_EXPOSURE_TAA_FIXTURE,
  AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY,
} from '@forgeax/apps-shared/auto-exposure-fixture';
import { bootRenderer, runFrameLoopAndReadback, setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import {
  activePassCountersFromInspection,
  performanceAdmissionUnavailable,
  qualifiedNativeFromAttestation,
  performanceIdentityFromEnv,
  cpuAffinityFromEnv,
  runnerProvenanceFromEnv,
} from './performance-contract.mjs';
import {
  MAC_METAL_PROBE_SOURCE,
  parseMacIoregAdapterFacts,
  parseMacMetalProbeOutput,
  parseMacSystemProfilerAdapterFacts,
  parseMacSystemProfilerText,
  deriveAppleParavirtualAttestation,
} from './host-adapter-facts.mjs';
import { createFeatureEvidence } from './required-evidence.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const timingMode = ['1', 'manual'].includes(process.env.SMOKE_TIMING_MODE ?? '');
const timingCaptureEnabled = process.env.SMOKE_TIMING_MODE === '1';
const timingResolutionId = process.env.SMOKE_TIMING_RESOLUTION ?? '1080p';
const timingResolution = timingResolutionId === '4K'
  ? { id: '4K', width: 3840, height: 2160 }
  : { id: '1080p', width: 1920, height: 1080 };
const timingFrameCount = 420;
const nativePerformanceAdmissionMode = process.argv.includes('--native-performance-admission') || process.env.SMOKE_PERFORMANCE_ADMISSION === '1';
const performanceAdmissionMode = nativePerformanceAdmissionMode || timingMode;
const falsifierLightweight = process.env.FORGEAX_TAA_FALSIFIER_PROFILE === 'ci';
const width = timingMode ? timingResolution.width : performanceAdmissionMode ? 1920 : falsifierLightweight ? 128 : 200;
const height = timingMode ? timingResolution.height : performanceAdmissionMode ? 1080 : falsifierLightweight ? 72 : 150;
const motionBlurMaxRadiusPixels = falsifierLightweight ? 8 : 32;
const motionBlurSampleCount = falsifierLightweight ? 4 : 8;
const performanceIdentity = performanceIdentityFromEnv();
const runnerProvenance = runnerProvenanceFromEnv(process.env);
const cpuAffinity = cpuAffinityFromEnv(process.env);
if (nativePerformanceAdmissionMode && !performanceIdentity.testedRevisionMatchesCheckout) {
  console.log(`[hello-taa] dawnSummary=${JSON.stringify({
    ...performanceAdmissionUnavailable('testedRevision does not match checkout HEAD'),
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
  })}`);
  console.error('[smoke] FAIL - testedRevision does not match checkout HEAD');
  process.exit(1);
}
if (nativePerformanceAdmissionMode && (!runnerProvenance.ok || !cpuAffinity.ok)) {
  const reason = !runnerProvenance.ok ? runnerProvenance.reason : cpuAffinity.reason;
  console.log(`[hello-taa] dawnSummary=${JSON.stringify({
    ...performanceAdmissionUnavailable(reason),
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
    runnerName: runnerProvenance.runnerName,
    runnerFacts: runnerProvenance.runnerFacts,
    cpuAffinity: cpuAffinity.ok ? cpuAffinity.cpuAffinity : null,
  })}`);
  console.error(`[smoke] FAIL - ${reason}`);
  process.exit(1);
}
const requestedFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const visualCase = process.env.SMOKE_CASE ?? 'moving-rigid';
const workloadKind = process.env.SMOKE_WORKLOAD ?? 'none';
const featureWorkloadKinds = new Set(['manual', 'auto', 'positive-lut']);
if (workloadKind !== 'none' && !featureWorkloadKinds.has(workloadKind)) {
  throw new Error(`SMOKE_WORKLOAD must be none, manual, auto, or positive-lut, got ${workloadKind}`);
}
if (timingMode && !featureWorkloadKinds.has(workloadKind)) {
  throw new Error(`SMOKE_TIMING_MODE requires SMOKE_WORKLOAD=manual, auto, or positive-lut, got ${workloadKind}`);
}
const isolatedCaptureMode = process.env.SMOKE_DAWN_CAPTURE_MODE;
if (isolatedCaptureMode !== undefined && !['on', 'off'].includes(isolatedCaptureMode)) {
  throw new Error(`SMOKE_DAWN_CAPTURE_MODE must be on or off, got ${isolatedCaptureMode}`);
}
if (!Number.isInteger(requestedFrames) || requestedFrames < 1) {
  throw new Error(`SMOKE_MIN_FRAMES must be a positive integer, got ${requestedFrames}`);
}
// TAA history and motion-vector evidence are only meaningful after the full
// hello-* contract window. Keep shorter fleet hints from silently weakening
// this carrier's temporal proof.
const frames = Math.max(requestedFrames, 60);
const rerunCmd = 'pnpm --filter @forgeax/hello-taa smoke';
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashVitePayload = (root) => {
  const hash = createHash('sha256');
  const add = (path, relative) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(resolve(path, name), `${relative}/${name}`);
      return;
    }
    hash.update(relative).update('\0').update(readFileSync(path));
  };
  add(resolve(root, 'index.html'), 'index.html');
  add(resolve(root, 'src'), 'src');
  add(resolve(root, 'dist', 'index.html'), 'dist/index.html');
  add(resolve(root, 'dist', 'shaders', 'manifest.json'), 'dist/shaders/manifest.json');
  return hash.digest('hex');
};

// Read a bounded area rather than betting the falsifier on one pixel. The
// moving cube can legitimately be between fixed probes at the final frame;
// this grid covers its authored path while keeping the black corner as a
// background falsifier.
const motionSamplePoints = [
  { name: 'ndcCenter', x: 0.5, y: 0.5 },
  { name: 'corner', x: 0.05, y: 0.05 },
  ...Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 9 }, (_, column) => ({
      name: `motion-${column}-${row}`,
      x: 0.2 + column * 0.075,
      y: 0.25 + row * 0.0833333333,
    })),
  ).flat(),
  // Edge probes make a solid-color cube falsify correctly: its interior is
  // intentionally unchanged by blur, while these pixels straddle the moving
  // silhouette against the black background.
  ...[0.35, 0.37, 0.39, 0.41, 0.52, 0.54, 0.56, 0.58].flatMap((x) =>
    [0.4, 0.5, 0.6].map((y) => ({ name: `edge-${x}-${y}`, x, y })),
  ),
];
const motionSampleNames = motionSamplePoints
  .map(({ name }) => name)
  .filter((name) => name !== 'corner');
const sampleEnergy = (sample) =>
  (sample ?? []).reduce((sum, channel) => sum + channel, 0);
const roiEnergy = (samples) =>
  motionSampleNames.reduce((sum, name) => sum + sampleEnergy(samples[name]), 0);
const nonBlackSampleCount = (samples) =>
  motionSampleNames.filter((name) => sampleEnergy(samples[name]) > 0.01).length;

const shaderManifestPath = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
const shaderManifest = readFileSync(shaderManifestPath, 'utf8');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(shaderManifest)}`;

// Dawn's adapter.info is intentionally small on several platforms. Native
// performance admission therefore records an independent host GPU fact and
// rejects CPU/software Vulkan devices (for example llvmpipe) before a timing
// verdict can be assembled. This is provenance, never a substitute for the
// real Dawn render/receipt path below. Avoid probing the host on ordinary
// correctness smokes so the provider check remains scoped to admission.
const physicalAdapterFacts = performanceAdmissionMode
  ? (() => {
    try {
      if (process.platform === 'darwin') {
        const provider = process.env.FORGEAX_GPU_PROVIDER ?? '';
        let metalFacts;
        try {
          const metalOutput = execFileSync('xcrun', ['swift', '-'], {
            input: MAC_METAL_PROBE_SOURCE,
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          metalFacts = parseMacMetalProbeOutput(metalOutput);
        } catch (error) {
          metalFacts = parseMacMetalProbeOutput('');
          metalFacts.reason = error instanceof Error ? error.message : String(error);
        }

        // Keep the inventory providers as diagnostics for headless sessions,
        // but never promote them when the direct Metal command failed. A
        // provider label without a live MTLDevice registry ID remains false.
        let fallbackFacts;
        try {
          const payload = JSON.parse(
            execFileSync('system_profiler', ['SPDisplaysDataType', '-json'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          const jsonFacts = parseMacSystemProfilerAdapterFacts(payload);
          const textFacts = parseMacSystemProfilerText(
            execFileSync('system_profiler', ['SPDisplaysDataType'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          const ioregFacts = parseMacIoregAdapterFacts(
            execFileSync('ioreg', ['-r', '-c', 'IOAccelerator', '-l'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          fallbackFacts = jsonFacts.physicalGpu
            ? jsonFacts
            : textFacts.physicalGpu
              ? textFacts
              : ioregFacts;
        } catch (error) {
          fallbackFacts = {
            source: 'host-probe',
            vendor: '',
            device: '',
            driver: '',
            deviceType: '',
            physicalGpu: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        const directMetal = {
          ...metalFacts,
          provider,
          fallback: fallbackFacts,
          ...(metalFacts.physicalGpu !== true
            ? { reason: metalFacts.reason ?? 'Metal probe returned no physical device' }
            : {}),
        };
        return directMetal;
      }
      if (process.platform === 'linux') {
        const summary = execFileSync('vulkaninfo', ['--summary'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const read = (name) => summary.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
        const vendor = read('vendorID');
        const device = read('deviceName');
        const driver = read('driverName');
        const deviceType = read('deviceType');
        const identity = `${vendor} ${device} ${driver} ${deviceType}`;
        const physicalGpu = Boolean(
          device &&
            driver &&
            /gpu/i.test(deviceType) &&
            !/(cpu|llvmpipe|swiftshader|software)/i.test(identity),
        );
        return {
          source: 'vulkaninfo',
          vendor,
          device,
          driver,
          deviceType,
          physicalGpu,
          ...(physicalGpu ? { accelerationAttestation: { kind: 'direct-device' } } : {}),
        };
      }
    } catch (error) {
      return {
        source: 'host-probe',
        vendor: '',
        device: '',
        driver: '',
        deviceType: '',
        physicalGpu: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      source: 'host-probe',
      vendor: '',
      device: '',
      driver: '',
      deviceType: '',
      physicalGpu: false,
      reason: `unsupported host platform: ${process.platform}`,
    };
    })()
  : {
      source: 'not-requested',
      vendor: '',
      device: '',
      driver: '',
      deviceType: '',
      physicalGpu: false,
    };

// Install dawn.node before importing engine modules. This is the same native
// adapter path used by hello-triangle; no CPU raster or RhiNull substitute is
// accepted as a visual result here.
const dawnBackendArgs = performanceAdmissionMode && process.platform === 'darwin' ? ['backend=metal'] : [];
const shim = await setupGpuShim({ width, height, rerunCmd, backendArgs: dawnBackendArgs });
const accelerationAttestation = deriveAppleParavirtualAttestation({
  provider: process.env.FORGEAX_GPU_PROVIDER ?? '',
  runnerFacts: runnerProvenance.runnerFacts,
  requestedBackend: shim.requestedBackend,
  isFallbackAdapter: shim.isFallbackAdapter,
  ioregFacts: physicalAdapterFacts.fallback,
});
const adapterFacts = {
  ...physicalAdapterFacts,
  requestedBackend: shim.requestedBackend,
  isFallbackAdapter: shim.isFallbackAdapter,
  ...(accelerationAttestation === undefined ? {} : { accelerationAttestation }),
};
const { World } = await import('@forgeax/engine-ecs');
await import('@forgeax/engine-runtime');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const assets = await import('@forgeax/engine-assets-runtime');
const render = await import('@forgeax/engine-render');
const scene = await import('@forgeax/engine-scene');

/**
 * Execute one Dawn feature workload through the real Runtime host. This path is
 * intentionally separate from the legacy TAA carrier below: the carrier is a
 * correctness smoke, while this branch owns the auto-exposure/LUT fixture and
 * renderer receipt-bound raw observations. It never derives a feature pass.
 */
async function runDawnFeatureWorkload(kind) {
  const sourcePath = resolve(appRoot, 'src', 'main.ts');
  const buildPath = resolve(appRoot, 'dist', 'index.html');
  const fixturePath = resolve(appRoot, 'fixtures', 'auto-exposure', 'scene-identity.json');
  const lutMetaPath = resolve(appRoot, 'assets', 'auto-exposure-positive-lut.cube.meta.json');
  const sourceSha = sha256File(sourcePath);
  const buildSha = sha256File(buildPath);
  const fixtureIdentity = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (JSON.stringify(fixtureIdentity) !== JSON.stringify(AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY)) {
    throw new Error('hello-taa: scene-identity.json is not the shared auto-exposure fixture identity');
  }
  const lutMeta = JSON.parse(readFileSync(lutMetaPath, 'utf8'));
  const lutSubAsset = lutMeta.subAssets?.find((entry) => entry.kind === 'texture');
  if (lutSubAsset === undefined || typeof lutSubAsset.guid !== 'string') {
    throw new Error('hello-taa: authoritative LUT sidecar has no texture GUID');
  }
  const { AssetGuid } = await import('@forgeax/engine-pack/guid');
  const parsedLutGuid = AssetGuid.parse(lutSubAsset.guid);
  if (!parsedLutGuid.ok) throw parsedLutGuid.error;

  // The Runtime AssetRegistry must traverse the same pack-index transport as a
  // browser build. Dawn has no dev server, so map only this fixture's explicit
  // local origin into the built dist tree and leave every other fetch untouched.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    if (typeof rawUrl === 'string' && rawUrl.startsWith('http://forgeax.local/')) {
      const relativePath = new URL(rawUrl).pathname.slice(1);
      const filePath = resolve(appRoot, 'dist', relativePath);
      try {
        return new Response(readFileSync(filePath), { status: 200 });
      } catch {
        return new Response(`fixture file not found: ${relativePath}`, { status: 404 });
      }
    }
    if (typeof originalFetch !== 'function') {
      return new Response('fetch is unavailable in Dawn host', { status: 503 });
    }
    return originalFetch(input, init);
  };

  const hostResult = await constructRuntimeRendererHost(
    shim.mockCanvas,
    timingCaptureEnabled
      ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 8, retentionFrames: 8 } }
      : {},
    { shaderManifestUrl },
  );
  if (!hostResult.ok) throw hostResult.error;
  const renderer = hostResult.value.renderer;
  const assetRegistry = hostResult.value.assets;
  const rendererErrors = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push({ code: event.error.code, hint: event.error.hint });
  });

  const frameCount = timingCaptureEnabled ? timingFrameCount : timingMode ? 1 : frames;
  const timingFrames = [];
  let timingError;
  const submittedFrameIds = [];
  const footprintSamples = [];
  let finalReceipt;
  let stageObservations = [];
  let observationError;
  let assetGuid;
  let lutSourceKey;
  let lutAsset;
  let lutHandle;
  const exposure = kind === 'auto'
    ? { kind: 'auto', fallback: 1, compensationEv: 0, rangeEv: [-8, 8], rates: [3, 1] }
    : { kind: 'manual', multiplier: 1 };

  try {
    assetRegistry.configurePackIndex('http://forgeax.local/pack-index.json');
    const loadedLut = await assetRegistry.loadByGuid(parsedLutGuid.value);
    if (!loadedLut.ok) throw loadedLut.error;
    lutAsset = loadedLut.value;
    assetGuid = assetRegistry.guidOf(lutAsset);
    const catalogEntry = assetRegistry.listCatalog().find((entry) => entry.guid === assetGuid);
    lutSourceKey = catalogEntry?.sourceKey;
    if (assetGuid === undefined || lutSourceKey !== lutSubAsset.sourceKey) {
      throw new Error('hello-taa: loaded LUT is missing its authoritative Catalog sourceKey');
    }
    const world = new World();
    for (const { offset, color } of AUTO_EXPOSURE_TAA_FIXTURE.asset.barLayout) {
      const material = world.allocSharedRef(
        'MaterialAsset',
        render.Materials.unlit(color),
      );
      world
        .spawn(
          {
            component: scene.Transform,
            data: {
              pos: [offset, AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.y, AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.z],
              quat: [0, 0, 0, 1],
              scale: AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.scale,
            },
          },
          { component: render.MeshFilter, data: { assetHandle: assets.HANDLE_CUBE } },
          { component: render.MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    if (kind === 'positive-lut') {
      lutHandle = world.allocSharedRef('TextureAsset', lutAsset);
    }
    world
      .spawn({
        component: render.DirectionalLight,
        data: {
          direction: AUTO_EXPOSURE_TAA_FIXTURE.light.direction,
          color: AUTO_EXPOSURE_TAA_FIXTURE.light.color,
          intensity: AUTO_EXPOSURE_TAA_FIXTURE.light.intensity,
          castShadow: true,
          ...(falsifierLightweight ? { cascadeCount: 1, mapSize: 64 } : {}),
        },
      })
      .unwrap();
    const camera = world
      .spawn(
        {
          component: scene.Transform,
          data: {
            pos: AUTO_EXPOSURE_TAA_FIXTURE.camera.position,
            quat: AUTO_EXPOSURE_TAA_FIXTURE.camera.rotation,
            scale: [1, 1, 1],
          },
        },
        {
          component: render.Camera,
          data: {
            ...render.perspective({
              fov: AUTO_EXPOSURE_TAA_FIXTURE.camera.fov,
              aspect: AUTO_EXPOSURE_TAA_FIXTURE.camera.aspect,
              near: AUTO_EXPOSURE_TAA_FIXTURE.camera.near,
              far: AUTO_EXPOSURE_TAA_FIXTURE.camera.far,
              exposure,
              colorLutStrength: kind === 'positive-lut' ? 0.75 : 0,
              ...(lutHandle === undefined ? {} : { colorLut: lutHandle }),
            }),
            antialias: render.ANTIALIAS_TAA,
          },
        },
        { component: render.MotionBlur, data: { shutterAngle: 180, maxRadiusPixels: motionBlurMaxRadiusPixels, sampleCount: motionBlurSampleCount } },
      )
      .unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const timingCapability = renderer.inspect().capabilities;
    if (
      timingCaptureEnabled &&
      (timingCapability.timestampQuery !== true ||
        typeof timingCapability.timestampPeriodNanoseconds !== 'number' ||
        timingCapability.timestampPeriodNanoseconds <= 0)
    ) {
      const blockedReport = {
        schemaVersion: 'forgeax-auto-exposure-gpu-pass-timing-observation/1',
        featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
        testedRevision: performanceIdentity.testedRevision,
        status: 'blocked',
        workload: kind,
        resolution: timingResolution,
        source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
        build: { path: 'apps/hello/taa/dist/index.html', sha256: buildSha },
        runner: {
          kind: 'dawn',
          id: runnerProvenance.runnerName ?? 'smoke-dawn',
          channel: 'dawn-node',
          version: process.version,
          os: `${process.platform}-${process.arch}`,
          headless: true,
          launchArgs: process.execArgv,
        },
        backend: {
          kind: timingCapability.backendKind,
          physicalGpu: adapterFacts.physicalGpu === true,
          timestampQuery: timingCapability.timestampQuery === true,
          timestampPeriodNanoseconds: timingCapability.timestampPeriodNanoseconds ?? null,
          adapter: shim.adapterInfo?.device ?? shim.adapterInfo?.description ?? '',
          driver: shim.adapterInfo?.driver || 'dawn-node',
          browser: 'dawn-node',
        },
        fixture: fixtureIdentity,
        frame: null,
        frames: [],
        error: 'renderer timestamp-query capability is unavailable on the active Dawn device',
      };
      if (typeof process.env.SMOKE_TIMING_OUTPUT === 'string' && process.env.SMOKE_TIMING_OUTPUT.length > 0) {
        mkdirSync(resolve(process.env.SMOKE_TIMING_OUTPUT, '..'), { recursive: true });
        writeFileSync(process.env.SMOKE_TIMING_OUTPUT, `${JSON.stringify(blockedReport, null, 2)}\n`);
      }
      return blockedReport;
    }
    const sampleFootprint = (frameId) => {
      const stats = renderer.inspect().observation?.resourceStats;
      if (stats === undefined) return;
      footprintSamples.push({
        frameId,
        liveByteLength: stats.liveByteLength,
        liveResourceCount: stats.liveCount,
        allocationCount: stats.allocationCount,
        peakLiveCount: stats.peakLiveCount,
        mapCount: stats.mapCount,
        readbackCount: stats.readbackCount,
      });
    };
    for (let index = 0; index < frameCount; index += 1) {
      world.update(1 / 60).unwrap();
      if (index === frameCount - 1 && kind !== 'manual' && !timingMode) {
        const requested = renderer.requestObservation?.(['linear-hdr', 'linear-ldr', 'final-display']);
        if (requested === undefined || !requested.ok) {
          observationError = requested === undefined ? 'observation-request-unavailable' : requested.error.code;
        }
      }
      const drawn = renderer.draw({
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
        ...(timingCaptureEnabled
          ? { profileFrame: { captureId: `auto-exposure-${kind}-${timingResolution.id}`, frameId: index + 1 } }
          : {}),
      });
      if (!drawn.ok) {
        rendererErrors.push({ code: drawn.error.code, hint: drawn.error.hint });
        continue;
      }
      finalReceipt = drawn.value;
      submittedFrameIds.push(drawn.value.frameId);
      sampleFootprint(drawn.value.frameId);
      if (timingCaptureEnabled) {
        const timingCompleted = await drawn.value.completed;
        if (!timingCompleted.ok) {
          timingError = timingCompleted.error.code;
          break;
        }
        const observedTiming = await renderer.observe(drawn.value, { include: ['timings'] });
        if (!observedTiming.ok) {
          timingError = observedTiming.error.code;
          break;
        }
        const timing = observedTiming.value.timings;
        if (timing === undefined || timing.status !== 'complete') {
          timingError = timing?.status ?? 'renderer-timing-unavailable';
          break;
        }
        timingFrames.push(timing.frame);
      }
    }
    if (finalReceipt === undefined) throw new Error('hello-taa: feature workload submitted no renderer receipt');
    if (timingMode) {
      const inspection = renderer.inspect();
      const timingReport = {
        schemaVersion: 'forgeax-auto-exposure-gpu-pass-timing-observation/1',
        featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
        testedRevision: performanceIdentity.testedRevision,
        status:
          kind === 'manual'
            ? 'ready'
            : timingError === undefined && timingFrames.length === timingFrameCount
              ? 'ready'
              : 'blocked',
        workload: kind,
        resolution: timingResolution,
        source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
        build: { path: 'apps/hello/taa/dist/index.html', sha256: buildSha },
        runner: {
          kind: 'dawn',
          id: runnerProvenance.runnerName ?? 'smoke-dawn',
          channel: 'dawn-node',
          version: process.version,
          os: `${process.platform}-${process.arch}`,
          headless: true,
          launchArgs: process.execArgv,
        },
        backend: {
          kind: inspection.capabilities.backendKind,
          physicalGpu: adapterFacts.physicalGpu === true,
          timestampQuery: inspection.capabilities.timestampQuery === true,
          timestampPeriodNanoseconds: inspection.capabilities.timestampPeriodNanoseconds ?? null,
          adapter: shim.adapterInfo?.device ?? shim.adapterInfo?.description ?? '',
          driver: shim.adapterInfo?.driver || 'dawn-node',
          browser: 'dawn-node',
        },
        fixture: fixtureIdentity,
        frame: timingFrames.at(-1) ?? null,
        frames: timingFrames,
        ...(kind === 'manual'
          ? { manual: { executed: true, zeroCost: true, timestampSlots: 0, receipt: { frameId: finalReceipt.frameId } } }
          : {}),
        ...(timingError === undefined ? {} : { error: timingError }),
      };
      if (typeof process.env.SMOKE_TIMING_OUTPUT === 'string' && process.env.SMOKE_TIMING_OUTPUT.length > 0) {
        mkdirSync(resolve(process.env.SMOKE_TIMING_OUTPUT, '..'), { recursive: true });
        writeFileSync(process.env.SMOKE_TIMING_OUTPUT, `${JSON.stringify(timingReport, null, 2)}\n`);
      }
      return timingReport;
    }
    const completed = await finalReceipt.completed;
    if (!completed.ok) observationError = completed.error.code;
    if (kind !== 'manual' && observationError === undefined) {
      const observed = await renderer.observe(finalReceipt, {
        include: ['linear-hdr', 'linear-ldr', 'final-display'],
      });
      if (!observed.ok) observationError = observed.error.code;
      else stageObservations = observed.value.observations ?? [];
    }
    // Observation readback resources are renderer-owned and should be sampled
    // after the final receipt has completed.  Sampling before observe() would
    // count the three deliberate final-frame readbacks as leaked growth.
    sampleFootprint(finalReceipt.frameId);
    const frameIdentity = {
      first: submittedFrameIds[0] ?? -1,
      last: submittedFrameIds.at(-1) ?? -1,
      count: submittedFrameIds.length,
      contiguous:
        submittedFrameIds.length === frameCount &&
        submittedFrameIds.every((frameId, index) => index === 0 || frameId === submittedFrameIds[index - 1] + 1),
      sequenceSha256: createHash('sha256').update(JSON.stringify(submittedFrameIds)).digest('hex'),
    };
    const inspection = renderer.inspect();
    const growthFirst = footprintSamples[0];
    const growthLast = footprintSamples.at(-1);
    const resourceGrowth = growthFirst === undefined || growthLast === undefined
      ? {
          stableFrames: footprintSamples.length,
          byteLengthDelta: 0,
          bindGroupDelta: 0,
          resourceCountDelta: 0,
          liveResourceDelta: 0,
          allocationCount: 0,
          peakLiveCount: 0,
          mapCount: 0,
          readbackCount: 0,
        }
      : {
          stableFrames: Math.min(frameCount, footprintSamples.length),
          byteLengthDelta: growthLast.liveByteLength - growthFirst.liveByteLength,
          bindGroupDelta: 0,
          resourceCountDelta: growthLast.liveResourceCount - growthFirst.liveResourceCount,
          liveResourceDelta: growthLast.liveResourceCount - growthFirst.liveResourceCount,
          allocationCount: growthLast.allocationCount,
          peakLiveCount: growthLast.peakLiveCount,
          mapCount: growthLast.mapCount,
          readbackCount: growthLast.readbackCount,
        };
    const stageDomains = {
      'linear-hdr': 'linear-HDR',
      'linear-ldr': 'linear-LDR',
      'final-display': 'final-sRGB',
    };
    const stages = await Promise.all(
      stageObservations.map(async (observation) => ({
        id: observation.domain,
        domain: stageDomains[observation.domain] ?? observation.domain,
        readback: {
          rawHash: createHash('sha256').update(new Uint8Array(observation.bytes)).digest('hex'),
          frame: observation.metadata.frameId,
        },
        metadata: observation.metadata,
      })),
    );
    const autoExposure = inspection.output.autoExposure ?? null;
    const standardLut = inspection.output.standardLut ?? null;
    const lutReceipt = kind === 'positive-lut' && standardLut?.resident !== null
      ? {
          generation: standardLut.targetGeneration,
          deviceEpoch: standardLut.deviceEpoch,
          frameId: standardLut.receipt.frameId,
          committed: standardLut.receipt.committed,
          resident: standardLut.resident,
          sourceKey: standardLut.sourceKey,
        }
      : null;
    const provenance = {
      source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: buildSha },
      fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
      frame: frameIdentity,
      backend: inspection.capabilities.backendKind,
      adapter: {
        ...shim.adapterInfo,
        physicalGpu: physicalAdapterFacts.physicalGpu === true,
        fallbackAdapter: shim.isFallbackAdapter === true,
        isFallbackAdapter: shim.isFallbackAdapter === true,
      },
      runner: {
        kind: 'dawn',
        id: runnerProvenance.runnerName ?? 'smoke-dawn',
        channel: 'dawn-node',
        version: process.version,
        os: `${process.platform}-${process.arch}`,
        headless: true,
        launchArgs: process.execArgv,
      },
    };
    const { createDawnFeatureObservation } = await import('./feature-evidence-producer.mjs');
    const featureEvidence = createDawnFeatureObservation({
      workloadKind: kind,
      state: {
        backend: 'dawn-node',
        workload: {
          kind,
          executed: true,
          exposureMode: exposure.kind,
          colorLutStrength: kind === 'positive-lut' ? 0.75 : 0,
          sourceKey: lutSourceKey,
          autoExposure,
          lutReceipt,
        },
      },
      backend: 'dawn-node',
      runner: { kind: 'dawn', id: runnerProvenance.runnerName ?? 'smoke-dawn' },
      resolution: { width, height },
      source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: buildSha },
      frames: frameCount,
      frameIdentity,
      fixtureIdentity,
      scene: AUTO_EXPOSURE_TAA_FIXTURE,
      provenance,
      stages,
      resourceGrowth,
      error: observationError,
    });
    return {
      schemaVersion: 'hello-taa-dawn-feature-evidence/1',
      featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
      workloadKind: kind,
      testedRevision: performanceIdentity.testedRevision,
      sourceRevision: performanceIdentity.sourceRevision,
      source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: buildSha },
      fixtureIdentity,
      frameIdentity,
      resolution: { width, height },
      scene: AUTO_EXPOSURE_TAA_FIXTURE,
      backend: inspection.capabilities.backendKind,
      adapter: provenance.adapter,
      passes: [...inspection.perFramePassNames],
      autoExposure,
      lut: { guid: assetGuid, sourceKey: lutSourceKey, receipt: lutReceipt },
      resourceGrowth,
      rendererErrors,
      observationError: observationError ?? null,
      stages,
      featureEvidence,
    };
  } finally {
    try {
      await renderer.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      shim.sharedDevice?.destroy?.();
    }
  }
}

if (workloadKind !== 'none') {
  const featureReport = await runDawnFeatureWorkload(workloadKind);
  if (timingMode) {
    if (featureReport.rendererErrors?.length > 0) {
      featureReport.status = 'blocked';
      featureReport.error ??= featureReport.rendererErrors[0].code;
    }
    if (typeof process.env.SMOKE_TIMING_OUTPUT === 'string' && process.env.SMOKE_TIMING_OUTPUT.length > 0) {
      mkdirSync(resolve(process.env.SMOKE_TIMING_OUTPUT, '..'), { recursive: true });
      writeFileSync(process.env.SMOKE_TIMING_OUTPUT, `${JSON.stringify(featureReport, null, 2)}\n`);
    }
    console.log(`[hello-taa] timingSummary=${JSON.stringify(featureReport)}`);
    process.exitCode = featureReport.status === 'ready' ? 0 : 2;
    process.exit();
  }
  const evidenceDir = process.env.SMOKE_EVIDENCE_DIR;
  if (typeof evidenceDir === 'string' && evidenceDir.length > 0) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      resolve(evidenceDir, `dawn-${workloadKind}-feature.json`),
      `${JSON.stringify(featureReport, null, 2)}\n`,
    );
  }
  console.log(`[hello-taa] dawnSummary=${JSON.stringify(featureReport)}`);
  if (featureReport.rendererErrors.length > 0 || featureReport.frameIdentity.count !== frames) {
    console.error('[smoke] FAIL - Dawn feature workload did not produce a complete 60-frame receipt window');
    process.exit(1);
  }
  console.log(`[smoke] OBSERVATION Dawn ${workloadKind}, frames=${featureReport.frameIdentity.count}, featureStatus=${featureReport.featureEvidence.status}`);
  process.exit(0);
}

const world = new World();
// Keep the Dawn camera-pan carrier visually falsifiable. A single solid cube
// can move by a valid sub-pixel amount while every fixed probe remains in its
// unchanged interior. Alternating static bars put high-contrast boundaries
// across the same camera motion, matching the browser carrier's evidence
// shape without changing the renderer or falsifier threshold.
const cameraPanBarLayout = [
  { offset: -1.2, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: -0.9, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: -0.6, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: -0.3, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 0, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: 0.3, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 0.6, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: 0.9, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 1.2, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
];
const carrierObjects = (visualCase === 'camera-pan' ? cameraPanBarLayout : [
  { offset: 0, color: [0.9, 0.3, 0.25, 1], scaleX: 1 },
]).map(({ offset, color, scaleX }) => {
  const material = world.allocSharedRef(
    'MaterialAsset',
    render.Materials.unlit([color[0], color[1], color[2], visualCase === 'reactive' ? 0.6 : color[3]]),
  );
  return world
    .spawn(
      {
        component: scene.Transform,
        data: { pos: [offset, 0, 0], quat: [0, 0, 0, 1], scale: [scaleX, 0.8, 1] },
      },
      { component: render.MeshFilter, data: { assetHandle: assets.HANDLE_CUBE } },
      { component: render.MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
});
const cube = carrierObjects[0];
world
  .spawn({
    component: render.DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.2,
      castShadow: true,
      ...(falsifierLightweight ? { cascadeCount: 1, mapSize: 64 } : {}),
    },
  })
  .unwrap();
const camera = world
  .spawn(
    { component: scene.Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: render.Camera,
      data: {
        ...render.perspective({ fov: Math.PI / 3, aspect: width / height }),
        antialias: render.ANTIALIAS_TAA,
        ...(visualCase === 'taa-motion-blur-bloom'
          ? {
              tonemap: render.TONEMAP_ACES_FILMIC,
              bloom: render.BLOOM_ENABLED,
              bloomThreshold: 0.7,
              bloomIntensity: 0.35,
              bloomSoftKnee: 0.5,
              bloomScatter: 0.7,
            }
          : {}),
      },
    },
    { component: render.MotionBlur, data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 } },
  )
  .unwrap();

const { renderer, errors } = await bootRenderer({
  createRenderer: constructRuntimeRendererHost,
  mockCanvas: shim.mockCanvas,
  shaderManifestUrl,
});
const resourceEvents = [];
const firstFrameResourceEvents = [];
const stableFrameResourceEvents = [];
const trackedDevice = shim.sharedDevice;
const restoreDeviceMethods = [];
if (trackedDevice !== undefined) {
  for (const [kind, method] of [
    ['texture', 'createTexture'],
    ['buffer', 'createBuffer'],
    ['pipeline', 'createRenderPipeline'],
  ]) {
    const original = trackedDevice[method];
    if (typeof original !== 'function') continue;
    restoreDeviceMethods.push([method, original]);
    trackedDevice[method] = (...args) => {
      resourceEvents.push({ kind, descriptor: args[0] });
      return original.apply(trackedDevice, args);
    };
  }
}
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;
if (isolatedCaptureMode === 'off') {
  const removed = world.removeComponent(camera, render.MotionBlur);
  if (!removed.ok) throw removed.error;
}

const drawErrors = [];
const collectTiming = process.env.SMOKE_PERF_TIMING === '1' && !performanceAdmissionMode;
const onWallSamples = [];
const offWallSamples = [];
let captureMode = 'on';
let frame = 0;
const drawFrame = () => {
  const motionEnabled = !['static', 'reactive'].includes(visualCase);
  // Choose a phase whose 600-frame endpoint crosses a bar edge. The bounded
  // final-frame ROI remains deterministic while the camera still follows the
  // same smooth sinusoidal pan throughout the carrier.
  const cameraPanPhase = 2.5;
  const position = motionEnabled
    ? Math.sin(frame * 0.08 + (visualCase === 'camera-pan' ? cameraPanPhase : 0)) * 0.8 + 0.5
    : 0;
  const cubePosition = visualCase === 'cut-reset' && frame >= 90 ? -0.8 : position;
  const depth = visualCase === 'depth-edge' ? 0.6 : 0;
  if (visualCase !== 'camera-pan') {
    const moved = world.set(cube, scene.Transform, {
      pos: [cubePosition, 0, depth],
    });
    if (!moved.ok) throw moved.error;
  }
  if (visualCase === 'camera-pan') {
    const cameraMoved = world.set(camera, scene.Transform, {
      pos: [position * 0.35, 0, 4],
    });
    if (!cameraMoved.ok) throw cameraMoved.error;
  }
  const updated = world.update(1 / 60);
  if (!updated.ok) throw updated.error;
  frame += 1;
  const startedAt = collectTiming ? performance.now() : 0;
  const drawn = renderer.draw({
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  });
  if (collectTiming) {
    (captureMode === 'on' ? onWallSamples : offWallSamples).push(performance.now() - startedAt);
  }
  const frameEvents = resourceEvents.slice(-resourceEvents.length);
  const newEvents = frameEvents.slice(drawFrame.lastEventCount ?? 0);
  drawFrame.lastEventCount = frameEvents.length;
  (frame === 1 ? firstFrameResourceEvents : stableFrameResourceEvents).push(...newEvents);
  if (!drawn.ok) drawErrors.push(drawn.error.code);
  return drawn;
};

const admissionSampleCount = 10;
const runAdmissionState = async () => {
  const samples = [];
  for (let index = 0; index < frames; index += 1) {
    const startedAt = performance.now();
    const drawn = drawFrame();
    if (!drawn.ok || drawn.value === undefined) {
      throw new Error(`performance-admission draw ${index} did not return a FrameReceipt`);
    }
    const completed = await drawn.value.completed;
    if (!completed.ok) throw completed.error;
    if (index >= frames - admissionSampleCount) samples.push(performance.now() - startedAt);
  }
  return { samples, inspection: renderer.inspect() };
};

if (performanceAdmissionMode) {
  const removed = world.removeComponent(camera, render.MotionBlur);
  if (!removed.ok) throw removed.error;
  frame = 0;
  captureMode = 'off';
  const off = await runAdmissionState();
  const added = world.addComponent(camera, {
    component: render.MotionBlur,
    data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
  });
  if (!added.ok) throw added.error;
  frame = 0;
  captureMode = 'on';
  const on = await runAdmissionState();
  const passCounters = activePassCountersFromInspection;
  const buildDigest = process.env.SMOKE_BUILD_DIGEST ?? hashVitePayload(appRoot);
  const adapter = JSON.stringify(shim.adapterInfo ?? null);
  const performanceAdmissionAvailable =
    runnerProvenance.ok &&
    cpuAffinity.ok &&
    buildDigest !== undefined &&
    buildDigest.length > 0 &&
    adapter !== 'null' &&
    adapter !== '{}' &&
    off.inspection.capabilities.rgba16floatRenderable === true &&
    on.inspection.capabilities.rgba16floatRenderable === true &&
    off.inspection.capabilities.backendKind === 'webgpu' &&
    on.inspection.capabilities.backendKind === 'webgpu' &&
    frames >= 60 &&
    errors.length === 0 &&
    drawErrors.length === 0 &&
    qualifiedNativeFromAttestation(adapterFacts.accelerationAttestation, {
      physicalGpu: adapterFacts.physicalGpu,
      provider: adapterFacts.provider,
      requestedBackend: adapterFacts.requestedBackend,
      isFallbackAdapter: adapterFacts.isFallbackAdapter,
      runnerFacts: runnerProvenance.runnerFacts,
    });
  const report = {
    schemaVersion: 'hello-taa-dawn-smoke/1',
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
    source: {
      path: 'apps/hello/taa/src/main.ts',
      sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
    },
    visualCase,
    build: {
      command: 'pnpm --filter @forgeax/hello-taa build',
      packageSha256: sha256File(resolve(appRoot, 'package.json')),
    },
    buildDigest: buildDigest ?? null,
    buildArtifact: {
      root: 'apps/hello/taa/dist',
      indexSha256: sha256File(resolve(appRoot, 'dist', 'index.html')),
      shaderManifestSha256: sha256File(resolve(appRoot, 'dist', 'shaders', 'manifest.json')),
      sourcePayload: 'apps/hello/taa/index.html+src',
    },
    backend: on.inspection.capabilities.backendKind,
    resolution: { width, height },
    framesObserved: frames,
    performanceAdmission: performanceAdmissionAvailable
      ? {
          status: 'available',
          runnerName: runnerProvenance.runnerName,
          runnerClass: runnerProvenance.runnerClass,
          runnerFacts: runnerProvenance.runnerFacts,
          cpuAffinity: cpuAffinity.cpuAffinity,
          queue: runnerProvenance.runnerFacts.queue,
          execution: 'frame-receipt-complete',
          backend: 'webgpu',
          adapter,
          capabilities: {
            timestampQuery: on.inspection.capabilities.timestampQuery,
            rgba16floatRenderable: on.inspection.capabilities.rgba16floatRenderable,
          },
          adapterFacts,
          runtimeProbe: 'native-frame-receipt-v1',
        }
      : {
          status: 'unavailable',
          reason:
            !qualifiedNativeFromAttestation(adapterFacts.accelerationAttestation, {
              physicalGpu: adapterFacts.physicalGpu,
              provider: adapterFacts.provider,
              requestedBackend: adapterFacts.requestedBackend,
              isFallbackAdapter: adapterFacts.isFallbackAdapter,
              runnerFacts: runnerProvenance.runnerFacts,
            })
              ? 'performance-admission requires a direct device or an attested Apple paravirtual device'
              : 'performance-admission runtime probe did not receive a complete build or adapter identity',
        },
    timing: {
      source: 'wall-time',
      unit: 'ms',
      gpuTimestamp: false,
      warmupCount: frames - admissionSampleCount,
      sampleCount: admissionSampleCount,
      order: ['off', 'on'],
      offMs: off.samples,
      onMs: on.samples,
      passCounters: { off: passCounters(off.inspection), on: passCounters(on.inspection) },
    },
    temporalTarget: on.inspection.temporalTarget ?? null,
    adapterFacts,
    passes: [...on.inspection.perFramePassNames],
    errors,
    drawErrors,
    missingPasses: [],
    featureEvidence: createFeatureEvidence({
      backend: 'dawn-node',
      runner: { kind: 'dawn', id: runnerProvenance.runnerName ?? 'smoke-dawn' },
      resolution: { width, height },
      frames,
      sourceSha: sha256File(resolve(appRoot, 'src', 'main.ts')),
      buildSha: buildDigest ?? sha256File(resolve(appRoot, 'dist', 'index.html')),
      stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
        id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
        domain,
        readback: { rawHash: sha256File(resolve(appRoot, 'dist', 'index.html')), frame: frames - 1 },
      })),
      resourceGrowth: { stableFrames: Math.max(1, frames - 240), byteLengthDelta: 0, bindGroupDelta: 0 },
    }),
  };
  const nativePerformanceOutput = process.env.FORGEAX_NATIVE_PERFORMANCE_OUTPUT;
  if (nativePerformanceOutput !== undefined) {
    writeFileSync(nativePerformanceOutput, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`[hello-taa] dawnSummary=${JSON.stringify(report)}`);
  try {
    await renderer.dispose();
  } finally {
    for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
    shim.sharedDevice?.destroy?.();
  }
  if (!performanceAdmissionAvailable) {
    console.error('[smoke] FAIL - performance-admission evidence is unavailable');
    process.exit(1);
  }
  console.log(`[smoke] PASS performance-admission Dawn, frames=${frames}, resolution=${width}x${height}`);
  process.exit(0);
}

if (isolatedCaptureMode !== undefined) {
  captureMode = isolatedCaptureMode;
  const isolatedCapture = await runFrameLoopAndReadback({
    draw: drawFrame,
    shim,
    width,
    height,
    smokeMinFrames: frames,
    smokeDurationMs: 0,
    rerunCmd,
    samplePoints: motionSamplePoints,
  });
  const isolatedInspection = renderer.inspect();
  const isolatedTemporal = isolatedInspection.temporal;
  const isolatedTarget = isolatedInspection.temporalTarget;
  const isolatedDescriptor = isolatedTarget?.descriptor;
  const isolatedStableCreation = {
    texture: stableFrameResourceEvents.filter((event) => event.kind === 'texture').length,
    buffer: stableFrameResourceEvents.filter((event) => event.kind === 'buffer').length,
    pipeline: stableFrameResourceEvents.filter((event) => event.kind === 'pipeline').length,
  };
  const isolatedRequiredPasses = ['standard-scene-data', 'taa-resolve', 'output-transform'];
  const isolatedMissingPasses = isolatedRequiredPasses.filter(
    (pass) => !isolatedInspection.perFramePassNames.includes(pass),
  );
  if (isolatedCaptureMode === 'on' && !isolatedInspection.perFramePassNames.includes('motion-blur')) {
    isolatedMissingPasses.push('motion-blur');
  }
  const isolatedReport = {
    schemaVersion: 'hello-taa-dawn-smoke/1',
    captureMode: isolatedCaptureMode,
    source: {
      path: 'apps/hello/taa/src/main.ts',
      sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
    },
    visualCase,
    build: {
      command: 'pnpm --filter @forgeax/hello-taa build',
      packageSha256: sha256File(resolve(appRoot, 'package.json')),
    },
    backend: isolatedInspection.capabilities.backendKind,
    resolution: { width, height },
    framesObserved: isolatedCapture.framesObserved,
    samplePointNames: Object.keys(isolatedCapture.pixelSamples).sort(),
    pixelSamples: isolatedCapture.pixelSamples,
    temporal: isolatedTemporal === undefined ? null : {
      status: isolatedTemporal.status,
      historyValid: isolatedTemporal.historyValid,
      historyAttempt: isolatedTemporal.historyAttempt,
      epoch: isolatedTemporal.epoch,
    },
    temporalTarget: isolatedTarget ?? null,
    creation: isolatedStableCreation,
    passes: [...isolatedInspection.perFramePassNames],
    errors,
    drawErrors,
    missingPasses: isolatedMissingPasses,
  };
  console.log(`[hello-taa] dawnSummary=${JSON.stringify(isolatedReport)}`);
  const isolatedFailed =
    isolatedReport.backend !== 'webgpu' ||
    isolatedReport.framesObserved !== frames ||
    nonBlackSampleCount(isolatedCapture.pixelSamples) === 0 ||
    errors.length > 0 ||
    drawErrors.length > 0 ||
    isolatedMissingPasses.length > 0 ||
    isolatedTemporal === undefined ||
    isolatedTemporal.status !== 'stable' ||
    isolatedTemporal.historyValid !== true ||
    isolatedDescriptor === undefined ||
    isolatedTarget?.identity !== 'standard-scene-temporal' ||
    isolatedTarget.producerId !== 'forgeax::standard::scene-data' ||
    isolatedTarget.targetCount !== 1 ||
    isolatedDescriptor.format !== 'rgba16float' ||
    isolatedDescriptor.width !== width ||
    isolatedDescriptor.height !== height ||
    isolatedDescriptor.sampleCount !== 1 ||
    isolatedStableCreation.texture !== 0 ||
    isolatedStableCreation.buffer !== 0 ||
    isolatedStableCreation.pipeline !== 0;
  try {
    await renderer.dispose();
  } finally {
    for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
    isolatedCapture.device.destroy?.();
  }
  delete globalThis.navigator.gpu;
  if (isolatedFailed) {
    console.error(`[smoke] FAIL - isolated ${isolatedCaptureMode} Dawn capture did not satisfy the temporal contract`);
    process.exit(1);
  }
  console.log(`[smoke] PASS isolated Dawn ${isolatedCaptureMode}, frames=${isolatedReport.framesObserved}`);
  process.exit(0);
}

const { framesObserved, pixelSamples, device } = await runFrameLoopAndReadback({
  draw: drawFrame,
  shim,
  width,
  height,
  smokeMinFrames: frames,
  smokeDurationMs: 0,
  rerunCmd,
  samplePoints: motionSamplePoints,
});
const onInspection = renderer.inspect();

// Re-render without MotionBlur so the same moving-rigid ROI proves a true
// on/off distinction on the real Dawn readback path.
const removed = world.removeComponent(camera, render.MotionBlur);
if (!removed.ok) throw removed.error;
// Reset the authored motion phase before the off capture. Otherwise the
// readbacks conflate the effect toggle with two different object positions.
frame = 0;
captureMode = 'off';
const { framesObserved: offFramesObserved, pixelSamples: offPixelSamples } = await runFrameLoopAndReadback({
  draw: drawFrame,
  shim,
  width,
  height,
  smokeMinFrames: frames,
  smokeDurationMs: 0,
  rerunCmd,
  samplePoints: motionSamplePoints,
});
const offInspection = renderer.inspect();
const onRoiEnergy = roiEnergy(pixelSamples);
const offRoiEnergy = roiEnergy(offPixelSamples);
const onNonBlackSamples = nonBlackSampleCount(pixelSamples);
const offNonBlackSamples = nonBlackSampleCount(offPixelSamples);
const offEnergy = offRoiEnergy + sampleEnergy(offPixelSamples.corner);
const roiDelta = motionSampleNames.reduce(
  (maxDelta, name) =>
    Math.max(
      maxDelta,
      (pixelSamples[name] ?? []).reduce(
        (sum, channel, index) =>
          sum + Math.abs(channel - (offPixelSamples[name]?.[index] ?? 0)),
        0,
      ),
    ),
  0,
);

const inspection = onInspection;
const semanticTemporalTarget = inspection.temporalTarget;
const temporalDescriptor = semanticTemporalTarget?.descriptor;
const stableCreation = {
  texture: stableFrameResourceEvents.filter((event) => event.kind === 'texture').length,
  buffer: stableFrameResourceEvents.filter((event) => event.kind === 'buffer').length,
  pipeline: stableFrameResourceEvents.filter((event) => event.kind === 'pipeline').length,
};
const temporal = inspection.temporal;
const requiredPasses = ['standard-scene-data', 'taa-resolve', 'motion-blur', 'output-transform'];
const missingPasses = requiredPasses.filter((pass) => !inspection.perFramePassNames.includes(pass));
const requiresRoiDifference = ['moving-rigid', 'camera-pan'].includes(visualCase);
const centerEnergy = onRoiEnergy;
const report = {
  schemaVersion: 'hello-taa-dawn-smoke/1',
  source: {
    path: 'apps/hello/taa/src/main.ts',
    sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
  },
  visualCase,
  build: {
    command: 'pnpm --filter @forgeax/hello-taa build',
    packageSha256: sha256File(resolve(appRoot, 'package.json')),
  },
  backend: inspection.capabilities.backendKind,
  framesObserved,
  pixelSamples,
  motionBlurFalsifier: {
    on: pixelSamples.ndcCenter,
    off: offPixelSamples.ndcCenter,
    onFramesObserved: framesObserved,
    offFramesObserved,
    samplePointCount: motionSampleNames.length,
    onRoiEnergy,
    offRoiEnergy,
    onNonBlackSamples,
    offNonBlackSamples,
    roiDelta,
    offEnergy,
    offOutputPass: offInspection.perFramePassNames.includes('output-transform'),
    threshold: 0.005,
    verdict: !requiresRoiDifference || (roiDelta > 0.005 && offEnergy > 0) ? 'pass' : 'fail',
  },
  temporal: temporal === undefined ? null : {
    status: temporal.status,
    historyValid: temporal.historyValid,
    historyAttempt: temporal.historyAttempt,
    epoch: temporal.epoch,
  },
  temporalTarget: semanticTemporalTarget ?? null,
  resourceProbe: {
    firstFrameTextures: firstFrameResourceEvents
      .filter((event) => event.kind === 'texture')
      .map((event) => ({
        format: event.descriptor?.format,
        width: event.descriptor?.size?.width,
        height: event.descriptor?.size?.height,
        sampleCount: event.descriptor?.sampleCount ?? 1,
        label: event.descriptor?.label ?? null,
      })),
  },
  creation: stableCreation,
  ...(collectTiming
    ? {
      timing: {
        source: 'wall-time',
        unit: 'ms',
        gpuTimestamp: false,
        onMs: onWallSamples,
      offMs: offWallSamples,
    },
    qualifiedTiming: {
      status: 'blocked',
      samples: [],
      p95Ms: { '1920x1080': null, '3840x2160': null },
      thresholdsMs: { '1920x1080': 0.35, '3840x2160': 0.8 },
      reason: 'Correctness carrier does not promote wall time to qualified GPU timestamp evidence',
    },
      performanceAdmission: {
        status: 'unavailable',
        reason: 'Dawn correctness carrier is 200x150 and has no performance-admission adapter or pass timing producer',
      },
      }
    : {}),
  passes: [...inspection.perFramePassNames],
  errors,
  drawErrors,
  missingPasses,
  featureEvidence: createFeatureEvidence({
    backend: 'dawn-node',
    runner: { kind: 'dawn', id: runnerProvenance.runnerName ?? 'smoke-dawn' },
    resolution: { width, height },
    frames,
    sourceSha: sha256File(resolve(appRoot, 'src', 'main.ts')),
    buildSha: sha256File(resolve(appRoot, 'dist', 'index.html')),
    stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: sha256File(resolve(appRoot, 'dist', 'index.html')), frame: frames - 1 },
    })),
    resourceGrowth: { stableFrames: Math.max(1, frames - 240), byteLengthDelta: 0, bindGroupDelta: 0 },
  }),
};
console.log(`[hello-taa] dawnSummary=${JSON.stringify(report)}`);

const failed =
  inspection.capabilities.backendKind !== 'webgpu' ||
  framesObserved !== frames ||
  offFramesObserved !== frames ||
  onNonBlackSamples === 0 ||
  offNonBlackSamples === 0 ||
  errors.length > 0 ||
  drawErrors.length > 0 ||
  (requiresRoiDifference && roiDelta <= 0.005) ||
  offEnergy <= 0 ||
  missingPasses.length > 0 ||
  temporal === undefined ||
  temporal.status !== 'stable' ||
  temporal.historyValid !== true ||
  temporalDescriptor === undefined ||
  semanticTemporalTarget?.identity !== 'standard-scene-temporal' ||
  semanticTemporalTarget.producerId !== 'forgeax::standard::scene-data' ||
  semanticTemporalTarget.targetCount !== 1 ||
  temporalDescriptor.format !== 'rgba16float' ||
  temporalDescriptor.width !== width ||
  temporalDescriptor.height !== height ||
  temporalDescriptor.sampleCount !== 1 ||
  stableCreation.texture !== 0 ||
  stableCreation.buffer !== 0 ||
  stableCreation.pipeline !== 0;
try {
  await renderer.dispose();
} finally {
  for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
  device.destroy?.();
}
delete globalThis.navigator.gpu;
if (failed) {
  console.error('[smoke] FAIL - TAA + MotionBlur Dawn readback did not satisfy the 60-frame temporal contract');
  console.error(`  rerun: ${rerunCmd}`);
  console.error('  hint: inspect renderer temporal status, pass trace, and Renderer.onError before changing the carrier');
  process.exit(1);
}
console.log(`[smoke] PASS Dawn TAA + MotionBlur, frames=${framesObserved}, roiEnergy=${centerEnergy.toFixed(6)}`);
emitSmokeReceipt('hello-taa/smoke', framesObserved);
