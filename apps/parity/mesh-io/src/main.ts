import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { AnimationPlayer, AnimationTargetId, animationPlugin, bindAnimationTargets } from '@forgeax/engine-animation';
import { World, createWorldContext } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, renderComponentsPlugin } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape, encodeTape, halfToFloat, openReplay, replayDeviceRequest } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { propagateTransforms, Transform, scenePlugin } from '@forgeax/engine-scene';
import { type MeshAsset, type MaterialAsset, type SceneAsset, type AnimationClip, ok } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { fixtures } from 'virtual:mesh-io-fixtures';
import { MESH_IO_LOGICAL_FRAMES, meshIoFrameIndices } from './frame-profile';
import './style.css';

function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T { if (!result.ok) throw result.error; return result.value; }
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
}
function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`readback length mismatch ${a.length}/${b.length}`);
  let changed = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return changed;
}

const files: { name: string; bytes: Uint8Array }[] = [];
const results: unknown[] = [];
const retained = new Set<() => void>();
const save = (name: string, bytes: Uint8Array) => files.push({ name, bytes });
const fileManifest = () => files.map(({ name, bytes }) => ({ name, byteLength: bytes.length }));
Object.assign(window, { meshIoReadFile: (name: string, offset: number) => {
  const file = files.find((entry) => entry.name === name);
  if (file === undefined) throw new Error(`missing evidence ${name}`);
  return base64(file.bytes.subarray(offset, offset + 1024 * 1024));
} });

async function run() {
  const info = (await navigator.gpu.requestAdapter())?.info;
  const hardware = info === undefined ? null : { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  const parameters = new URLSearchParams(location.search);
  const scaleId = parameters.get('scale');
  const onlyId = parameters.get('only');
  const frameIndices = meshIoFrameIndices(scaleId === null && parameters.get('ci-samples') === '1');
  const selectedFixtures = scaleId === null ? fixtures.filter(row => !row.id.startsWith('scale-') && (onlyId === null || row.id === onlyId)) : fixtures.filter(row => row.id === scaleId);
  if (selectedFixtures.length === 0) throw new Error('unknown scale fixture');
  for (const fixture of selectedFixtures) {
    const panel = document.createElement('article');
    panel.innerHTML = `<h2>${fixture.label}</h2><canvas width="320" height="240"></canvas><div class="status">Loading Catalog…</div>`;
    document.querySelector('#grid')!.append(panel);
    const canvas = panel.querySelector('canvas')!;
    const recorder = attachRecorder(webgpu).unwrap();
    const host = value(await constructRuntimeRendererHost(canvas, {
      gpuPassTiming: {},
      rhi: recorder.backend.rhi,
      rhiInstrumentation: { resolveSurfaceDevice: (device) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()) },
    }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) }));
    // This driver creates these devices. Preserve the submitted image before
    // retiring the renderer; the gallery must not retain per-scene GPU timing pools.
    const liveNative = value(host.renderer.nativeDevice());
    const retire = () => { host.renderer.dispose(); liveNative.destroy(); retained.delete(retire); };
    retained.add(retire);
    const finish = async (hdrBytes?: Uint8Array) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const snapshot = document.createElement('canvas');
      snapshot.width = canvas.width; snapshot.height = canvas.height;
      const context = snapshot.getContext('2d')!;
      if (hdrBytes === undefined) context.drawImage(canvas, 0, 0);
      else {
        // The live GPU readback survives presentation/device retirement.
        // Preview conversion matches the downloadable linear-HDR analysis.
        const pixels = context.createImageData(snapshot.width, snapshot.height);
        const words = new DataView(hdrBytes.buffer, hdrBytes.byteOffset, hdrBytes.byteLength);
        for (let i = 0; i < pixels.data.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            const linear = Math.min(1, Math.max(0, halfToFloat(words.getUint16((i + channel) * 2, true))));
            pixels.data[i + channel] = Math.round((linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055) * 255);
          }
          pixels.data[i + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
      }
      canvas.replaceWith(snapshot);
      retire();
    };
    const errors: unknown[] = [];
    host.renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
    configureRuntimeAssetCatalog(host.assets, runtimeBinding);
    value(host.renderer.setProfile({ ...host.renderer.inspect().profile, renderPath: 'forward', ssao: false }));
    const world = new World();
    await createWorldContext(world,[scenePlugin(),renderComponentsPlugin(),skinningPlugin(),animationPlugin()]);
    if (fixture.sceneGuid === undefined) world.spawn({ component: Transform, data: { pos: [0, 0, 3] } }, { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3 }), antialias: 0, bloom: 0, tonemap: 0 } }).unwrap();
    world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -0.6, -1], intensity: fixture.lightIntensity ?? 3, castShadow: false } }).unwrap();
    const loadStart = performance.now();
    const meshes = [];
    const loadedMeshes: MeshAsset[] = [];
    for (const guid of fixture.guids) {
      const mesh = (await host.assets.loadByGuid<MeshAsset>(value(AssetGuid.parse(guid)))).unwrap();
      loadedMeshes.push(mesh);
      meshes.push({ guid, vertices: (mesh.attributes.position as Float32Array).length / 3, indices: mesh.indices?.length ?? 0, bounds: Array.from(mesh.aabb ?? []) });
      if (fixture.sceneGuid !== undefined) continue;
      const material = fixture.id === 'svg' ? Materials.unlit([1, 1, 1, 1], { renderState: { cullMode: 'none', depthCompare: 'less-equal' } }) : Materials.standard({ baseColor: [0.16, 0.5, 0.75, 1], roughness: 0.55, metallic: 0.1 });
      const materialHandles = [];
      // Geometry round trips share one authored material. The closure case
      // consumes its source MTL; source glTF materials use their Scene below.
      for (const slot of mesh.materialSlots) materialHandles.push(fixture.id !== 'obj-mtl' || slot.defaultMaterial === undefined ? world.allocSharedRef('MaterialAsset',material) : world.allocSharedRef('MaterialAsset',(await host.assets.loadByGuid<MaterialAsset>(slot.defaultMaterial)).unwrap()));
      world.spawn(
        { component: Transform, data: fixture.id === 'svg' ? { pos: [-0.5, -0.5, 0], scale: [0.1, 0.1, 0.1] } : { quat: [0.15, 0.2, 0, Math.sqrt(1 - 0.15 ** 2 - 0.2 ** 2)] } },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
        { component: MeshRenderer, data: { materials: materialHandles } },
      ).unwrap();
    }
    const lease = value(host.renderer.attach(world));
    let animationPlayer: import('@forgeax/engine-ecs').EntityHandle | undefined;
    if (fixture.sceneGuid !== undefined) {
      const scene=(await host.assets.loadByGuid<SceneAsset>(value(AssetGuid.parse(fixture.sceneGuid)))).unwrap();
      const anchor=host.assets.instantiate(world.allocSharedRef('SceneAsset',scene),world).unwrap();
      if (fixture.animationGuid !== undefined) {
        const clip=(await host.assets.loadByGuid<AnimationClip>(value(AssetGuid.parse(fixture.animationGuid)))).unwrap();
        animationPlayer=anchor;world.addComponent(anchor,{component:AnimationPlayer,data:{clips:[world.allocSharedRef('AnimationClip',clip)],times:[0],weights:[1],speeds:[0],paused:true,looping:false}}).unwrap();
        bindAnimationTargets(world,anchor,[...world.query({with:[AnimationTargetId]}).unwrap()].map(row=>row.entity)).unwrap();
      }
      for (const row of world.query({with:[Camera]}).unwrap()) world.set(row.entity,Camera,{antialias:0,bloom:0,tonemap:0}).unwrap();
    }
    const loadMs = performance.now() - loadStart;
    const request = { leases: [lease], camera: { lease }, environment: { lease } };
    const timings = [];
    const rawTimings: unknown[] = [];
    for (const frame of frameIndices) {
      const time=2*(frame+.371)/MESH_IO_LOGICAL_FRAMES;
      if (animationPlayer !== undefined) world.set(animationPlayer,AnimationPlayer,{times:[time]}).unwrap();
      world.update(1 / 60).unwrap();
      if (animationPlayer !== undefined) for (const row of world.query({with:[AnimationTargetId,Transform]}).unwrap()) {
        const actual=world.get(row.entity,Transform).unwrap().pos[0]!,expected=.6*(time/2)*(1-time/2);
        if (Math.abs(actual-expected)>1e-5) throw new Error(`cubic cooked pose ${actual}/${expected}`);
        rawTimings.push({poseTime:time,actual,expected,error:Math.abs(actual-expected)});
      } propagateTransforms(world);
      const start = performance.now();
      const submitted = await drawReadyFrame(host.renderer, request);
      const wallMs=performance.now()-start;
      const observation=value(await host.renderer.observe(submitted,{include:['timings']}));
      rawTimings.push({frame,wallMs,observation,resources:host.renderer.inspect().renderGraphResourceAllocation});
      if (frame >= 10) timings.push(wallMs);
    }
    if (scaleId !== null) {
      if (errors.length > 0) throw new Error(JSON.stringify(errors));
      const ordered = [...timings].sort((a, b) => a - b);
      results.push({ id: fixture.id, completedFrames: frameIndices.length, hardware, resolution: [320, 240], loadMs, meshes, rawTimings, frameWallMs: { p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1] }, resources: host.renderer.inspect().renderGraphResourceAllocation });
      await finish();
      continue;
    }
    // One live submitted frame is the capture authority. Fresh-device replay is supplementary.
    if (host.renderer.requestObservation === undefined) throw new Error('live HDR observation is unavailable');
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const submitted = await drawReadyFrame(host.renderer, request, ['linear-hdr']);
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    save(`${fixture.id}/frame.rhitape`, captured.bytes);
    save(`${fixture.id}/timings.json`,new TextEncoder().encode(JSON.stringify(rawTimings)));
    const observations = value(await host.renderer.observe(submitted, { include: ['linear-hdr'] }));
    const live = observations.observations?.find((entry) => entry.domain === 'linear-hdr');
    if (live === undefined) throw new Error('missing live linear HDR readback');
    save(`${fixture.id}/live.rgba16float`, live.bytes);
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    const draws = model.works.filter((work) => work.vertexBuffers.length > 0 && work.attachments !== null);
    if (draws.length === 0) throw new Error('no imported mesh draw in the real tape');
    const selected = draws.at(-1)!;
    const resource = selected.attachments!.colorResolveViewHandleIds[0] ?? selected.attachments!.colorViewHandleIds[0];
    if (resource === undefined) throw new Error('missing drawn scene target');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))).unwrap();
    const replayNative = device.nativeDevice().unwrap();
    replayNative.pushErrorScope('validation');
    const replay = (await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })).unwrap();
    let replayChangedBytes = -1;
    let inspection: unknown;
    const geometryChecks: unknown[] = [];
    try {
      inspection = (await replay.inspectWork(selected.workIndex, ['pipeline', 'bindings'])).unwrap();
      const checkedBuffers = new Set<string>();
      for (const draw of draws) {
        const vertexBuffer = draw.vertexBuffers[0];
        if (vertexBuffer === undefined || draw.indexBuffer === null || checkedBuffers.has(vertexBuffer.bufferHandleId)) continue;
        checkedBuffers.add(vertexBuffer.bufferHandleId);
        const vertexRead = (await replay.readResourceAtWork(vertexBuffer.bufferHandleId, draw.workIndex)).unwrap();
        const indexRead = (await replay.readResourceAtWork(draw.indexBuffer.bufferHandleId, draw.workIndex)).unwrap();
        const match = loadedMeshes.find((mesh) => vertexRead.bytes.length === mesh.vertices.byteLength && difference(vertexRead.bytes, new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength)) === 0);
        if (match?.indices === undefined) throw new Error('GPU vertex bytes do not match an imported canonical mesh');
        const indexDelta = difference(indexRead.bytes, new Uint8Array(match.indices.buffer, match.indices.byteOffset, match.indices.byteLength));
        if (indexDelta !== 0) throw new Error(`GPU index bytes differ from imported mesh: ${indexDelta}`);
        geometryChecks.push({ workIndex: draw.workIndex, vertexBuffer: vertexBuffer.bufferHandleId, indexBuffer: draw.indexBuffer.bufferHandleId, vertexBytes: vertexRead.bytes.length, indexBytes: indexRead.bytes.length, indexFormat: draw.indexBuffer.format, vertexChangedBytes: 0, indexChangedBytes: indexDelta });
        save(`${fixture.id}/geometry-${geometryChecks.length}.vertices`, vertexRead.bytes);
        save(`${fixture.id}/geometry-${geometryChecks.length}.indices`, indexRead.bytes);
      }
      if (geometryChecks.length !== loadedMeshes.length) throw new Error('not every imported mesh reached the captured GPU work');
      const read = (await replay.readResourceAtWork(resource, model.works.at(-1)!.workIndex)).unwrap();
      const validation = await replayNative.popErrorScope();
      if (validation !== null) throw new Error(`replay GPU validation: ${validation.message}`);
      replayChangedBytes = difference(read.bytes, live.bytes);
      if (replayChangedBytes !== 0) throw new Error(`live/replay mismatches ${replayChangedBytes} bytes`);
      save(`${fixture.id}/replay.rgba16float`, read.bytes);
    } finally { try { (await replay.dispose()).unwrap(); } finally { replayNative.destroy(); } }
    const removed = new Set(draws.map((work) => work.eventIndex));
    const falsified = encodeTape({ ...tape, events: tape.events.map((event, eventIndex) => {
      if (!removed.has(eventIndex)) return event;
      if (event.kind === 'draw') return { ...event, vertexCount: 0 };
      if (event.kind === 'drawIndexed') return { ...event, indexCount: 0 };
      if (event.kind === 'drawIndexedIndirect' || event.kind === 'drawIndirect') return { kind: 'draw' as const, passHandleId: event.passHandleId, vertexCount: 0, instanceCount: 0, firstVertex: 0, firstInstance: 0 };
      throw new Error(`unhandled raster work ${event.kind}`);
    }) }).unwrap();
    save(`${fixture.id}/missing-draw.rhitape`, falsified);
    const falsifierTape = decodeTape(falsified).unwrap();
    const controlAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const controlDevice = (await controlAdapter.requestDevice(replayDeviceRequest(falsifierTape, controlAdapter.features, controlAdapter.limits))).unwrap();
    const control = (await openReplay(falsifierTape, { device: controlDevice, createShaderModule: webgpu.createShaderModule })).unwrap();
    let falsifierChangedBytes = 0;
    const controlNative = controlDevice.nativeDevice().unwrap();
    controlNative.pushErrorScope('validation');
    try {
      const read = (await control.readResourceAtWork(resource, model.works.at(-1)!.workIndex)).unwrap();
      const validation = await controlNative.popErrorScope();
      if (validation !== null) throw new Error(`falsifier GPU validation: ${validation.message}`);
      falsifierChangedBytes = difference(read.bytes, live.bytes);
      save(`${fixture.id}/missing-draw.rgba16float`, read.bytes);
      if (falsifierChangedBytes < 100) throw new Error(`missing-draw falsifier changed only ${falsifierChangedBytes} bytes`);
    } finally { try { (await control.dispose()).unwrap(); } finally { controlNative.destroy(); } }
    if (errors.length > 0) throw new Error(JSON.stringify(errors));
    const ordered = timings.sort((a, b) => a - b);
    const result = { id: fixture.id, completedFrames: frameIndices.length + 1, hardware, resolution: [320, 240], sampleCount: timings.length, frameWallMs: { p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1] }, meshes, geometryChecks, digest: captured.digest, selectedWorkIndex: selected.workIndex, drawCount: draws.length, unseededResources: model.unseededResources, replayChangedBytes, falsifierChangedBytes, errors };
    results.push(result);
    save(`${fixture.id}/inspection.json`, new TextEncoder().encode(JSON.stringify({ result, inspection, work: selected, resources: model.resources }, null, 2)));
    panel.querySelector('.status')!.textContent = `${frameIndices.length + 1} frames · replay Δ=0 · ${draws.length} mesh draws\np50=${ordered[Math.ceil(ordered.length * .5) - 1]?.toFixed(2)} ms · p95=${ordered[47]?.toFixed(2)} ms`;
    await finish(live.bytes);
  }
  return { results, files: fileManifest() };
}

Object.assign(window, { meshIoEvidence: run().then((result) => ({ ok: true, ...result })).catch((error: unknown) => ({ ok: false, results, files: fileManifest(), error: JSON.parse(JSON.stringify(error, (_key, item: unknown) => item instanceof Error ? { ...item, message: item.message, stack: item.stack } : item)) })) });
window.addEventListener('pagehide', () => { for (const retire of retained) retire(); });
