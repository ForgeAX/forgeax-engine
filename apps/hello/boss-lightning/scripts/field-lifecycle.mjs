import { encodePng } from '@forgeax/engine-image/png';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { ok } from '@forgeax/engine-types';
import { ParticleEffectPlayer, VFX_PARTICLE_CORE_LAYOUT, vfxParticleCoreField } from '@forgeax/engine-vfx';
import { decodeTape, buildFrameModel, openReplay, replayDeviceRequest, tapeDigest, readbackImage, toRgba8 } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { fieldGuid } from '../src/field-guids.ts';
import { initialPosition, dt } from './field-oracle.mjs';


const unwrap = result => { if (!result.ok) throw result.error; return result.value; };

// Diagnostic oracle only: two independently prescribed acceleration epochs.
// It neither samples the saved Texture nor mirrors production particle state.
function expectedRecord(id, ticks) {
  const position = initialPosition(id, 'constant');
  const velocity = [0, 0, 0];
  for (let tick = 0; tick < ticks; tick++) {
    const acceleration = tick < 61 ? [0.5, 0.25, -0.125] : [-0.5, 0.25, -0.125];
    for (let lane = 0; lane < 3; lane++) {
      velocity[lane] += acceleration[lane] * dt;
      position[lane] += velocity[lane] * dt;
    }
  }
  return { position, velocity };
}

export async function runFieldLifecycle(context) {
  const { app, world, assets, host, scene, recorder, device, output, readLivePixels,
    step, counters } = context;
  const input = resolve(process.env.FORGEAX_FIELD_REPLACEMENT_INPUTS);
  const row = JSON.parse(readFileSync(resolve(input, 'catalog-row.json'), 'utf8'));
  const guid = fieldGuid('field/constant/8');
  assert.equal(row.guid, guid);
  assert(row.revision, 'ordinary replacement producer must retain ResourceRevision');
  const report = { input, guid, stages: [], oracleBound: 2e-4, pixelBound: 0.05 };
  const persist = () => writeFileSync(resolve(output, 'lifecycle.json'), `${JSON.stringify(report, null, 2)}\n`);
  const record = name => {
    const state = { name, completedFrames: app.execution.report().frame.completed,
      host: host.inspect(world), ...counters() };
    report.stages.push(state); persist(); return state;
  };
  const baseline = unwrap(await createCatalogSource({ url: '/pack-index.json' }).enumerate());
  const rows = [...baseline];
  const listeners = new Set();
  let release;
  let artifactPending;
  const fetchPrepared = async request => {
    const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
    if (url.href === row.packageUrl) return new Response(readFileSync(resolve(input, 'fields.pack.json')));
    if (url.href === new URL('field.bin', row.packageUrl).href) {
      await artifactPending;
      return new Response(readFileSync(resolve(input, 'field.bin')));
    }
    return globalThis.fetch(request);
  };
  const source = {
    enumerate: async () => ok([...rows]),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    openPackage: () => fetchPrepared,
  };
  assets.setCatalogSource(source);
  unwrap(await assets.enumerateCatalog());
  const firstTexture = unwrap(await assets.load(assets.parseGuid(guid), 'texture'));
  const held = assets.snapshot(firstTexture).unwrap();
  const original = record('constant-60');
  assert.equal(original.fieldUploadBytes, original.fieldLiveBytes,
    'initial metadata and sample slices seed one retained field');
  assert.equal(original.completedFrames, 60);
  try {
    artifactPending = new Promise(resolvePending => { release = resolvePending; });
    const index = rows.findIndex(previous => previous.guid === guid);
    assert(index >= 0);
    rows[index] = row;
    for (const listener of listeners) listener({ added: [], changed: [row], removed: [] });
    const snapshot = assets.catalogSnapshot();
    report.replacementCatalog = snapshot;
    persist();
    assert.equal(snapshot.stale, false, 'replacement Catalog delta must be accepted');
    assert.equal(snapshot.entries.find(entry => entry.guid === guid)?.revision?.digest,
      row.revision.digest, 'accepted row must identify the prepared replacement bytes');
    // Join ordinary Catalog reconciliation before making the delayed-artifact
    // assertion. No engine deadline, frame count or acceptance threshold changes.
    await new Promise(resolveTurn => setTimeout(resolveTurn, 0));
    const loading = assets.reload(firstTexture, {conflict: 'reject'});
    await step(1);
    const pending = record('replacement-pending-61');
    assert.equal(pending.fieldUploads, original.fieldUploads);
    assert.equal(pending.fieldUploadBytes, original.fieldUploadBytes);
    assert.equal(pending.simulationUpdates, original.simulationUpdates + 1);
    release();
    unwrap(await loading);
    const current = assets.snapshot(firstTexture).unwrap();
    assert(current.version(firstTexture).unwrap() > held.version(firstTexture).unwrap(), 'reload advances the original texture version');
    current.dispose();
    await step(59);
    const capture = recorder.captureFrame();
    unwrap(await recorder.frameBoundary());
    await step(1);
    unwrap(await recorder.frameBoundary());
    const bytes = unwrap(await capture).bytes;
    writeFileSync(resolve(output, 'replacement-121.rhitape'), bytes);
    const tape = unwrap(decodeTape(bytes));
    const model = buildFrameModel(tape);
    const update = model.works.find(work => work.pipeline?.shaders?.some(shader => /^forgeax_vfx_update(?:_compact)?_main$/.test(shader.entryPoint ?? '')));
    assert(update);
    const core = update.bindings.find(binding => binding.binding === 0);
    const field = update.bindings.find(binding => binding.binding === 17);
    assert(core?.resourceId && field?.resourceId);
    const adapter = unwrap(await webgpu.rhi.requestAdapter());
    const replayDevice = unwrap(await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits)));
    const nativeReplayDevice = unwrap(replayDevice.nativeDevice());
    assert.notEqual(nativeReplayDevice, device, 'replay uses a fresh physical device');
    let replay;
    try {
      replay = unwrap(await openReplay(tape, { device: replayDevice, createShaderModule: webgpu.createShaderModule }));
      const read = unwrap(await replay.readResourceAtWork(core.resourceId, update.workIndex));
      writeFileSync(resolve(output, 'replacement-121-core.bin'), read.bytes);
      const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
      const records = Array.from({ length: 256 }, (_, id) => ({ id, expected: expectedRecord(id, 121),
        ...Object.fromEntries(['position', 'velocity'].map(name => [name, Array.from({ length: 3 }, (_, lane) =>
          data.getFloat32(id * VFX_PARTICLE_CORE_LAYOUT.stride + vfxParticleCoreField(name).offset + lane * 4, true))])) }));
      const maxError = Math.max(...records.flatMap(record => ['position', 'velocity'].flatMap(name =>
        record[name].map((value, lane) => Math.abs(value - record.expected[name][lane])))));
      const readField = unwrap(await replay.readResourceAtWork(field.resourceId, update.workIndex));
      writeFileSync(resolve(output, 'replacement-121-field.bin'), readField.bytes);
      assert.equal(new DataView(readField.bytes.buffer, readField.bytes.byteOffset, readField.bytes.byteLength).getFloat32(44 * 4, true), -0.5);
      const raster = model.works.findLast(work => work.kind.startsWith('draw'));
      assert(raster);
      const image = unwrap(await replay.inspectWork(raster.workIndex, ['pixels'])).attachment;
      assert(image);
      const decoded = unwrap(readbackImage(image));
      const rgba = toRgba8(decoded);
      const live = await readLivePixels();
      writeFileSync(resolve(output, 'replacement-121-replay.png'), encodePng(decoded.width, decoded.height, rgba));
      writeFileSync(resolve(output, 'replacement-121-live.png'), encodePng(512, 512, live));
      const pixelError = rgba.reduce((max, value, index) => Math.max(max, Math.abs(value - live[index]) / 255), 0);
      report.replacement = { ticks: 121, maxError, records, pixelError, digest: tapeDigest(bytes),
        workIndex: update.workIndex, bindings: update.bindings, resources: model.resources,
        unseededResources: model.unseededResources, freshDevice: true };
      persist();
      assert(maxError <= report.oracleBound);
      assert(pixelError <= report.pixelBound);
    } finally {
      try { if (replay !== undefined) unwrap(await replay.dispose()); }
      finally { nativeReplayDevice.destroy(); }
    }
    const accepted = record('replacement-accepted-121');
    assert.equal(accepted.fieldLiveBytes, original.fieldLiveBytes,
      'replacement retains the existing field allocation');
    assert(accepted.fieldUploadBytes > original.fieldUploadBytes,
      'replacement samples reach the GPU');
    assert(accepted.fieldUploadBytes - original.fieldUploadBytes <= accepted.fieldLiveBytes,
      'replacement uploads at most one complete field');
    unwrap(world.set(scene.player, ParticleEffectPlayer, { playing: false }));
    const beforeStopped = await readLivePixels();
    await step(60);
    const stopped = record('stopped-181');
    const afterStopped = await readLivePixels();
    report.stoppedPixelError = beforeStopped.reduce((max, value, index) => Math.max(max, Math.abs(value - afterStopped[index]) / 255), 0);
    persist();
    assert.equal(stopped.simulationUpdates, accepted.simulationUpdates);
    assert.equal(stopped.fieldUploads, accepted.fieldUploads);
    assert.equal(stopped.fieldUploadBytes, accepted.fieldUploadBytes);
    assert(report.stoppedPixelError <= report.pixelBound);
    unwrap(await host.detachWorld({ world }));
    await step(60);
    const detached = record('world-detached-241');
    assert.equal(detached.fieldLiveBytes, 0);
    assert.equal(detached.simulationUpdates, stopped.simulationUpdates);
    unwrap(await host.attachWorld({ world, assets }));
    await step(60);
    const rebuilt = record('world-rebuilt-stopped-301');
    assert.equal(rebuilt.simulationUpdates, detached.simulationUpdates, 'World rebuild never resurrects a stopped player');
    unwrap(world.despawn(scene.player));
    await step(60);
    const removed = record('removed-361');
    assert.equal(removed.fieldLiveBytes, 0);
    assert.equal(removed.host.players.length, 0);
    report.verdict = 'pass'; persist();
  } catch (error) {
    report.verdict = 'fail'; report.failure = String(error); persist(); throw error;
  } finally {
    release?.(); held.dispose(); assets.clearCatalogSource();
  }
}
