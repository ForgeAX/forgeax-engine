import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

let smokeSource = '';

beforeAll(async () => {
  smokeSource = await readFile(new URL('../../scripts/smoke-dawn.mjs', import.meta.url), 'utf8');
});

describe('volumetric fog Dawn fixture source contract', () => {
  it('keeps one Renderer, World, attachment, two owners, and a live density rebind', () => {
    expect(smokeSource.match(/await constructRuntimeRendererHost\(/gu)).toHaveLength(1);
    expect(smokeSource.match(/const world = new World\(\)/gu)).toHaveLength(1);
    expect(smokeSource.match(/renderer\.attach\(world\)/gu)).toHaveLength(1);
    expect(smokeSource).toContain('volumeOwnerCount !== 2');
    expect(smokeSource).toContain('tonemap: TONEMAP_NEUTRAL');
    expect(smokeSource).toContain(
      'world.set(volumeEntities[0], VolumetricFog, { density: updatedDensity }).unwrap()',
    );
  });

  it('submits an ordinary transparent mesh through the same World and verifies the sorted lane', () => {
    expect(smokeSource).toContain('const transparentSubject = world');
    expect(smokeSource).toContain('component: MeshFilter, data: { assetHandle: primitiveCube }');
    expect(smokeSource).toContain(
      'component: MeshRenderer, data: { materials: [transparentMaterial] }',
    );
    expect(smokeSource).toContain(
      'renderState: { blend: straightAlphaBlend, depthWriteEnabled: false }',
    );
    expect(smokeSource).toContain('transparency: baselineTransparency, observation: graphObservation');
    expect(smokeSource).toContain('graphObservation.frameId !== baselineReceipt.frameId');
    expect(smokeSource).toContain("baselinePassNames.includes('transparent')");
    expect(smokeSource).toContain('baselineTransparency.sortedDrawCount');
  });

  it('loads the public Fox asset through the existing glTF and Skin path in that fixture', () => {
    expect(smokeSource).toContain("'@forgeax/engine-gltf'");
    expect(smokeSource).toContain("'@forgeax/engine-skinning'");
    expect(smokeSource).toContain('gltfDocToSceneAsset(foxDoc');
    expect(smokeSource).toContain('assets.instantiate(foxSceneHandle, world)');
    expect(smokeSource).toContain('world.addComponent(foxInstance.value');
    expect(smokeSource).toContain('sameWorld: true');
    expect(smokeSource).toContain('sameRenderer: true');
    expect(smokeSource).toContain('Fox scene did not instantiate any Skin entities');
  });

  it('counts successful completed receipts and keeps the 60-frame minimum', () => {
    expect(smokeSource).toContain('Math.max(60, requestedMinFrames)');
    expect(smokeSource).toContain('const completed = await receipt.completed');
    expect(smokeSource).toContain('if (!completed.ok)');
    expect(smokeSource).toContain('completedFrameIds.add(receipt.frameId)');
  });

  it('compares mapped pixels captured before and after the owner density update', () => {
    expect(smokeSource).toContain('encoder.copyTextureToBuffer(');
    expect(smokeSource).toContain('await readback.mapAsync(0x01)');
    expect(smokeSource).toContain('comparePixels(baselineCapture.pixels, updatedCapture.pixels)');
    expect(smokeSource).toContain('densityComparison.changedPixels > 0.01');
    expect(smokeSource).toContain('densityComparison.meanRgbDelta > 0.01');
  });
});
