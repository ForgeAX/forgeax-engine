import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { createServer, loadConfigFromFile } from 'vite';

const root = resolve(import.meta.dirname, '..');
const repoRoot = resolve(root, '../../..');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : process.env.FORGEAX_OUTPUT_DIR;
if (!outputPath) throw new Error('Pass --output <directory> or set FORGEAX_OUTPUT_DIR');
const output = resolve(outputPath);
mkdirSync(output, { recursive: true });

let server;
let browser;
const errors = [];
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'smoke' }, resolve(root, 'vite.config.ts'));
  assert(loaded, 'Body Demo Vite config missing');
  server = await createServer({
    ...loaded.config,
    configFile: false,
    root,
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert(url, 'Body Demo URL missing');
  browser = await chromium.launch({
    ...browserLaunch,
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: [
      '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits', '--autoplay-policy=no-user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(new URL('?smoke', url).href, { waitUntil: 'domcontentloaded' });
  const waitForFrames = async (count) => {
    await page.waitForFunction((minimum) => Number(document.querySelector('#frame-count')?.textContent ?? 0) >= minimum || document.body.dataset.error, count, { timeout: 180_000 });
    const state = await page.evaluate(() => ({ error: document.body.dataset.error, frames: Number(document.querySelector('#frame-count')?.textContent ?? 0) }));
    assert.equal(state.error, undefined, JSON.stringify({ state, errors }));
    assert(state.frames >= count, JSON.stringify(state));
  };
  await waitForFrames(12);
  const waitForAccepted = async (entityIndex, condition, baseline) => {
    try {
      await page.waitForFunction(({ entityIndex: index, condition: test, baseline: generation }) => {
      const demo = window.__waterBodyDemo;
      const entity = demo?.bodies[index]?.entities[0];
      if (entity === undefined) return false;
      const guid = `scene-entity:${entity}`;
      const snapshot = demo.world.getResource('WaterSystem').snapshot(guid);
      const physics = demo.world.getResource('PhysicsWorld');
      const receipt = physics.getDerivedCollisionReceipt?.(entity);
      if (!snapshot) return false;
      if (test === 'initial-river') return snapshot.outputs.geometry === 'ready' && snapshot.outputs.query === 'ready' && snapshot.outputs.collision === 'ready' && receipt?.sourceKey === `water:scene-entity:${entity}` && receipt.publication.revision === snapshot.outputGenerations.collision;
      if (test === 'recooked-river') return snapshot.sceneGeneration > generation && snapshot.outputs.geometry === 'ready' && snapshot.outputs.query === 'ready' && snapshot.outputs.collision === 'ready' && receipt?.sourceKey === `water:scene-entity:${entity}` && receipt.publication.revision === snapshot.outputGenerations.collision;
      if (test === 'custom-trimesh') return snapshot.outputs.collision === 'ready' && receipt?.shapes.some((shape) => shape.kind === 'trimesh');
      return false;
      }, { entityIndex, condition, baseline }, { timeout: 30_000, polling: 100 });
    } catch (error) {
      const diagnostic = await page.evaluate((index) => {
        const demo = window.__waterBodyDemo;
        const entity = demo?.bodies[index]?.entities[0];
        return entity === undefined ? { bodyCount: demo?.bodies.length } : {
          entity,
          snapshot: (() => { const value = demo.world.getResource('WaterSystem').snapshot(`scene-entity:${entity}`); const original = demo.app.assets.read(demo.bodies[index].bodyHandle).unwrap(); const brief = (result) => result.ok ? { ok: true } : { ok: false, expected: result.error.expected, hint: result.error.hint, detail: result.error.detail }; const keyDiffs = []; const compareKeys = (left, right, path = '$') => { if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return; for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) { if (!(key in left)) keyDiffs.push({ path: `${path}.${key}`, change: 'added' }); else if (!(key in right)) keyDiffs.push({ path: `${path}.${key}`, change: 'removed' }); else compareKeys(left[key], right[key], `${path}.${key}`); } }; compareKeys(original, value.asset); return { outputs: value.outputs, outputGenerations: value.outputGenerations, outputReceipts: value.outputReceipts, dirty: [...value.dirty], dependencies: value.dependencies.map(({ guid, kind, field, status, version }) => ({ guid, kind, field, status, version })), geometryVersion: value.asset.waterGeometryVersion, splineVersion: value.asset.spline.interpolationVersion, keyDiffs, originalValidation: brief(demo.validateWaterAsset(original)), snapshotValidation: brief(demo.validateWaterAsset(value.asset)), candidate: brief(demo.buildWaterPhysicsCandidateInput({ entity, sourceKey: `water:${value.guid}`, revision: value.outputGenerations.collision, body: value.asset, bodyWorldMatrixM: value.worldMatrixM, exclusionVolumes: value.exclusionVolumes })) }; })(),
          sceneStatus: demo.world.getResource('WaterSceneStatus'),
          physicsStatus: demo.world.getResource('PhysicsWorld').getDerivedCollisionReceipt?.(entity),
          ui: { status: document.querySelector('#status')?.textContent, pointCount: demo.bodies[index].draftSpline.points.length, pointX: demo.bodies[index].draftSpline.points[1]?.positionM[0], pointInput: document.querySelector('#point-x')?.value },
        };
      }, entityIndex);
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
    }
  };
  const sample = () => page.evaluate(() => {
    const demo = window.__waterBodyDemo;
    const water = demo.world.getResource('WaterSystem');
    const physics = demo.world.getResource('PhysicsWorld');
    return demo.bodies.map((entry) => {
      const entity = entry.entities[0];
      const snapshot = water.snapshot(`scene-entity:${entity}`);
      const receipt = physics.getDerivedCollisionReceipt?.(entity);
      const visiblePositions = entry.meshes.flatMap((handle) => {
        const mesh = demo.app.assets.read(handle).unwrap();
        const positions = mesh.attributes.position;
        const points = [];
        for (let offset = 0; offset < positions.length; offset += 3) points.push([0, 1, 2].map((axis) => entry.position[axis] + positions[offset + axis] * entry.scale[axis]));
        return points;
      });
      const visibleBoundsM = visiblePositions.length ? [0, 1, 2].map((axis) => [
        Math.min(...visiblePositions.map((point) => point[axis])),
        Math.max(...visiblePositions.map((point) => point[axis])),
      ]) : undefined;
      return {
        type: entry.body.type,
        entity,
        sourceVersion: snapshot?.sourceVersion,
        sceneGeneration: snapshot?.sceneGeneration,
        outputGenerations: snapshot?.outputGenerations,
        outputs: snapshot?.outputs,
        meshHandles: entry.meshes.map((handle) => Number(handle)),
        scale: [...entry.scale],
        splineMetadata: entry.body.spline.points.map(({ widthM, depthM, velocityMPerSec, audioIntensity }) => ({ widthM, depthM, velocityMPerSec, audioIntensity })),
        visibleBoundsM,
        visibleMeshGuids: entry.body.riverSegmentMeshGuids ?? (entry.body.visibleMeshGuid ? [entry.body.visibleMeshGuid] : []),
        receipt: receipt && { sourceKey: receipt.sourceKey, revision: receipt.publication.revision, digest: receipt.publication.inputDigest, shapes: receipt.shapes.map((shape) => ({ kind: shape.kind, id: shape.id, revision: shape.revision, pieceCount: shape.kind === 'convex-compound' ? shape.pieces.length : undefined, vertexCount: shape.kind === 'trimesh' ? shape.vertices.length / 3 : undefined })) },
      };
    });
  });
  await waitForAccepted(0, 'initial-river');

  const beforeRiver = (await sample())[0];
  await page.locator('#spline-point').selectOption('0');
  await page.locator('#point-copy').click();
  await page.locator('#spline-point').selectOption('1');
  await page.locator('#point-x').fill('-8.5');
  for (const [selector, value] of [['#point-width', '9.5'], ['#point-depth', '7.25'], ['#point-velocity', '3.5'], ['#point-audio', '0.65']])
    await page.locator(selector).fill(value);
  for (const [selector, value] of [['#scale-x', '1.15'], ['#scale-y', '1.05'], ['#scale-z', '0.9']])
    await page.locator(selector).fill(value);
  await page.evaluate(() => window.__waterBodyDemo.injectNextRecookFailureBeforeCommit());
  await page.locator('#recook').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('injected failure before Pack and Scene consumer commit'), { timeout: 30_000 });
  const afterFailedRiver = (await sample())[0];
  assert.equal(afterFailedRiver.sceneGeneration, beforeRiver.sceneGeneration, 'rejected Pack preparation must retain the prior Water scene generation');
  assert.deepEqual(afterFailedRiver.outputGenerations, beforeRiver.outputGenerations, 'rejected Pack preparation must retain all accepted output generations');
  assert.equal(afterFailedRiver.receipt.digest, beforeRiver.receipt.digest, 'rejected Pack preparation must retain the prior collision receipt');
  assert.deepEqual(afterFailedRiver.meshHandles, beforeRiver.meshHandles, 'rejected Pack preparation must retain the prior visible mesh consumer handles');
  assert.deepEqual(afterFailedRiver.visibleMeshGuids, beforeRiver.visibleMeshGuids, 'rejected Pack preparation must retain the prior visible mesh GUIDs');
  await page.locator('#recook').click();
  await waitForAccepted(0, 'recooked-river', beforeRiver.sceneGeneration);
  const afterRiver = (await sample())[0];
  assert(afterRiver.sceneGeneration > beforeRiver.sceneGeneration);
  assert(afterRiver.outputGenerations.geometry > beforeRiver.outputGenerations.geometry);
  assert(afterRiver.outputGenerations.query > beforeRiver.outputGenerations.query);
  assert(afterRiver.receipt.revision === afterRiver.outputGenerations.collision);
  assert.deepEqual(afterRiver.scale, [1.15, 1.05, 0.9], 'River recook must accept independent actor scale');
  assert(afterRiver.splineMetadata[1].widthM === 9.5 && afterRiver.splineMetadata[1].depthM === 7.25
    && afterRiver.splineMetadata[1].velocityMPerSec === 3.5 && afterRiver.splineMetadata[1].audioIntensity === 0.65,
  `River recook must accept all four spline metadata fields: ${JSON.stringify(afterRiver.splineMetadata)}`);
  assert(afterRiver.visibleBoundsM?.every(([min, max]) => Number.isFinite(min) && Number.isFinite(max) && max > min),
    `River recook must report finite non-empty world bounds: ${JSON.stringify(afterRiver.visibleBoundsM)}`);

  await page.locator('.body-focus').nth(2).click();
  const beforeOcean = (await sample())[2];
  const oceanProbeBefore = await page.evaluate(() => {
    const demo = window.__waterBodyDemo;
    const entry = demo.bodies[2];
    const physics = demo.world.getResource('PhysicsWorld');
    const points = [];
    for (let xOffset = 1; xOffset <= 7; xOffset++) for (let zOffset = -3; zOffset <= 3; zOffset++) {
      const x = entry.position[0] + xOffset;
      const z = entry.position[2] + zOffset;
      const hit = physics.raycast(new Float32Array([x, 24, z]), new Float32Array([0, -1, 0]), 60);
      points.push({ point: [x, z], hitEntity: hit?.entity });
    }
    const contacts = physics.getCurrentContacts?.(demo.probe);
    return { points, oceanEntity: entry.entities[0], oceanContacts: contacts?.ok ? contacts.value.manifolds.filter((manifold) => manifold.other === entry.entities[0]).length : null };
  });
  await page.locator('#exclusion').click();
  await page.waitForFunction((previous) => {
    const demo = window.__waterBodyDemo;
    const entity = demo.bodies[2].entities[0];
    const snapshot = demo.world.getResource('WaterSystem').snapshot(`scene-entity:${entity}`);
    const receipt = demo.world.getResource('PhysicsWorld').getDerivedCollisionReceipt?.(entity);
    return snapshot?.outputGenerations.query > previous.query
      && snapshot.outputs.query === 'ready'
      && snapshot.outputs.collision === 'ready'
      && receipt?.publication.revision === snapshot.outputGenerations.collision;
  }, { query: beforeOcean.outputGenerations.query }, { timeout: 30_000, polling: 100 });
  const afterOcean = (await sample())[2];
  const oceanProbeAfter = await page.evaluate(() => {
    const demo = window.__waterBodyDemo;
    const entry = demo.bodies[2];
    const physics = demo.world.getResource('PhysicsWorld');
    const points = [];
    for (let xOffset = 1; xOffset <= 7; xOffset++) for (let zOffset = -3; zOffset <= 3; zOffset++) {
      const x = entry.position[0] + xOffset;
      const z = entry.position[2] + zOffset;
      const hit = physics.raycast(new Float32Array([x, 24, z]), new Float32Array([0, -1, 0]), 60);
      points.push({ point: [x, z], hitEntity: hit?.entity });
    }
    const contacts = physics.getCurrentContacts?.(demo.probe);
    return { points, oceanEntity: entry.entities[0], oceanContacts: contacts?.ok ? contacts.value.manifolds.filter((manifold) => manifold.other === entry.entities[0]).length : null };
  });
  const oceanRayDifference = oceanProbeBefore.points.find((before, index) => before.hitEntity === oceanProbeBefore.oceanEntity && oceanProbeAfter.points[index]?.hitEntity !== oceanProbeAfter.oceanEntity);
  assert(oceanRayDifference, `Expected an Ocean ray hit to disappear after exclusion: ${JSON.stringify({ before: oceanProbeBefore, after: oceanProbeAfter })}`);
  assert.notDeepEqual(oceanProbeAfter.oceanContacts, oceanProbeBefore.oceanContacts, 'Ocean probe contacts must change when its collision is excluded');
  assert(afterOcean.receipt.revision > beforeOcean.receipt.revision);
  assert.notEqual(afterOcean.receipt.digest, beforeOcean.receipt.digest);
  assert(afterOcean.receipt.shapes.length > 0);
  await page.locator('#exclusion').click();
  await page.waitForFunction((previous) => {
    const demo = window.__waterBodyDemo;
    const entity = demo.bodies[2].entities[0];
    const snapshot = demo.world.getResource('WaterSystem').snapshot(`scene-entity:${entity}`);
    const receipt = demo.world.getResource('PhysicsWorld').getDerivedCollisionReceipt?.(entity);
    return snapshot?.outputGenerations.query > previous.query
      && snapshot.outputs.query === 'ready'
      && snapshot.outputs.collision === 'ready'
      && receipt?.publication.revision === snapshot.outputGenerations.collision
      && receipt.publication.revision > previous.revision;
  }, { query: afterOcean.outputGenerations.query, revision: afterOcean.receipt.revision }, { timeout: 30_000, polling: 100 });
  const oceanProbeRestored = await page.evaluate(({ point }) => {
    const demo = window.__waterBodyDemo;
    const entry = demo.bodies[2];
    const hit = demo.world.getResource('PhysicsWorld').raycast(new Float32Array([point[0], 24, point[1]]), new Float32Array([0, -1, 0]), 60);
    const snapshot = demo.world.getResource('WaterSystem').snapshot(`scene-entity:${entry.entities[0]}`);
    const receipt = demo.world.getResource('PhysicsWorld').getDerivedCollisionReceipt?.(entry.entities[0]);
    return { point, hitEntity: hit?.entity, oceanEntity: entry.entities[0], snapshotQueryGeneration: snapshot?.outputGenerations.query, receiptRevision: receipt?.publication.revision, receiptDigest: receipt?.publication.inputDigest };
  }, { point: oceanRayDifference.point });
  assert.equal(oceanProbeRestored.hitEntity, oceanProbeRestored.oceanEntity, `Ocean must reclaim the same ray point after exclusion removal: ${JSON.stringify(oceanProbeRestored)}`);
  assert(oceanProbeRestored.receiptRevision > afterOcean.receipt.revision, 'Restored Ocean collision must publish a newer Physics receipt');

  await page.locator('.body-focus').nth(3).click();
  await waitForAccepted(3, 'custom-trimesh');
  await page.locator('#raycast').click();
  await page.waitForFunction(() => document.querySelector('#raycast-state')?.textContent?.includes('Physics rev'));
  const customEvidence = await page.evaluate(() => {
    const demo = window.__waterBodyDemo;
    const entry = demo.bodies[3];
    const receipt = demo.world.getResource('PhysicsWorld').getDerivedCollisionReceipt?.(entry.entities[0]);
    return {
      raycast: document.querySelector('#raycast-state')?.textContent,
      physicsDetail: document.querySelector('#physics-detail')?.textContent,
      collisionMeshGuid: entry.body.collision.meshGuid,
      receipt: receipt && { sourceKey: receipt.sourceKey, revision: receipt.publication.revision, shapes: receipt.shapes.map((shape) => ({ kind: shape.kind, id: shape.id, revision: shape.revision, vertexCount: shape.kind === 'trimesh' ? shape.vertices.length / 3 : undefined })) },
    };
  });
  assert.match(customEvidence.raycast ?? '', /Physics rev/);
  assert(customEvidence.receipt?.shapes.some((shape) => shape.kind === 'trimesh'), `Custom collision must retain a trimesh Physics receipt: ${JSON.stringify(customEvidence)}`);

  const changedPixelCount = (beforeBytes, afterBytes) => {
    const before = PNG.sync.read(beforeBytes);
    const after = PNG.sync.read(afterBytes);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    let changed = 0;
    for (let offset = 0; offset < before.data.length; offset += 4) {
      if (Math.abs(before.data[offset] - after.data[offset]) > 3 || Math.abs(before.data[offset + 1] - after.data[offset + 1]) > 3 || Math.abs(before.data[offset + 2] - after.data[offset + 2]) > 3) changed++;
    }
    return changed;
  };
  const productEvidence = [];
  const productPanels = page.locator('#panels');
  for (const [bodyIndex, bodyName] of [[0, 'river'], [1, 'lake'], [2, 'ocean']]) {
    if (await productPanels.getAttribute('aria-expanded') === 'false') await productPanels.click();
    await page.locator('.body-focus').nth(bodyIndex).click();
    const evidenceFraming = await page.evaluate((index) => window.__waterBodyDemo.setProductEvidenceView(index), bodyIndex);
    if (await productPanels.getAttribute('aria-expanded') !== 'false') await productPanels.click();
    await page.evaluate(() => document.querySelector('#product-switch button[data-product="visible"]').click());
    await waitForFrames(Number(await page.locator('#frame-count').textContent()) + 2);
    const baselinePixels = await page.screenshot({ fullPage: true });
    for (const mode of ['water-info', 'dilated']) {
      const productButton = page.locator(`#product-switch button[data-product="${mode}"]`);
      assert.equal(await productButton.isDisabled(), false, `${bodyName} must expose ${mode}`);
      await page.evaluate((product) => document.querySelector(`#product-switch button[data-product="${product}"]`).click(), mode);
      await waitForFrames(Number(await page.locator('#frame-count').textContent()) + 2);
      assert.equal(await productButton.getAttribute('aria-pressed'), 'true', `${bodyName}/${mode} product switch must be active`);
      const productPixels = await page.screenshot({ fullPage: true });
      const changedPixels = changedPixelCount(baselinePixels, productPixels);
      const productState = changedPixels === 0 ? await page.evaluate(({ index, framing }) => {
        const demo = window.__waterBodyDemo;
        const entry = demo.bodies[index];
        return {
          selected: document.querySelector('#focus-state')?.textContent,
          pressed: [...document.querySelectorAll('#product-switch button')].map((button) => [button.dataset.product, button.getAttribute('aria-pressed'), button.disabled]),
          visible: entry.visible,
          evidenceFraming: framing,
          entities: entry.entities.map((entity) => ({ entity, disabled: demo.world.hasComponent(entity, demo.Disabled), meshFilter: demo.world.hasComponent(entity, demo.MeshFilter) })),
          debugMeshes: entry.debugMeshes.map((mesh) => ({ kind: mesh.kind, entity: mesh.entity, disabled: mesh.entity === undefined ? true : demo.world.hasComponent(mesh.entity, demo.Disabled) })),
          frames: document.querySelector('#frame-count')?.textContent,
          camera: demo.app.renderer.inspect().frame.frameId,
        };
      }, { index: bodyIndex, framing: evidenceFraming }) : undefined;
      if (changedPixels === 0) {
        writeFileSync(resolve(output, `debug-${bodyName}-visible.png`), baselinePixels);
        writeFileSync(resolve(output, `debug-${bodyName}-${mode}.png`), productPixels);
      }
      assert(changedPixels > 0, `${bodyName}/${mode} must change rendered pixels from the isolated visible body: ${JSON.stringify(productState)}`);
      const modeCapture = await page.evaluate(async ({ bodyIndex: index, mode: product }) => {
        const demo = window.__waterBodyDemo;
        const entry = demo.bodies[index];
        const target = entry.debugMeshes.find((mesh) => mesh.kind === product);
        if (!target) throw new Error(`${entry.body.type} lacks ${product} mesh`);
        const mesh = demo.app.assets.read(target.handle).unwrap();
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength)));
        const vertexHash = `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        const indexBytes = mesh.indices ? new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength) : new Uint8Array();
        const indexDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', indexBytes));
        const indexHash = `sha256:${Array.from(indexDigest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        const result = await demo.app.rhiCapture.captureFrame();
        if (!result.ok) throw result.error;
        const tape = result.value.bytes;
        let binary = '';
        for (let offset = 0; offset < tape.length; offset += 16384) binary += String.fromCharCode(...tape.subarray(offset, offset + 16384));
        const submitted = result.value.submittedFrame;
        const backendKind = demo.app.renderer.inspect().capabilities.backendKind;
        return {
          tape: btoa(binary), digest: result.value.digest,
          receipt: submitted.status === 'complete' ? { status: submitted.status, frameId: submitted.receipt.frameId, deviceGeneration: submitted.receipt.deviceGeneration, captureGeneration: submitted.captureGeneration } : submitted,
          backendKind,
          mesh: { guid: target.guid, kind: target.kind, vertexHash, indexHash, vertexBytes: mesh.vertices.byteLength, vertexCount: mesh.attributes.position.length / 3, indexCount: mesh.indices?.length ?? 0, indexBytes: mesh.indices?.byteLength ?? 0 },
        };
      }, { bodyIndex, mode });
      const modeTape = Buffer.from(modeCapture.tape, 'base64');
      assert.equal(`sha256:${createHash('sha256').update(modeTape).digest('hex')}`, modeCapture.digest);
      const modeModel = buildFrameModel(decodeTape(modeTape).unwrap());
      const modeResources = new Map(modeModel.resources.map((resource) => [resource.resourceId, resource]));
      const modeSeeds = new Map(decodeTape(modeTape).unwrap().bootstrap.map((resource) => [resource.handleId, resource.initialData?.map((row) => row.hash) ?? []]));
      const modeDraws = modeModel.works.filter((work) => ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].includes(work.kind)).map((work) => ({
        workIndex: work.workIndex,
        kind: work.kind,
        passIndex: work.passIndex,
        pipelineLabel: work.pipeline?.descriptor?.desc?.label,
        drawCall: work.drawCall,
        vertexBuffers: work.vertexBuffers.map((binding) => ({ label: modeResources.get(binding.bufferHandleId)?.descriptor?.desc?.label, size: modeResources.get(binding.bufferHandleId)?.descriptor?.desc?.size, hash: modeSeeds.get(binding.bufferHandleId)?.[0] })),
        indexBuffer: work.indexBuffer && { label: modeResources.get(work.indexBuffer.bufferHandleId)?.descriptor?.desc?.label, format: work.indexBuffer.format, offset: work.indexBuffer.offset, size: modeResources.get(work.indexBuffer.bufferHandleId)?.descriptor?.desc?.size, hash: modeSeeds.get(work.indexBuffer.bufferHandleId)?.[0] },
        attachments: work.attachments,
      }));
      const matching = modeDraws.filter((draw) => draw.vertexBuffers.some((binding) => binding.hash === modeCapture.mesh.vertexHash));
      assert(matching.length > 0, `${bodyName}/${mode} Pack Mesh ${modeCapture.mesh.guid} has no RHI draw`);
      const matchingColorDraws = matching.filter((draw) => {
        const indexed = draw.indexBuffer?.size === modeCapture.mesh.indexBytes
          && draw.indexBuffer.format === 'uint32'
          && draw.indexBuffer.hash === modeCapture.mesh.indexHash;
        const drawParameters = draw.kind === 'drawIndexed'
          ? draw.drawCall.indexCount === modeCapture.mesh.indexCount
          : draw.kind === 'drawIndexedIndirect'
            ? typeof draw.drawCall.indirectBufferHandleId === 'string'
              && Number.isInteger(draw.drawCall.indirectOffset)
              && (modeResources.get(draw.drawCall.indirectBufferHandleId)?.descriptor?.desc?.size ?? 0) >= draw.drawCall.indirectOffset + 20
            : false;
        return draw.pipelineLabel === 'pbr-pipeline-forgeax::default-unlit'
          && draw.vertexBuffers.some((binding) => binding.size === modeCapture.mesh.vertexBytes)
          && indexed && drawParameters && draw.attachments?.colorViewHandleIds.length;
      });
      assert(matchingColorDraws.length > 0, `${bodyName}/${mode} has no indexed color draw with the expected Pack Mesh buffers: ${JSON.stringify({ mesh: modeCapture.mesh, matching })}`);
      assert.equal(modeCapture.receipt.status, 'complete', `${bodyName}/${mode} RHI capture must have a completed FrameReceipt`);
      assert.equal(modeCapture.backendKind, 'webgpu', `${bodyName}/${mode} capture must use the WebGPU backend`);
      writeFileSync(resolve(output, `body-${bodyName}-${mode}.rhitape`), modeTape);
      const modeScreenshot = `body-${bodyName}-${mode}.png`;
      writeFileSync(resolve(output, modeScreenshot), productPixels);
      const screenshotFrameId = await page.evaluate(() => window.__waterBodyDemo.app.renderer.inspect().frame.frameId);
      productEvidence.push({ body: bodyName, mode, mesh: modeCapture.mesh, tape: `body-${bodyName}-${mode}.rhitape`, digest: modeCapture.digest, frameReceipt: modeCapture.receipt, screenshot: modeScreenshot, screenshotFrameId, screenshotTapeFrameRelation: screenshotFrameId === modeCapture.receipt.frameId ? 'same frame id' : 'fixed-state paired, distinct frame ids', changedPixelsFromVisibleBody: changedPixels, colorDraws: matchingColorDraws.map((draw) => ({ workIndex: draw.workIndex, kind: draw.kind, pipelineLabel: draw.pipelineLabel, vertexBuffers: draw.vertexBuffers.filter((binding) => binding.hash === modeCapture.mesh.vertexHash), indexBuffer: draw.indexBuffer, drawCall: draw.drawCall, attachments: draw.attachments })), matchingDraws: matching.map((draw) => ({ workIndex: draw.workIndex, kind: draw.kind, passIndex: draw.passIndex, pipelineLabel: draw.pipelineLabel, vertexBuffers: draw.vertexBuffers.filter((binding) => binding.hash === modeCapture.mesh.vertexHash), indexBuffer: draw.indexBuffer, drawCall: draw.drawCall, attachments: draw.attachments })) });
    }
  }
  if (await productPanels.getAttribute('aria-expanded') === 'false') await productPanels.click();
  await page.evaluate(() => window.__waterBodyDemo.setProductEvidenceView(null));
  await page.locator('.body-focus').nth(3).click();
  for (const mode of ['water-info', 'dilated']) assert.equal(await page.locator(`#product-switch button[data-product="${mode}"]`).isDisabled(), true, `Custom must not participate in ${mode}`);

  await page.locator('#show-all').click();
  await page.locator('#product-switch button[data-product="visible"]').click();
  await page.locator('#reset-view').click();
  const hidePanel = async () => {
    const toggle = page.locator('#panels');
    if (await toggle.getAttribute('aria-expanded') !== 'false') await toggle.click();
    const state = await page.evaluate(() => ({
      hidden: document.body.classList.contains('panel-hidden'),
      panelDisplay: getComputedStyle(document.querySelector('.inspector')).display,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(state.hidden, true);
    assert.equal(state.panelDisplay, 'none');
    assert.equal(state.horizontalOverflow, false);
  };
  const colorCounts = (bytes) => {
    const image = PNG.sync.read(bytes);
    const counts = Object.fromEntries(['river', 'lake', 'ocean', 'custom'].map((name) => [name, { pixels: 0, minX: image.width, minY: image.height, maxX: -1, maxY: -1 }]));
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2], a = image.data[offset + 3];
      if (a < 240) continue;
      const x = (offset / 4) % image.width;
      const y = Math.floor(offset / 4 / image.width);
      const name = r < 100 && g > 120 && b > 130 ? 'river'
        : g > r * 1.22 && g > b * 0.9 && g > 90 ? 'lake'
        : b > r * 1.45 && b > g * 1.1 && b > 100 ? 'ocean'
        : r > 140 && g > 70 && r > b * 1.35 ? 'custom'
        : undefined;
      if (!name) continue;
      const bounds = counts[name];
      bounds.pixels++;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    return counts;
  };
  const screenshots = [];
  const viewports = [['body-desktop.png', { width: 1920, height: 960 }]];
  if (process.argv.includes('--include-mobile')) viewports.push(['body-mobile.png', { width: 390, height: 844 }]);
  for (const [name, viewport] of viewports) {
    await page.setViewportSize(viewport);
    await waitForFrames(Number(await page.locator('#frame-count').textContent()) + 2);
    await hidePanel();
    const bytes = await page.screenshot({ fullPage: true });
    writeFileSync(resolve(output, name), bytes);
    const counts = colorCounts(bytes);
    assert(Object.values(counts).every((bounds) => bounds.pixels > 20 && bounds.minX > 2 && bounds.minY > 2 && bounds.maxX < viewport.width - 3 && bounds.maxY < viewport.height - 3), `${name}: expected all four Body colors with complete, non-edge-clipped bounds, got ${JSON.stringify(counts)}`);
    screenshots.push({ file: name, viewport, panelsHidden: true, colorPixelCounts: counts });
  }
  const meshAssets = await page.evaluate(async () => Promise.all(window.__waterBodyDemo.bodies.map(async (entry) => Promise.all(entry.meshes.map(async (handle, index) => {
    const mesh = window.__waterBodyDemo.app.assets.read(handle).unwrap();
    const digest = async (value) => {
      if (!value) return undefined;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };
    return { guid: entry.body.riverSegmentMeshGuids?.[index] ?? entry.body.visibleMeshGuid, vertexBytes: mesh.vertices.byteLength, vertexHash: await digest(mesh.vertices), vertexCount: mesh.attributes.position.length / 3, indexCount: mesh.indices?.length ?? 0, indexHash: await digest(mesh.indices) };
  })))));
  const capture = await page.evaluate(async () => {
    const app = window.__waterBodyDemo.app;
    const backendKind = app.renderer.inspect().capabilities.backendKind;
    if (backendKind !== 'webgpu') throw new Error(`Expected WebGPU backend, received ${backendKind}`);
    if (!app.rhiCapture?.captureFrame) throw new Error('App.rhiCapture unavailable');
    const result = await app.rhiCapture.captureFrame();
    if (!result.ok) throw result.error;
    const bytes = result.value.bytes;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const submitted = result.value.submittedFrame;
    const receipt = submitted.status === 'complete'
      ? { status: submitted.status, frameId: submitted.receipt.frameId, deviceGeneration: submitted.receipt.deviceGeneration, captureGeneration: submitted.captureGeneration }
      : submitted;
    return { base64: btoa(binary), digest: result.value.digest, receipt, backendKind, rendererCapabilities: app.renderer.inspect().capabilities, screenshotFrameId: app.renderer.inspect().frame.frameId };
  });
  const tapeBytes = Buffer.from(capture.base64, 'base64');
  const calculatedDigest = createHash('sha256').update(tapeBytes).digest('hex');
  assert.equal(`sha256:${calculatedDigest}`, capture.digest, 'capture digest must match exact Tape bytes');
  assert.equal(capture.receipt.status, 'complete', 'RHI capture must include a completed FrameReceipt');
  const decoded = decodeTape(tapeBytes).unwrap();
  const model = buildFrameModel(decoded);
  const resources = new Map(model.resources.map((resource) => [resource.resourceId, resource]));
  const initialDataHashes = new Map(decoded.bootstrap.map((resource) => [resource.handleId, resource.initialData?.map((row) => row.hash) ?? []]));
  const drawWorks = model.works.filter((work) => ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].includes(work.kind));
  const draws = drawWorks.map((work) => ({
    workIndex: work.workIndex,
    kind: work.kind,
    passIndex: work.passIndex,
    draw: work.drawCall,
    pipeline: { status: work.pipeline?.status, pipelineHandleId: work.pipeline?.pipelineHandleId, label: work.pipeline?.descriptor?.desc?.label, topology: work.pipeline?.descriptor?.desc?.primitive?.topology },
    vertexBuffers: work.vertexBuffers.map((binding) => ({ ...binding, descriptor: resources.get(binding.bufferHandleId)?.descriptor?.desc, initialDataHashes: initialDataHashes.get(binding.bufferHandleId) ?? [] })),
    indexBuffer: work.indexBuffer && { ...work.indexBuffer, descriptor: resources.get(work.indexBuffer.bufferHandleId)?.descriptor?.desc, initialDataHashes: initialDataHashes.get(work.indexBuffer.bufferHandleId) ?? [] },
    attachments: work.attachments,
  }));
  assert(draws.length > 0, 'captured FrameModel must contain real draw work');
  assert(draws.some((draw) => draw.pipeline?.status === 'available' && (draw.vertexBuffers.length > 0 || draw.indexBuffer !== null) && (draw.attachments?.colorViewHandleIds.length ?? 0) > 0), 'captured draw must bind a pipeline, geometry input and color attachment');
  const meshDraws = meshAssets.map((entryMeshes, bodyIndex) => {
    const matches = entryMeshes.map((mesh) => {
      const matchingDraws = draws.filter((draw) => draw.vertexBuffers.some((binding) => binding.initialDataHashes.includes(mesh.vertexHash)));
      assert(matchingDraws.length > 0, `Body ${bodyIndex} Pack Mesh ${mesh.guid} has no RHI vertex-buffer draw matching ${mesh.vertexHash}`);
      assert(matchingDraws.every((draw) => draw.pipeline?.status === 'available' && draw.pipeline.topology === 'triangle-list' && draw.vertexBuffers.some((binding) => binding.descriptor?.size === mesh.vertexBytes) && draw.indexBuffer?.descriptor?.size === mesh.indexCount * 4 && draw.indexBuffer.initialDataHashes.includes(mesh.indexHash) && (draw.attachments?.colorViewHandleIds.length ?? 0) > 0), `Body ${bodyIndex} Mesh ${mesh.guid} draw lacks its indexed vertex range, pipeline or color attachment`);
      return { guid: mesh.guid, vertexHash: mesh.vertexHash, indexHash: mesh.indexHash, vertexCount: mesh.vertexCount, indexCount: mesh.indexCount, workIndices: matchingDraws.map((draw) => draw.workIndex), passIndices: matchingDraws.map((draw) => draw.passIndex), pipelineLabels: [...new Set(matchingDraws.map((draw) => draw.pipeline.label))] };
    });
    return { body: ['river', 'lake', 'ocean', 'custom'][bodyIndex], meshes: matches };
  });
  const customCollisionMesh = meshAssets[3]?.find((mesh) => mesh.guid.toLowerCase() === customEvidence.collisionMeshGuid?.toLowerCase());
  assert(customCollisionMesh, `Custom trimesh receipt source ${customEvidence.collisionMeshGuid} must map to a Pack mesh asset`);
  assert(meshDraws[3]?.meshes.some((mesh) => mesh.guid.toLowerCase() === customEvidence.collisionMeshGuid.toLowerCase()), 'Custom collision Pack mesh GUID must map to an RHI draw');
  const unseededResourceProvenance = model.unseededResources.map((resource) => {
    if (resource.kind === 'buffer') return {
      resourceId: resource.resourceId,
      descriptor: resources.get(resource.resourceId)?.descriptor?.desc,
      producerCopies: decoded.events.filter((event) => event.kind === 'copyBufferToBuffer' && event.destinationHandleId === resource.resourceId).map((event) => ({ sourceHandleId: event.sourceHandleId, sourceOffset: event.sourceOffset, destinationOffset: event.destinationOffset, size: event.size })),
      meshDrawInput: draws.some((draw) => draw.vertexBuffers.some((binding) => binding.bufferHandleId === resource.resourceId) || draw.indexBuffer?.bufferHandleId === resource.resourceId),
    };
    const views = model.resources.filter((candidate) => candidate.descriptor?.sourceHandleId === resource.resourceId).map((candidate) => candidate.resourceId);
    return {
      resourceId: resource.resourceId,
      descriptor: resources.get(resource.resourceId)?.descriptor?.desc,
      passes: model.passes.filter((pass) => views.some((view) => pass.colorAttachmentViewHandleIds.includes(view) || pass.depthStencilViewHandleId === view)).map((pass) => {
        const begin = decoded.events[pass.beginEventIndex];
        return { passIndex: pass.passIndex, label: begin?.desc?.label, colorLoadOps: begin?.desc?.colorAttachments?.map((attachment) => attachment.loadOp), depthLoadOp: begin?.desc?.depthStencilAttachment?.depthLoadOp, depthClearValue: begin?.desc?.depthStencilAttachment?.depthClearValue, stencilLoadOp: begin?.desc?.depthStencilAttachment?.stencilLoadOp };
      }),
    };
  });
  writeFileSync(resolve(output, 'body-water.rhitape'), tapeBytes);
  const bodyMeshWorkIndices = new Set(meshDraws.flatMap((body) => body.meshes).flatMap((mesh) => mesh.workIndices));
  const bodyColorWorks = draws.filter((draw) => bodyMeshWorkIndices.has(draw.workIndex)
    && draw.pipeline?.status === 'available'
    && draw.pipeline.topology === 'triangle-list'
    && (draw.attachments?.colorViewHandleIds.length ?? 0) > 0);
  const bodyColorPasses = [...new Map(bodyColorWorks.map((draw) => [draw.passIndex, {
    passIndex: draw.passIndex,
    works: bodyColorWorks.filter((candidate) => candidate.passIndex === draw.passIndex),
  }])).values()];
  const completeBodyColorPasses = bodyColorPasses.filter((pass) => meshDraws.every((body) => body.meshes.every((mesh) =>
    mesh.workIndices.some((workIndex) => pass.works.some((draw) => draw.workIndex === workIndex)))));
  assert(completeBodyColorPasses.length > 0, `FrameModel must identify at least one complete color pass by verified Body mesh draws, available pipelines and color attachments: ${JSON.stringify(bodyColorPasses.map(({ passIndex, works }) => ({ passIndex, workIndices: works.map((draw) => draw.workIndex), pipelines: [...new Set(works.map((draw) => draw.pipeline.label))], colorAttachments: [...new Set(works.flatMap((draw) => draw.attachments?.colorViewHandleIds ?? []))] })))}`);
  const completePassInfo = completeBodyColorPasses.map((pass) => ({
    ...pass,
    label: decoded.events[model.passes.find((candidate) => candidate.passIndex === pass.passIndex)?.beginEventIndex ?? -1]?.desc?.label,
  }));
  const mainColorPass = completePassInfo.find((pass) => pass.label === 'main');
  assert(mainColorPass, 'FrameModel has no complete main color pass for Body pixel replay');
  const replayPasses = completePassInfo.map((pass) => {
    const reads = pass.works.map((draw, index) => ({ output: 'color0', workIndex: draw.workIndex, ...(index === pass.works.length - 1 ? { image: { range: 'auto' } } : {}) }));
    const readOutput = execFileSync(process.execPath, [resolve(repoRoot, 'packages/devkit/dist/cli.mjs'), 'rhi', 'read', '--artifact', resolve(output, 'body-water.rhitape'), `--reads=${JSON.stringify(reads)}`, '--json'], { cwd: repoRoot, encoding: 'utf8' });
    const replay = JSON.parse(readOutput);
    assert.equal(replay.ok, true, `fresh CLI RHI replay failed for pass ${pass.label}: ${readOutput}`);
    const replayReads = replay.value.reads.map((row) => {
      assert.equal(row.ok, true, `fresh CLI RHI read failed for pass ${pass.label}: ${JSON.stringify(row)}`);
      return { workIndex: row.value.provenance.selectedWorkIndex, resourceId: row.value.resourceId, digest: row.value.digest, ...(row.value.image ? { image: row.value.image } : {}) };
    });
    const colorTransitions = replayReads.slice(1).map((row, index) => ({ workIndex: row.workIndex, changedFromPrevious: row.digest !== replayReads[index]?.digest }));
    return { passIndex: pass.passIndex, label: pass.label, workIndices: pass.works.map((draw) => draw.workIndex), reads: replayReads, colorTransitions, contributedColorChange: colorTransitions.some((transition) => transition.changedFromPrevious) };
  });
  const mainReplay = replayPasses.find((pass) => pass.label === 'main');
  assert(mainReplay, 'Fresh CLI replay did not inspect the complete main pass');
  assert(mainReplay.colorTransitions.some((transition) => transition.changedFromPrevious), 'main-pass Body draw work must change fresh-replay color output');
  const mainColorWorks = mainColorPass.works;
  const pixelWorkIndex = mainColorWorks.at(-1).workIndex;
  const replayReads = mainReplay.reads;
  const replayTransitions = mainReplay.colorTransitions;
  const replayedWorks = new Set(replayReads.map((row) => row.workIndex));
  for (const match of meshDraws.flatMap((body) => body.meshes).flatMap((mesh) => mesh.workIndices.filter((workIndex) => mainColorWorks.some((draw) => draw.workIndex === workIndex)))) {
    assert(replayedWorks.has(match), `main-pass Body draw work ${match} must have a fresh-replay pixel read`);
  }
  const replayImage = replayReads.at(-1)?.image;
  assert.equal(replayImage?.width, 390);
  assert.equal(replayImage?.height, 844);
  assert.equal(replayImage?.stats.nonFinite, 0);
  const evidence = {
    url,
    initialBodies: ['river', 'lake', 'ocean', 'custom'],
    operations: { riverRecook: { before: beforeRiver, afterInjectedFailure: afterFailedRiver, after: afterRiver, action: 'copied River point 1, edited X and all four spline metadata fields, applied independent XYZ scale, injected a pre-commit failure and verified old outputs/receipt/mesh handles remain, then recooked and captured generations and world bounds' }, oceanExclusion: { before: beforeOcean, after: afterOcean, probeBefore: oceanProbeBefore, probeAfter: oceanProbeAfter, rayDifference: oceanRayDifference, probeRestored: oceanProbeRestored }, customRaycast: customEvidence },
    waterInfoProducts: productEvidence,
    meshAssets,
    screenshots,
    capture: {
      file: 'body-water.rhitape',
      digest: capture.digest,
      calculatedDigest,
      frameReceipt: capture.receipt,
      screenshotFrameId: capture.screenshotFrameId,
      screenshotMatchesReceipt: capture.screenshotFrameId === capture.receipt.frameId,
      recordingBackend: capture.backendKind,
      rendererCapabilities: capture.rendererCapabilities,
      adapterPath: 'WebGPU via SwiftShader software Vulkan adapter from scripts/ci/browser-launch.json',
      workCount: model.works.length,
      drawCount: draws.length,
      completeBodyColorPasses: completePassInfo.map(({ passIndex, label, works }) => ({
        passIndex,
        label,
        workIndices: works.map((draw) => draw.workIndex),
        pipelineLabels: [...new Set(works.map((draw) => draw.pipeline.label))],
        colorAttachments: [...new Set(works.flatMap((draw) => draw.attachments?.colorViewHandleIds ?? []))],
      })),
      mainColorPass: { passIndex: mainColorPass.passIndex, workIndices: mainColorWorks.map((draw) => draw.workIndex), pipelineLabels: [...new Set(mainColorWorks.map((draw) => draw.pipeline.label))], colorAttachments: [...new Set(mainColorWorks.flatMap((draw) => draw.attachments?.colorViewHandleIds ?? []))] },
      draws,
      meshDraws,
      unseededResources: model.unseededResources,
      unseededResourceProvenance,
      replay: { backend: 'CLI fresh WebGPU device (Dawn)', passes: replayPasses.map(({ passIndex, label, workIndices, colorTransitions, contributedColorChange }) => ({ passIndex, label, workIndices, colorTransitions, contributedColorChange })), reads: replayReads, colorTransitions: replayTransitions, pixelWorkIndex, pixelStats: replayImage?.stats },
    },
    errors,
  };
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, 'body-water-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await server?.close();
}
