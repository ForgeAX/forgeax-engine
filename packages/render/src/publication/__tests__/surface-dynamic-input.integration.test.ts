import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { Camera } from '../../components/camera';
import { ReadonlyDynamicInputPage } from '../../surface/dynamic-input';
import { publishSurfaceDynamicInput } from '../../surface/frame-source';
import { SurfaceDynamicInputReceiver } from '../dynamic-input';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationTransfers } from '../record';

it('publishes owned source records, rejects malformed packets atomically and withdraws the page', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets }),
    identity = { source: 'surface-page-source', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity),
    receiver = new RenderPublicationReceiver(identity),
    surface = new SurfaceDynamicInputReceiver();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const page = ReadonlyDynamicInputPage.create({
    sourceId: 'wake',
    pageId: 8,
    schema: {
      name: 'wake',
      fields: [{ name: 'sample', type: 'vec4<f32>' }],
      maxRecords: 2,
      maxDomains: 1,
      maxPageBytes: 32,
      maxBindings: 1,
      maxEventsPerSample: 2,
    },
  }).unwrap();
  const range = page
    .reserveRange({
      domain: 'ocean',
      recordStart: 0,
      recordCount: 2,
      instanceIndex: 0,
      member: {
        worldIdentity: world.identity,
        entityKey: entity,
        drawItemIndex: 0,
        instanceOrdinal: 0,
      },
    })
    .unwrap();
  try {
    page.writeRecord(0, { sample: [1, 2, 3, 4] }).unwrap();
    publishSurfaceDynamicInput(world, {
      page,
      ranges: [range],
      projectionRevision: 1,
      frameTime: 2,
    });
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(1 / 60).unwrap();
    page.writeRecord(0, { sample: [9, 9, 9, 9] }).unwrap();
    const message = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const invalid = structuredClone(message);
    const invalidInput = invalid.side?.surfaceDynamicInputs?.[0];
    assert(invalidInput);
    new DataView(invalidInput.page.bytes.buffer).setFloat32(0, Number.NaN, true);
    expect(receiver.accept(invalid)).toMatchObject({
      ok: false,
      error: { code: 'render-publication-invalid' },
    });
    expect(receiver.acceptedRevision).toBe(0);
    const accepted = receiver.accept(message).unwrap();
    const input = accepted.packet.surfaceDynamicInputs?.[0];
    assert(input);
    expect(new DataView(input.page.bytes.buffer).getFloat32(0, true)).toBe(1);
    expect(input.ranges?.[0]?.member.worldIdentity).toBe(world.identity);
    expect('deviceGeneration' in input.page).toBe(false);
    const initial = surface.restore(input, 1).unwrap();
    const next = surface.restore({ ...input, frameTime: 3 }, 1).unwrap();
    assert(initial && next && next.ranges?.[0]);
    expect(next.page).toBe(initial.page);
    expect(next.ranges).toBe(initial.ranges);
    expect(next.page.captureRange(next.ranges[0]).ok).toBe(true);
    const recovered = surface.restore(input, 2).unwrap();
    assert(recovered?.ranges?.[0]);
    expect(recovered.ranges).not.toBe(next.ranges);
    expect(recovered.page.captureRange(recovered.ranges[0]).ok).toBe(true);
    publisher.recycle(accepted.packet.revision, renderPublicationTransfers(message)).unwrap();
    publishSurfaceDynamicInput(world, undefined);
    const cleared = publisher.prepare(1 / 60).unwrap();
    const clearMessage = structuredClone(cleared.message, {
      transfer: renderPublicationTransfers(cleared.message),
    });
    cleared.accept();
    expect(receiver.accept(clearMessage).unwrap().packet.surfaceDynamicInputs).toBeUndefined();
    publisher.recycle(2, renderPublicationTransfers(clearMessage)).unwrap();
    const foreign = page
      .reserveRange({
        domain: 'ocean',
        recordStart: 0,
        recordCount: 2,
        instanceIndex: 0,
        member: {
          worldIdentity: 'another-source',
          entityKey: entity,
          drawItemIndex: 0,
          instanceOrdinal: 0,
        },
      })
      .unwrap();
    publishSurfaceDynamicInput(world, {
      page,
      ranges: [foreign],
      projectionRevision: 2,
      frameTime: 3,
    });
    expect(publisher.prepare(1 / 60).ok).toBe(false);
  } finally {
    publisher.dispose();
    receiver.dispose();
    surface.dispose();
    page.release().unwrap();
    assets.dispose();
  }
});

it('rejects forged range objects before a source can publish them', () => {
  const page = ReadonlyDynamicInputPage.create({
    sourceId: 'wake',
    pageId: 1,
    schema: {
      name: 'wake',
      fields: [{ name: 'value', type: 'f32' }],
      maxRecords: 1,
      maxDomains: 1,
      maxPageBytes: 16,
      maxBindings: 1,
      maxEventsPerSample: 1,
    },
  }).unwrap();
  const range = page
    .reserveRange({
      domain: 'ocean',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: { worldIdentity: 'ocean-world', entityKey: 1, drawItemIndex: 0, instanceOrdinal: 0 },
    })
    .unwrap();
  expect(page.captureRange({ ...range })).toMatchObject({
    ok: false,
    error: { code: 'stale-generation' },
  });
  page.release().unwrap();
});

import assert from 'node:assert/strict';
