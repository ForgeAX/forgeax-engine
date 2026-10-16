import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  DEFAULT_STANDARD_PROFILE,
  type FrameReceipt,
  parseDiffuseGiTier,
  resolveDiffuseGiTier,
} from '@forgeax/engine-render';
import { uploadTape } from '@forgeax/engine-rhi-debug/browser';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '../../../shared/src/asset-runtime-config.ts';
import {
  cameraOnPath,
  cameraTransform,
  type GiSceneControls,
  setLightState,
  spawnCamera,
  spawnLight,
  createGiBoxMesh,
  spawnProceduralScene,
} from './build-scene.ts';
import { giMaterialGuid } from './material-guids.ts';
import {
  diffuseGiFor,
  GI_MATERIAL_NAMES,
  GI_MODES,
  GI_SCENE_IDS,
  type GiMaterialName,
  type GiMode,
  PROCEDURAL_SCENES,
  parseGiMode,
  parseGiScene,
  SPONZA,
  tierSceneFor,
} from './scenes.ts';

const query = new URLSearchParams(location.search);
const sceneId = parseGiScene(query.get('scene'));
const size = Number(query.get('size') ?? 512);
const bounces = Number(query.get('bounces') ?? 1);
const reconstruction = query.get('reconstruction');
/** `tier=low|medium|high|epic` replaces `gi=` with the engine quality preset. */
const tier = parseDiffuseGiTier(query.get('tier'));
const state = {
  gi: parseGiMode(query.get('gi')),
  light: query.get('light') !== 'off',
  moved: query.get('moved') === '1',
  emissive: query.get('emissive') !== 'off',
  path: query.get('camera') === 'path',
};

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const statusElement = document.querySelector<HTMLElement>('#status');
if (canvas === null || statusElement === null) throw new Error('hello-gi: page markup is missing');
const status: HTMLElement = statusElement;
canvas.width = canvas.height = size;

const errors: unknown[] = [];
const app = (
  await createApp(
    canvas,
    {
      ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
      gpuPassTiming: { maxPassesPerFrame: 2048 },
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: 'deferred',
        ibl: false,
        ssao: false,
      },
    },
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  )
).unwrap();
app.onError((error) => {
  errors.push(error);
  status.textContent = `${error.code}: ${error.hint}`;
});
const { world, renderer } = app;
const assets = app.assets;
if (assets === undefined) throw new Error('hello-gi: asset registry unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);

const sceneData = sceneId === 'sponza' ? SPONZA : PROCEDURAL_SCENES[sceneId];
let controls: Pick<GiSceneControls, 'setLight' | 'setEmissive' | 'setCamera'>;
if (sceneId === 'sponza') {
  const guid = AssetGuid.parse(SPONZA.sceneGuid);
  if (!guid.ok) throw guid.error;
  const scene = (await assets.loadByGuid(guid.value)).unwrap();
  assets.instantiate(world.allocSharedRef('SceneAsset', scene), world).unwrap();
  const light = spawnLight(world, SPONZA.light);
  const camera = spawnCamera(world, SPONZA.camera, 1);
  controls = {
    setLight: (on, moved = false) => setLightState(world, light, SPONZA.light, on, moved),
    setEmissive: () => {},
    setCamera: (pose) => world.set(camera, Transform, cameraTransform(pose)).unwrap(),
  };
} else {
  const handles = new Map<GiMaterialName, Awaited<ReturnType<typeof loadMaterial>>>();
  for (const name of GI_MATERIAL_NAMES) handles.set(name, await loadMaterial(name));
  controls = spawnProceduralScene(
    world,
    PROCEDURAL_SCENES[sceneId],
    (name) => handles.get(name) ?? fail(`material ${name} is not loaded`),
    1,
    await createGiBoxMesh(),
  );
}

async function loadMaterial(name: GiMaterialName) {
  if (assets === undefined) throw new Error('hello-gi: asset registry unavailable');
  const material = (
    await assets.loadByGuid<MaterialAsset>(assets.parseGuid(giMaterialGuid(name)))
  ).unwrap();
  return world.allocSharedRef('MaterialAsset', material);
}

function fail(message: string): never {
  throw new Error(`hello-gi: ${message}`);
}

const baseProfile = renderer.inspect().profile;
function applyTier(selected: NonNullable<typeof tier>) {
  const { diffuseGi: _previous, ...profile } = baseProfile;
  const resolved = resolveDiffuseGiTier(
    selected,
    tierSceneFor(sceneData),
    renderer.inspect().capabilities,
  );
  const result = resolved.ok
    ? renderer.setProfile({ ...profile, ...resolved.value.profile })
    : resolved;
  if (!result.ok) {
    errors.push(result.error);
    status.textContent = `tier ${selected}: ${result.error.code} (${result.error.hint})`;
    return result;
  }
  controls.setLight(state.light, state.moved);
  controls.setEmissive(state.emissive);
  if (!state.path) controls.setCamera(sceneData.camera);
  const lane = resolved.ok ? resolved.value : undefined;
  status.textContent = `${sceneId} | tier ${selected} -> ${lane?.lane}${lane?.fallback ? ` (fallback: ${lane.fallback.reason})` : ''}`;
  return result;
}

function applyState() {
  if (tier !== undefined) return applyTier(tier);
  const { diffuseGi: _previous, ...profile } = baseProfile;
  const diffuseGi = diffuseGiFor(state.gi, sceneData, { maxBounces: bounces });
  const result = renderer.setProfile({
    ...profile,
    renderPath: 'deferred',
    ibl: false,
    ssao: false,
    ...(diffuseGi === undefined
      ? {}
      : {
          diffuseGi:
            diffuseGi.gather === 'exact' &&
            (reconstruction === 'spatial' ||
              reconstruction === 'temporal' ||
              reconstruction === 'combined')
              ? { ...diffuseGi, reconstruction }
              : diffuseGi,
        }),
  });
  if (!result.ok) {
    errors.push(result.error);
    status.textContent = `GI ${state.gi}: ${result.error.code} (${result.error.hint})`;
    return result;
  }
  controls.setLight(state.light, state.moved);
  controls.setEmissive(state.emissive);
  if (!state.path) controls.setCamera(sceneData.camera);
  status.textContent = `${sceneId} | GI ${state.gi} | light ${state.light ? 'on' : 'off'}${state.moved ? ' (moved)' : ''} | emissive ${state.emissive ? 'on' : 'off'}`;
  return result;
}

world
  .addSystem(Update, {
    name: 'hello-gi-camera-path',
    queries: [],
    fn: (world) => {
      if (!state.path) return;
      const t = 0.5 - 0.5 * Math.cos(world.getResource(Time).elapsed * 0.35);
      controls.setCamera(cameraOnPath(sceneData.camera, sceneData.cameraAlt, t));
    },
  })
  .unwrap();

function bindSelect(
  id: string,
  values: readonly string[],
  current: string,
  onChange: (v: string) => void,
) {
  const select = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (select === null) return;
  for (const value of values) select.add(new Option(value, value, false, value === current));
  select.addEventListener('change', () => onChange(select.value));
}
function bindCheckbox(id: string, current: boolean, onChange: (v: boolean) => void) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) return;
  input.checked = current;
  input.addEventListener('change', () => onChange(input.checked));
}
bindSelect('scene', GI_SCENE_IDS, sceneId, (value) => {
  query.set('scene', value);
  location.search = query.toString();
});
bindSelect('gi', GI_MODES, state.gi, (value) => {
  state.gi = parseGiMode(value);
  applyState();
});
bindCheckbox('light', state.light, (v) => {
  state.light = v;
  applyState();
});
bindCheckbox('moved', state.moved, (v) => {
  state.moved = v;
  applyState();
});
bindCheckbox('emissive', state.emissive, (v) => {
  state.emissive = v;
  applyState();
});
bindCheckbox('path', state.path, (v) => {
  state.path = v;
  // Leaving the path snaps back to the scene camera: a cut, not motion.
  if (!v) controls.setCamera(sceneData.camera, true);
  applyState();
});

applyState();
app.start().unwrap();

// Tooling seam: deterministic stepping goes through App.pause/stepFrame, never a parallel draw path.
const nextReceipt = () =>
  new Promise<FrameReceipt>((resolve) => {
    const off = renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted') return;
      off();
      resolve(event.receipt);
    });
  });
async function settle() {
  const deadline = performance.now() + 120000;
  while (app.execution.report().frame.inFlight > 0) {
    if (performance.now() > deadline) throw new Error('hello-gi: frame receipt did not settle');
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function step() {
  const receipt = nextReceipt();
  app.stepFrame(1 / 60).unwrap();
  await settle();
  return receipt;
}
function encode(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

declare global {
  interface Window {
    __gi?: object;
  }
}
const api = {
  sceneId,
  state: () => ({ ...state, tier, errors: errors.length, gi: renderer.inspect().diffuseGi }),
  async set(next: Partial<Omit<typeof state, 'gi'>> & { gi?: GiMode }) {
    app.pause().unwrap();
    await settle();
    Object.assign(state, next);
    const result = applyState();
    return result.ok ? { ok: true } : { ok: false, error: result.error.code };
  },
  /** Settle the GI lane, then mean `frames` linear-HDR frames (one raw sample each). */
  async observe(frames = 1, warm = 8) {
    app.pause().unwrap();
    await settle();
    for (let i = 0; i < warm; i++) await step();
    const started = performance.now();
    while (renderer.inspect().profile.diffuseGi !== undefined) {
      const gi = renderer.inspect().diffuseGi;
      if (gi?.state === 'failed') return { ok: false, error: gi };
      if (gi?.state === 'ready' && gi.submittedFrames > 0) break;
      if (performance.now() - started > 120000) return { ok: false, error: gi };
      await step();
    }
    const sum = new Float32Array(size * size * 3);
    let timings: unknown;
    for (let k = 0; k < frames; k++) {
      const requested = renderer.requestObservation?.(['linear-hdr']);
      if (requested !== undefined && !requested.ok)
        return { ok: false, error: requested.error.code };
      const receipt = await step();
      const observed = await renderer.observe(receipt, { include: ['linear-hdr', 'timings'] });
      if (!observed.ok) return { ok: false, error: observed.error.code };
      if (k === frames - 1) timings = observed.value.timings;
      const hdr = observed.value.observations?.find((item) => item.domain === 'linear-hdr');
      if (hdr?.metadata === undefined)
        return { ok: false, error: 'missing linear-hdr observation' };
      const { bytesPerRow } = hdr.metadata;
      const view = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          for (let c = 0; c < 3; c++)
            sum[(y * size + x) * 3 + c]! +=
              halfToFloat(view.getUint16(y * bytesPerRow + x * 8 + c * 2, true)) / frames;
    }
    return {
      ok: true,
      width: size,
      height: size,
      rgb: encode(new Uint8Array(sum.buffer)),
      timings,
      inspect: renderer.inspect().diffuseGi,
    };
  },
  /** One RHI Debug tape of the next frame, uploaded through the dev-server tape endpoint. */
  async capture(runId: string) {
    if (app.rhiCapture === undefined) return { ok: false, error: 'rhi-capture-unavailable' };
    app.pause().unwrap();
    await settle();
    const started = performance.now();
    const tape = await app.rhiCapture.captureFrame({
      byteBudget: 1024 * 1024 * 1024,
      snapshotTimeoutMs: 120000,
    });
    const captureMs = performance.now() - started;
    if (!tape.ok) return { ok: false, error: tape.error.code };
    console.info(`[hello-gi] captured ${tape.value.bytes.byteLength} bytes in ${captureMs} ms`);
    const uploadStarted = performance.now();
    const artifact = await uploadTape(tape.value, { runId });
    return {
      ok: artifact.ok,
      bytes: tape.value.bytes.byteLength,
      captureMs,
      uploadMs: performance.now() - uploadStarted,
      artifact: artifact.ok ? artifact.value : artifact.error,
    };
  },
  resume() {
    return app.resume().ok;
  },
};
window.__gi = api;

function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
