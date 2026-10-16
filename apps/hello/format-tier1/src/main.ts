import { configureRuntimeAssetCatalog, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { meshIrToMeshAsset, parseGltf } from '@forgeax/engine-gltf';
import { meshoptDecoder } from '@forgeax/engine-gltf/importer';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  type Renderer,
} from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import type { AssetRegistry as RuntimeAssetRegistry } from '@forgeax/engine-assets-runtime';

import type { MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './style.css';

type Status = 'pass' | 'blocked' | 'fail';
type JsonRecord = Record<string, unknown>;

interface MorphEvidence extends JsonRecord {
  readonly producer?: { readonly status?: Status; readonly verdict?: Status; readonly observed?: string };
  readonly source?: { readonly sourceCodeSha?: string };
  readonly readback?: { readonly status?: Status };
}

interface KtxGpuEvidence extends JsonRecord {
  readonly rows: readonly {
    readonly source: string;
    readonly selected: string;
    readonly status: Status;
    readonly normalized: { readonly maxAbsError: number | null };
  }[];
}

interface AnimationClip {
  readonly duration: number;
  readonly channels: readonly {
    readonly property: string;
    readonly sampler: { readonly input: Float32Array; readonly output: Float32Array };
  }[];
}

interface CanonicalMorph {
  readonly mesh: MeshAsset;
  readonly baseWeights: Float32Array;
  readonly animation: AnimationClip;
  readonly targetCount: number;
}

interface BrowserGpuResult {
  readonly status: Status;
  readonly reason: string;
  readonly diagnostics: string;
  readonly states: readonly MorphBrowserState[];
  readonly canonical: CanonicalMorph | undefined;
}

interface MorphBrowserState {
  readonly id: string;
  readonly label: string;
  readonly weights: readonly number[];
  readonly status: Status;
  readonly reason: string;
  readonly diagnostics: string;
  readonly observation?: { readonly status: Status };
}

interface CanonicalMeshopt {
  readonly mesh: MeshAsset;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly topology: string;
  readonly rejectedCode: string;
}

interface BrowserMeshoptResult {
  readonly status: Status;
  readonly reason: string;
  readonly diagnostics: string;
}

const app = document.querySelector<HTMLElement>('#app');
if (app === null) throw new Error('format-tier1: missing #app');
const root = app;

const MESH_GUID = AssetGuid.parse('11111111-1111-4111-8111-111111111111');
const MORPH_ANIMATION_GUID = AssetGuid.parse('44444444-4444-4444-8444-444444444444');
const MESHOPT_GUID = AssetGuid.parse('22222222-2222-4222-8222-222222222222');
const retainedRenderers = new Set<{ dispose(): void }>();
window.addEventListener('beforeunload', () => {
  for (const renderer of retainedRenderers) void renderer.dispose();
  retainedRenderers.clear();
});

void bootstrap();

async function bootstrap(): Promise<void> {
  root.innerHTML = '<p class="lede">Loading canonical format-tier1 producer...</p>';
  try {
    const meshopt = await loadCanonicalMeshopt();
    root.innerHTML = '<section class="card"><h1>Format-tier1 dogfood</h1><p class="lede">Loading imported Morph Pack...</p><canvas id="morph-gpu-canvas" width="480" height="320"></canvas></section>';
    const canvas = root.querySelector<HTMLCanvasElement>('#morph-gpu-canvas');
    if (canvas === null) throw new Error('Morph GPU canvas was not created');
    const gpu = await runBrowserMorphStandard(canvas);
    const canonical = gpu.canonical;
    if (canonical === undefined) throw new Error(`Morph browser producer blocked: ${gpu.reason}`);
    renderPage({ verdict: 'blocked' }, {}, { rows: [] }, canonical, meshopt, gpu, {
      status: 'blocked',
      reason: 'Waiting for the feature-owned Meshopt standard mesh consumer.',
      diagnostics: 'not-run',
    }, canvas);
    updateBrowserGpuStatus(gpu);
    const meshoptCanvas = root.querySelector<HTMLCanvasElement>('#meshopt-gpu-canvas');
    if (meshoptCanvas === null) throw new Error('Meshopt GPU canvas was not created');
    const meshoptGpu = await runBrowserMeshoptConsumer(meshopt, meshoptCanvas);
    updateMeshoptStatus(meshoptGpu);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[format-tier1] canonical producer failed:', detail);
    root.innerHTML = `<section class="card"><h1>Format-tier1 dogfood</h1><p class="lede">Producer blocked: ${escapeHtml(detail)}</p><span class="status status-blocked">BLOCKED</span></section>`;
  }
}

async function loadCanonicalMorph(assets: RuntimeAssetRegistry): Promise<CanonicalMorph> {
  if (MESH_GUID.ok === false) throw new Error('Morph mesh GUID is invalid');
  if (MORPH_ANIMATION_GUID.ok === false) throw new Error('Morph animation GUID is invalid');
  configureRuntimeAssetCatalog(
    assets,
    runtimeBinding,
  );
  const loaded = await assets.loadByGuid<MeshAsset>(MESH_GUID.value);
  if (!loaded.ok) throw new Error(`Imported Morph Pack loadByGuid failed: ${loaded.error.code}`);
  const animation = await assets.loadByGuid<AnimationClip>(MORPH_ANIMATION_GUID.value);
  if (!animation.ok) throw new Error(`Imported Morph animation loadByGuid failed: ${animation.error.code}`);
  if (loaded.value.morphTargets === undefined || loaded.value.morphTargets.length < 2) {
    throw new Error('Imported Morph Pack emitted fewer than two targets');
  }
  if (loaded.value.morphWeights?.length !== loaded.value.morphTargets.length) {
    throw new Error('Imported Morph Pack emitted mismatched base weights');
  }
  return {
    mesh: loaded.value,
    baseWeights: loaded.value.morphWeights,
    animation: animation.value,
    targetCount: loaded.value.morphTargets.length,
  };
}

async function loadCanonicalMeshopt(): Promise<CanonicalMeshopt> {
  const sourceResponse = await fetch('/fixtures/meshopt-triangle.gltf');
  if (!sourceResponse.ok) throw new Error(`Meshopt fixture returned HTTP ${sourceResponse.status}`);
  const sourceText = await sourceResponse.text();
  const sourceJson = JSON.parse(sourceText) as unknown;
  const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
    throw new Error(`Meshopt fixture unexpectedly requested external buffer ${uri}`);
  };
  const parsed = await parseGltf(
    sourceJson,
    externalLoader,
    'apps/hello/format-tier1/fixtures/meshopt-triangle.gltf',
    { meshopt: meshoptDecoder },
  );
  if (!parsed.ok) throw new Error(`Meshopt importer failed: ${parsed.error.code}`);
  const primitive = parsed.value.meshes[0];
  if (primitive === undefined) throw new Error('Meshopt importer emitted no mesh primitive');
  const meshResult = meshIrToMeshAsset([primitive]);
  if (!meshResult.ok) throw meshResult.error;
  const mesh = meshResult.value;
  if (MESHOPT_GUID.ok === false) throw new Error('Meshopt mesh GUID is invalid');
  const registry = new AssetRegistry({} as never);
  const catalogResult = registry.catalog(MESHOPT_GUID.value, mesh);
  if (!catalogResult.ok) throw new Error(`Meshopt runtime catalog failed: ${catalogResult.error.code}`);
  const loaded = await registry.loadByGuid<MeshAsset>(MESHOPT_GUID.value);
  if (!loaded.ok) throw new Error(`Meshopt runtime loadByGuid failed: ${loaded.error.code}`);

  const rejectedJson = JSON.parse(sourceText) as {
    readonly bufferViews: Array<{
      readonly extensions?: {
        readonly EXT_meshopt_compression?: { byteLength: number };
      };
    }>;
  };
  const rejectedExtension = rejectedJson.bufferViews[1]?.extensions?.EXT_meshopt_compression;
  if (rejectedExtension === undefined) throw new Error('Meshopt fixture lacks its index compression extension');
  rejectedExtension.byteLength += 1;
  const rejected = await parseGltf(
    rejectedJson,
    externalLoader,
    'apps/hello/format-tier1/fixtures/meshopt-triangle.gltf#damaged',
    { meshopt: meshoptDecoder },
  );
  if (rejected.ok) throw new Error('Meshopt damaged fixture unexpectedly decoded successfully');
  return {
    mesh: loaded.value,
    vertexCount: primitive.positions.length / 3,
    indexCount: primitive.indices?.length ?? 0,
    topology: loaded.value.submeshes[0]?.topology ?? 'triangle-list',
    rejectedCode: rejected.error.code,
  };
}

function sampleAnimationWeights(canonical: CanonicalMorph, progress: number): Float32Array | undefined {
  const channel = canonical.animation?.channels.find((candidate) => candidate.property === 'weights');
  if (channel === undefined || channel.sampler.output.length < canonical.targetCount) return undefined;
  const frameCount = Math.max(1, Math.floor(channel.sampler.output.length / canonical.targetCount));
  const frame = Math.min(frameCount - 1, Math.round(progress * (frameCount - 1)));
  return channel.sampler.output.slice(frame * canonical.targetCount, (frame + 1) * canonical.targetCount);
}

function blockedMorphStates(targetCount: number, reason: string): readonly MorphBrowserState[] {
  const zero = Array.from({ length: targetCount }, () => 0);
  return [
    { id: 'static-target-a', label: 'Static target A', weights: zero, status: 'blocked', reason, diagnostics: 'not-run' },
    { id: 'animation-t0', label: 'Animation t=0', weights: zero, status: 'blocked', reason, diagnostics: 'not-run' },
    { id: 'animation-t1', label: 'Animation t=1', weights: zero, status: 'blocked', reason, diagnostics: 'not-run' },
    { id: 'zero-weight-reset', label: 'Zero-weight reset', weights: zero, status: 'blocked', reason, diagnostics: 'not-run' },
  ];
}

async function runBrowserMorphStandard(canvas: HTMLCanvasElement): Promise<BrowserGpuResult> {
  if (typeof navigator.gpu === 'undefined') {
    const reason = 'The browser has no navigator.gpu capability.';
    return { status: 'blocked', reason, diagnostics: 'navigator.gpu unavailable', states: blockedMorphStates(2, reason), canonical: undefined };
  }
  let renderer: Renderer;
  let assets: RuntimeAssetRegistry;
  let canonical: CanonicalMorph | undefined;
  try {
    let activeState: MorphBrowserState | undefined;
    const renderErrors: string[] = [];
    const constructed = await constructRuntimeRendererHost(canvas, {}, forgeaxBundlerAdapter());
    if (!constructed.ok) throw constructed.error;
    renderer = constructed.value.renderer;
    assets = constructed.value.assets;
    retainedRenderers.add(renderer);
    renderer.subscribe((event) => {
      if (event.kind === 'error') renderErrors.push(JSON.stringify(event.error));
    });
    canonical = await loadCanonicalMorph(assets);
    const materialGuid = AssetGuid.parse('33333333-3333-4333-8333-333333333334');
    if (!materialGuid.ok) throw new Error('Morph material GUID is invalid');
    const material = Materials.unlit([0.2, 0.8, 0.45, 1], {
      renderState: { cullMode: 'none' },
    });
    const materialCatalog = assets.catalog(materialGuid.value, material);
    if (!materialCatalog.ok) throw new Error(`Morph material catalog failed: ${materialCatalog.error.code}`);
    const animationT0 = sampleAnimationWeights(canonical, 0);
    const animationT1 = sampleAnimationWeights(canonical, 1);
    const stateInputs: readonly { readonly id: string; readonly label: string; readonly weights: Float32Array | undefined; readonly reason: string }[] = [
      {
        id: 'static-target-a',
        label: 'Static target A',
        weights: canonical.baseWeights.slice(),
        reason: 'Real imported mesh base weights applied to the target set.',
      },
      {
        id: 'animation-t0',
        label: 'Animation t=0',
        weights: animationT0,
        reason: animationT0 === undefined ? 'The imported glTF asset has no usable weights channel.' : 'Real imported animation keyframe sampled at t=0.',
      },
      {
        id: 'animation-t1',
        label: 'Animation t=1',
        weights: animationT1,
        reason: animationT1 === undefined ? 'The imported glTF asset has no usable weights channel.' : 'Real imported animation keyframe sampled at t=1.',
      },
      {
        id: 'zero-weight-reset',
        label: 'Zero-weight reset',
        weights: new Float32Array(canonical.targetCount),
        reason: 'Real zero-weight reset applied to the imported target set.',
      },
    ];
    const world = new World();
    const meshHandle = world.allocSharedRef('MeshAsset', canonical.mesh);
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 480 / 320 }) },
    ).unwrap();
    const morphEntity = world.spawn(
      { component: Transform, data: { scale: [60, 60, 60] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: MorphWeights, data: { weights: canonical.baseWeights.slice() } },
    ).unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw new Error(`Morph World attachment failed: ${attachment.error.code}`);
    const states: MorphBrowserState[] = [];
    for (const input of stateInputs) {
      if (input.weights === undefined) {
        states.push({ id: input.id, label: input.label, weights: [], status: 'blocked', reason: input.reason, diagnostics: 'not-run' });
        continue;
      }
      activeState = { id: input.id, label: input.label, weights: Array.from(input.weights), status: 'blocked', reason: input.reason, diagnostics: 'pending' };
      world.set(morphEntity, MorphWeights, { weights: new Float32Array(input.weights) }).unwrap();
      world.update(1 / 60).unwrap();
      const frameRequest = {
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      };
      let drawn = renderer.draw(frameRequest);
      let observed = drawn.ok
        ? await renderer.observe(drawn.value, { include: ['draws', 'bindings'] })
        : undefined;
      for (let attempt = 1; attempt < 4 && observed?.ok !== true; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        world.update(1 / 60).unwrap();
        drawn = renderer.draw(frameRequest);
        observed = drawn.ok
          ? await renderer.observe(drawn.value, { include: ['draws', 'bindings'] })
          : undefined;
      }
      if (!drawn.ok) {
        states.push({
          ...activeState,
          reason: `Standard morph draw failed: ${drawn.error.code}`,
          diagnostics: JSON.stringify({ error: drawn.error }),
        });
        continue;
      }
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        world.update(1 / 60).unwrap();
        const frameDraw = renderer.draw(frameRequest);
        if (!frameDraw.ok) {
          drawn = frameDraw;
          break;
        }
        observed = await renderer.observe(frameDraw.value, { include: ['draws', 'bindings'] });
      }
      if (!drawn.ok) {
        states.push({
          ...activeState,
          reason: `Morph standard renderer frame submission failed: ${drawn.error.code}`,
          diagnostics: JSON.stringify({ observed, draw: drawn.error, renderErrors }),
        });
        continue;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const receiptObservation = drawn.ok
        ? await renderer.observe(drawn.value, { include: ['draws', 'bindings'] })
        : undefined;
      const observation = { status: receiptObservation?.ok === true ? 'pass' as const : 'blocked' as const };
      const diagnostics = JSON.stringify({ observation: receiptObservation, consumer: 'MeshFilter/MeshRenderer', pixelEvidence: 'screenshot', renderErrors });
      states.push({
        ...activeState,
        status: observation.status,
        reason: receiptObservation?.ok === true
          ? 'Imported Morph weights reached the Standard CPU deformation lane and the MeshFilter/MeshRenderer canvas; judge the rendered screenshot for visible geometry.'
          : 'Morph standard consumer blocked: receipt observation was unavailable.',
        diagnostics,
        observation,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const allExecuted = states.length === stateInputs.length && states.every((state) => state.status === 'pass');
    const reason = allExecuted
      ? 'All four imported Morph states reached the active feature and standard MeshFilter/MeshRenderer canvas; screenshot evidence judges compositor-visible output.'
      : 'At least one imported Morph state lacks a receipt-bound Standard renderer observation; the visual gate remains fail-closed.';
    return {
      status: allExecuted ? 'pass' : 'blocked',
      reason,
      diagnostics: JSON.stringify({ states, visibleConsumer: 'MeshFilter/MeshRenderer', allExecuted, renderErrors }),
      states,
      canonical,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `The canonical Standard morph execution refused: ${detail}`;
    return { status: 'blocked', reason, diagnostics: 'renderer construction or execution refused', states: blockedMorphStates(canonical?.targetCount ?? 2, reason), canonical };
  }
}

async function runBrowserMeshoptConsumer(
  canonical: CanonicalMeshopt,
  canvas: HTMLCanvasElement,
): Promise<BrowserMeshoptResult> {
  if (typeof navigator.gpu === 'undefined') {
    return {
      status: 'blocked',
      reason: 'The browser has no navigator.gpu capability.',
      diagnostics: JSON.stringify({ decoderRejection: canonical.rejectedCode }),
    };
  }
  let renderer: Renderer;
  let assets: RuntimeAssetRegistry;
  try {
    const constructed = await constructRuntimeRendererHost(canvas, {}, forgeaxBundlerAdapter());
    if (!constructed.ok) throw constructed.error;
    renderer = constructed.value.renderer;
    assets = constructed.value.assets;
    retainedRenderers.add(renderer);
    const meshGuid = MESHOPT_GUID.ok ? MESHOPT_GUID.value : undefined;
    if (meshGuid === undefined) throw new Error('Meshopt mesh GUID is invalid');
    const materialGuid = AssetGuid.parse('33333333-3333-4333-8333-333333333333');
    if (!materialGuid.ok) throw new Error('Meshopt material GUID is invalid');
    const material = Materials.unlit([0.2, 0.75, 1, 1]);
    const meshCatalog = assets.catalog(meshGuid, canonical.mesh);
    if (!meshCatalog.ok) throw new Error(`Meshopt GPU catalog failed: ${meshCatalog.error.code}`);
    const materialCatalog = assets.catalog(materialGuid.value, material);
    if (!materialCatalog.ok) throw new Error(`Meshopt material catalog failed: ${materialCatalog.error.code}`);
    const loaded = await assets.loadByGuid<MeshAsset>(meshGuid);
    if (!loaded.ok) throw new Error(`Meshopt GPU loadByGuid failed: ${loaded.error.code}`);
    const world = new World();
    const meshHandle = world.allocSharedRef('MeshAsset', loaded.value);
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 480 / 320 }) },
    ).unwrap();
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw new Error(`Meshopt World attachment failed: ${attachment.error.code}`);
    const frameRequest = {
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    };
    const errors: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error.code);
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw(frameRequest);
      if (!drawn.ok) {
        return {
          status: 'blocked',
          reason: `Meshopt standard draw failed: ${drawn.error.code}`,
          diagnostics: JSON.stringify({ attempt, errors, decoderRejection: canonical.rejectedCode }),
        };
      }
      const fatalErrors = errors.filter((code) => code !== 'rhi-not-available');
      if (attempt > 1 && fatalErrors.length === 0) {
        return {
          status: 'pass',
          reason: 'The compressed Meshopt fixture was decoded, catalogued, loaded by GUID, and consumed by the standard GPU MeshFilter/MeshRenderer path.',
          diagnostics: JSON.stringify({
            attempt,
            vertexCount: canonical.vertexCount,
            indexCount: canonical.indexCount,
            attributes: Object.keys(loaded.value.attributes),
            topology: canonical.topology,
            decoderRejection: canonical.rejectedCode,
            transientErrors: errors,
          }),
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return {
      status: 'blocked',
      reason: 'The standard Meshopt consumer did not reach a clean GPU frame.',
      diagnostics: JSON.stringify({ errors, decoderRejection: canonical.rejectedCode }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'blocked',
      reason: `The canonical Meshopt browser execution refused: ${detail}`,
      diagnostics: JSON.stringify({ decoderRejection: canonical.rejectedCode }),
    };
  }
}

function renderPage(
  gates: JsonRecord,
  morphEvidence: MorphEvidence,
  ktxEvidence: KtxGpuEvidence,
  canonical: CanonicalMorph,
  meshopt: CanonicalMeshopt,
  gpu: BrowserGpuResult,
  meshoptGpu: BrowserMeshoptResult,
  morphCanvas: HTMLCanvasElement,
): void {
  const sourceSha = 'not recorded';
  const morphProducer = morphEvidence.producer?.status === 'pass' && morphEvidence.verdict === 'pass';
  const runtimeStatus: Status = morphProducer ? 'pass' : 'blocked';
  const animation = canonical.animation;
  root.innerHTML = `
    <header>
      <h1>Format-tier1 dogfood</h1>
      <p class="lede">Standard Pipeline dogfood. Morph panels consume the checked-in glTF fixture through Vite gltfImporter, Pack/Catalog, renderer-owned <code>loadByGuid</code>, ECS <code>MorphWeights</code>, and the MeshFilter/MeshRenderer consumer. Run-specific support reports are kept outside the repository, so their cells stay visibly blocked here.</p>
      <div class="meta"><span class="chip">CSV rows 8 / 18 / 26</span><span class="chip">Saved run ${escapeHtml(sourceSha.slice(0, 12))}</span><span class="chip">M7 final gate ${statusLabel(gates.verdict === 'blocked' ? 'blocked' : 'pass')}</span></div>
    </header>
    <section class="grid">
      ${meshoptCard(meshopt, meshoptGpu)}
      ${basisCard(ktxEvidence)}
      <article class="card card-wide">
        <h2>Morph / BlendShape canonical output <span class="status status-${runtimeStatus}">${runtimeStatus.toUpperCase()}</span></h2>
        <p>Imported targets: <strong>${canonical.targetCount}</strong>; animation: <strong>${animation?.channels.length ?? 0}</strong> weights channel(s), <strong>${animation?.duration ?? 0}</strong>s duration. Dawn readback: <span class="status status-${morphEvidence.readback?.status === 'pass' ? 'pass' : 'blocked'}">${(morphEvidence.readback?.status ?? 'blocked').toUpperCase()}</span>. Browser GPU: <span id="morph-gpu-status" class="status status-${gpu.status}">${gpu.status.toUpperCase()}</span></p>
        <p id="morph-gpu-reason">${escapeHtml(gpu.reason)}</p><p id="morph-gpu-diagnostics">Diagnostics: ${escapeHtml(gpu.diagnostics)}</p>
        <canvas id="morph-gpu-canvas" width="480" height="320" aria-label="Canonical imported Standard morph output"></canvas>
        <div id="morph-states" class="morph-grid">${morphStateCards(gpu.states)}</div>
      </article>
    </section>
    <p class="footnote">Visual evidence must judge the screenshot, not the browser exit code. Receipt observation proves the Standard path; pixel evidence is intentionally screenshot-owned, and FBX remains a static/no-animation boundary.</p>`;
  const renderedCanvas = root.querySelector<HTMLCanvasElement>('#morph-gpu-canvas');
  if (renderedCanvas !== null) renderedCanvas.replaceWith(morphCanvas);
}

function meshoptCard(meshopt: CanonicalMeshopt, gpu: BrowserMeshoptResult): string {
  return `<article class="card card-wide"><h2>Meshopt standard mesh consumer <span id="meshopt-gpu-status" class="status status-${gpu.status}">${gpu.status.toUpperCase()}</span></h2><p id="meshopt-gpu-reason">${escapeHtml(gpu.reason)}</p><p id="meshopt-gpu-diagnostics">Diagnostics: ${escapeHtml(gpu.diagnostics)}</p><ul><li>Compressed fixture: ${meshopt.vertexCount} vertices, ${meshopt.indexCount} indices, topology ${escapeHtml(meshopt.topology)}.</li><li>Decoder rejection probe: ${escapeHtml(meshopt.rejectedCode)}.</li></ul><canvas id="meshopt-gpu-canvas" width="480" height="320" aria-label="Meshopt standard GPU mesh output"></canvas></article>`;
}

function basisCard(evidence: KtxGpuEvidence): string {
  const inputs = [
    ['ktx2-etc1s', 'ETC1S'],
    ['ktx2-uastc-ldr', 'UASTC LDR'],
    ['ktx2-uastc-hdr', 'UASTC HDR'],
    ['basis-uastc-ldr', 'Raw Basis'],
  ] as const;
  const cells = inputs.map(([source, label]) => {
    const rows = evidence.rows.filter((row) => row.source === source);
    const passed = rows.length === 5 && rows.every((row) => row.status === 'pass');
    const maxAbsError = Math.max(...rows.map((row) => row.normalized.maxAbsError ?? Number.POSITIVE_INFINITY));
    const targets = [...new Set(rows.map((row) => row.selected))].join(', ');
    const status: Status = passed ? 'pass' : 'blocked';
    return `<div class="matrix-cell"><strong>${label}</strong><span class="status status-${status}">${status.toUpperCase()}</span><p>5 capability arms; maxAbsError ${Number.isFinite(maxAbsError) ? maxAbsError.toFixed(5) : 'unavailable'}; targets ${escapeHtml(targets)}.</p></div>`;
  });
  const complete = evidence.rows.length === 20 && evidence.rows.every((row) => row.status === 'pass');
  const status: Status = complete ? 'pass' : 'blocked';
  return `<article class="card"><h2>KTX2 / Basis input matrix <span class="status status-${status}">${status.toUpperCase()}</span></h2><p>Real KTX2/Basis inputs sampled through all 20 GPU capability cells.</p><div class="matrix">${cells.join('')}</div></article>`;
}

function morphStateCards(states: readonly MorphBrowserState[]): string {
  return states.map((state) => `<article class="morph-state"><h3>${escapeHtml(state.label)} <span class="status status-${state.status}">${state.status.toUpperCase()}</span></h3><p>${escapeHtml(state.reason)}</p><p>Weights: ${escapeHtml(JSON.stringify(state.weights))}</p><p>Diagnostics: ${escapeHtml(state.diagnostics)}</p></article>`).join('');
}

function updateBrowserGpuStatus(result: BrowserGpuResult): void {
  updateGpuStatus('morph-gpu-status', 'morph-gpu-reason', 'morph-gpu-diagnostics', result);
  const states = root.querySelector<HTMLElement>('#morph-states');
  if (states !== null) states.innerHTML = morphStateCards(result.states);
}

function updateMeshoptStatus(result: BrowserMeshoptResult): void {
  updateGpuStatus('meshopt-gpu-status', 'meshopt-gpu-reason', 'meshopt-gpu-diagnostics', result);
}

function updateGpuStatus(
  statusId: string,
  reasonId: string,
  diagnosticsId: string,
  result: { readonly status: Status; readonly reason: string; readonly diagnostics: string },
): void {
  const status = root.querySelector<HTMLElement>(`#${statusId}`);
  const reason = root.querySelector<HTMLElement>(`#${reasonId}`);
  const diagnostics = root.querySelector<HTMLElement>(`#${diagnosticsId}`);
  if (status !== null) {
    status.className = `status status-${result.status}`;
    status.textContent = result.status.toUpperCase();
  }
  if (reason !== null) reason.textContent = result.reason;
  if (diagnostics !== null) diagnostics.textContent = `Diagnostics: ${result.diagnostics}`;
}

function statusLabel(status: Status): string { return status.toUpperCase(); }

function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
