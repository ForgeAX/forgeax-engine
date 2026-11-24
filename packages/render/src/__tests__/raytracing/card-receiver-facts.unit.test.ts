import { buildMeshCardLayout, buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  CARD_RECEIVER_FACT_BYTES,
  CARD_RECEIVER_FACT_TAG,
  CardReceiverGeometry,
  packCardReceiverFacts,
} from '../../raytracing/card-receiver';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import {
  CARD_PLANES,
  prepareSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCaptureSource,
} from '../../raytracing/surface-cards';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { queryTestDevice } from './global-sdf-query-device.fixture';

const forward = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function fixture() {
  const positions = Float32Array.from([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const indices = Uint32Array.from([0, 1, 2]);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.5,
      triangleSidedness: Uint8Array.of(0),
    })
  ).unwrap();
  const geometry = CardReceiverGeometry.from(field, positions, indices);
  assert(geometry);
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const layout = (await buildMeshCardLayout(positions, indices)).unwrap();
  const source: SurfaceCaptureSource = {
    instance: { instanceId: 0, geometryId: 9, mask: 255, positions, indices, transform: forward },
    layout,
    captureKey: 'canonical-card-receiver-fixture',
    receiverGeometry: geometry,
    sections: [
      {
        indexOffset: 0,
        indexCount: 3,
        material: {
          id: 0,
          program: { source: '', paramSchema: [] },
          snapshot: defaultMaterialSnapshot(),
        },
      },
    ],
  };
  return { device, source, field, geometry, positions, indices };
}

function raster(
  capture: SurfaceCapture,
  device: Awaited<ReturnType<typeof queryTestDevice>>,
  slice: { first: number; count: number },
) {
  const encoder = device.createCommandEncoder({}).unwrap();
  const material = encoder.beginRenderPass({
    colorAttachments: CARD_PLANES.map((name) => ({
      view: capture.views[name],
      loadOp: 'load',
      storeOp: 'store',
    })),
    depthStencilAttachment: {
      view: capture.views.depth,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    },
  });
  capture.clearTiles(material, slice).unwrap();
  capture.recordPass(material, slice).unwrap();
  material.end();
  const identity = encoder.beginRenderPass({
    colorAttachments: [{ view: capture.primitiveIndex.view, loadOp: 'load', storeOp: 'store' }],
    depthStencilAttachment: {
      view: capture.views.depth,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    },
  });
  capture.clearTiles(identity, slice, 'identity').unwrap();
  capture.recordPass(identity, slice, 'identity').unwrap();
  identity.end();
  return encoder;
}

it('copies the actual uploaded VP and exact forward without rounding an external pose into qualification', async () => {
  const { geometry } = await fixture();
  const context = Uint8Array.from({ length: 144 }, (_, i) => i);
  const bytes = packCardReceiverFacts(2, context, forward, geometry);
  expect(bytes.byteLength).toBe(160);
  expect(Array.from(new Uint32Array(bytes.buffer, 16, 4))).toEqual([
    2,
    1,
    1,
    CARD_RECEIVER_FACT_TAG,
  ]);
  expect(bytes.slice(32, 96)).toEqual(context.slice(0, 64));
  expect(bytes.slice(96)).toEqual(new Uint8Array(Float32Array.from(forward).buffer));
  for (const value of [1 + 2 ** -30, Number.POSITIVE_INFINITY, 1e-40]) {
    const pose = [...forward];
    pose[12] = value;
    expect(packCardReceiverFacts(2, context, pose, geometry)).toEqual(new Uint8Array(160));
  }
});

it('uses validated canonical geometry rather than an externally supplied primitive-count flag', async () => {
  const { field, positions, indices, geometry } = await fixture();
  expect(geometry.matches(positions, indices)).toBe(true);
  expect(geometry.matches(positions.slice(), indices)).toBe(false);
  const changed = Array.from(positions);
  changed[0] = -1 + 2 ** -30;
  expect(CardReceiverGeometry.from(field, changed, indices)).toBeUndefined();
  expect(CardReceiverGeometry.from(field, positions, [1, 0, 2])).toBeUndefined();
  positions[0] = -2;
  expect(geometry.matches(positions, indices)).toBe(false);
});

it('publishes only paired capture facts, commits only submitted identity, and rejects stale pose and source', async () => {
  const { device, source, field } = await fixture();
  const creates = vi.spyOn(device, 'createBuffer');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const capture = (
    await prepareSurfaceCapture(device, createShaderModule, [source], {
      kind: 'cards',
      resolution: 8,
    })
  ).unwrap();
  const slice = { first: 0, count: source.layout.cards.length };
  const instances = [{ ...source.instance, field }];
  const expected = [144 / 4, 4096, 1, 1];
  const latest = () => {
    const data = writes.mock.calls
      .filter(([buffer]) => buffer === capture.receivers.staging)
      .at(-1)?.[2];
    assert(data && !(data instanceof ArrayBuffer));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };
  try {
    const encoder = raster(capture, device, slice);
    const copy = vi.spyOn(encoder, 'copyBufferToBuffer');
    // A caller cannot redeem an unrelated encoded identity slice.
    capture.recordReceiverFacts(encoder, { expected, instances }, slice, {}).unwrap();
    expect(latest().every((byte) => byte === 0)).toBe(true);
    capture.recordReceiverFacts(encoder, { expected, instances }, slice, slice).unwrap();
    const published = latest().slice();
    expect(Array.from(new Uint32Array(published.buffer, 0, 8))).toEqual([
      ...expected,
      0,
      1,
      1,
      CARD_RECEIVER_FACT_TAG,
    ]);
    const projection = creates.mock.results.flatMap((r, i) =>
      creates.mock.calls[i]?.[0].label === 'cards.projection' && r.type === 'return' && r.value.ok
        ? [r.value.value]
        : [],
    )[0];
    assert(projection);
    const uploaded = writes.mock.calls.find(([buffer]) => buffer === projection)?.[2];
    assert(uploaded && !(uploaded instanceof ArrayBuffer));
    expect(published.slice(32, 96)).toEqual(
      new Uint8Array(uploaded.buffer, uploaded.byteOffset, 64),
    );
    expect(copy).toHaveBeenLastCalledWith(
      capture.receivers.staging,
      0,
      capture.receivers.buffer,
      0,
      slice.count * CARD_RECEIVER_FACT_BYTES,
    );
    // A different/aborted token does not establish retained capture lineage.
    capture.commitReceiverCapture({});
    capture.recordReceiverFacts(encoder, { expected, instances }, slice).unwrap();
    expect(latest().every((byte) => byte === 0)).toBe(true);
    capture.commitReceiverCapture(slice);
    capture
      .recordReceiverFacts(encoder, { expected: [...expected.slice(0, 3), 2], instances }, slice)
      .unwrap();
    expect(new Uint32Array(latest().buffer, latest().byteOffset, 4)[3]).toBe(2);
    expect(capture.recordReceiverFacts(encoder, { expected, instances }, slice).ok).toBe(false);
    const accepted = instances[0];
    assert(accepted);
    const moved = [...forward];
    moved[12] = 1;
    capture
      .recordReceiverFacts(
        encoder,
        {
          expected: [...expected.slice(0, 3), 2],
          instances: [{ ...accepted, transform: moved }],
        },
        slice,
      )
      .unwrap();
    expect(latest().every((byte) => byte === 0)).toBe(true);
    expect(capture.bytes).toBe(
      capture.width * capture.height * 40 +
        capture.bufferReads.reduce((sum, read) => sum + read.size, 0) +
        capture.receivers.size * 2,
    );
    encoder.finish().unwrap();
  } finally {
    capture.dispose();
  }
});

it('validates the actual software Card contact program with the production interval and pool authority', async () => {
  const source = irradianceFieldKernelWgsl('global-sdf').cardSurface;
  const compiled = (await compileShader(source, { id: 'card-canonical-contact' })).unwrap();
  expect(compiled.manifestEntry.entryPoints?.some((entry) => entry.name === 'cardSurface')).toBe(
    true,
  );
}, 60_000);
