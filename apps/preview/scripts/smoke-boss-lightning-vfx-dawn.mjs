#!/usr/bin/env node
import { useBuiltAssetSource } from '../../shared/scripts/source-publication.mjs';
import { drawReadyFrame } from '../../../scripts/test/ready-render-frame.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupGpuShim } from '../../hello/triangle/scripts/smoke-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = resolve(ROOT, 'apps/preview/dist');
const reportDir = resolve(process.env.FORGEAX_BOSS_VFX_DAWN_DIR ?? resolve(ROOT, '.forgeax-debug/boss-lightning-dawn'));
mkdirSync(reportDir, { recursive: true });
const fail = (message, detail = {}) => { const report = { status: 'blocked', backend: 'dawn-node', message, ...detail }; writeFileSync(resolve(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); throw new Error(message); };
if (!existsSync(resolve(DIST, 'pack-index.json'))) fail('Preview dist/pack-index.json is missing; run build:app preview first.');
const shim = await setupGpuShim({ width: 256, height: 192, rerunCmd: 'pnpm --filter @forgeax/preview smoke:boss-lightning-vfx-dawn' });
const { createWorldContext, World } = await import('../../../packages/ecs/dist/index.mjs');
const { mat4 } = await import('../../../packages/math/dist/index.mjs');
const { Camera } = await import('../../../packages/render/dist/index.mjs');
const { Transform, scenePlugin } = await import('../../../packages/scene/dist/index.mjs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { loadVfxGpuEffect, ParticleEffectPlayer, VFX_GPU_RUNTIME_RESOURCE_KEY } = await import('../../../packages/vfx/dist/index.mjs');
const { createVfxRuntimeHost } = await import('../../../packages/vfx-render/dist/index.mjs');
const manifest = JSON.parse(readFileSync(resolve(DIST, 'shaders/manifest.json'), 'utf8'));
let cameraEntity;
const camera = { read(currentWorld) { const transform = currentWorld.get(cameraEntity, Transform); const value = currentWorld.get(cameraEntity, Camera); if (!transform.ok || !value.ok) return undefined; return { position: new Float32Array(transform.value.pos), right: new Float32Array([1, 0, 0]), up: new Float32Array([0, 1, 0]), viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), value.value.fov, value.value.aspect, value.value.near, value.value.far), mat4.lookAt(mat4.create(), transform.value.pos, [0, 0, 0], [0, 1, 0])) }; } };
const host = createVfxRuntimeHost({ camera });
const constructed = await constructRuntimeRendererHost(shim.mockCanvas, { features: [host.feature] }, { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` });
if (!constructed.ok) throw constructed.error;
const { renderer, assets } = constructed.value;
const world = new World({ assets });
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;
useBuiltAssetSource(assets, DIST);
const attached = await host.attach({ world, assets });
if (!attached.ok) fail(`Dawn VFX host attach failed: ${attached.error.hint}`);
cameraEntity = world.spawn({ component: Transform, data: { pos: [0, 1.2, 7.5] } }, { component: Camera, data: { fov: Math.PI / 3, aspect: 256 / 192, near: 0.1, far: 100 } }).unwrap();
const phaseGuids = ['019e9c00-0000-7000-8000-000000000100', '019e9c00-0000-7000-8000-000000000101', '019e9c00-0000-7000-8000-000000000102'];
const effects = [];
for (const guid of phaseGuids) { const loaded = await loadVfxGpuEffect(assets, guid); if (!loaded.ok) fail(`Dawn phase load failed: ${guid}`, { error: loaded.error }); effects.push(loaded.value); }
const emitterCount = effects.reduce((sum, effect) => sum + effect.program.emitters.length, 0);
const rendererKinds = [...new Set(effects.flatMap((effect) => effect.program.emitters.flatMap((emitter) => emitter.renderers.map((rendererEntry) => rendererEntry.kind))))].sort();
const player = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }, { component: ParticleEffectPlayer, data: { effect: (await assets.load(phaseGuids[0], 'particle-effect')).unwrap(), playing: true, seed: 42, timeScale: 1 } }).unwrap();
await createWorldContext(world, [scenePlugin()]);
const errors = []; let drawnFrames = 0;
const unsubscribe = renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });
for (let frame = 0; frame < 60; frame += 1) {
  world.update(1 / 60).unwrap();
  await drawReadyFrame(renderer, { leases: [attachment.value], camera: { lease: attachment.value }, environment: { lease: attachment.value } });
  drawnFrames += 1;
  await new Promise((resolve) => setImmediate(resolve));
}
await shim.sharedDevice?.queue.onSubmittedWorkDone();
const runtime = world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
const diagnostics = renderer.renderFeatureDiagnostics();
const report = { status: emitterCount === 13 && rendererKinds.join(',') === 'beam,billboard,mesh,ribbon,trail' && drawnFrames === 60 && diagnostics.some((entry) => entry.identity === 'forgeax.vfx-render.gpu-particles' && entry.status === 'active') && runtime.hasPlayer(player) && errors.length === 0, backend: 'dawn-node', drawnFrames, emitterCount, rendererKinds, phaseGuids, diagnostics, errors };
writeFileSync(resolve(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
unsubscribe();
attachment.value.dispose();
await host.detachWorld({ world });
await renderer.dispose();
assets.dispose();
if (!report.status) {
  shim.sharedDevice?.destroy?.();
  delete globalThis.navigator.gpu;
  throw new Error(`Boss Lightning Dawn smoke failed: ${JSON.stringify(report)}`);
}
console.log(`[boss-lightning-dawn] PASS - Dawn drew ${drawnFrames} frames with ${emitterCount} emitters and ${rendererKinds.length} renderer kinds`);
shim.sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
