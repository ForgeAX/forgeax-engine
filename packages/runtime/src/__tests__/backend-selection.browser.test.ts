import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  Camera,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';

it.each([
  'native',
  'missing',
  'null',
  'rejected',
] as const)('presents sixty frames and mesh pixels after %s WebGPU admission', {
  timeout: 90_000,
}, async (mode) => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const native = navigator.gpu;
  expect(native, 'This roster requires native WebGPU as the positive control').toBeDefined();
  if (mode !== 'native') {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value:
        mode === 'missing'
          ? undefined
          : {
              requestAdapter: async () => {
                if (mode === 'rejected')
                  throw new DOMException('Controlled adapter rejection', 'OperationError');
                return null;
              },
            },
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  let renderer: Renderer | undefined;
  let lease: RenderWorldLease | undefined;
  try {
    renderer = (await createRenderer(canvas)).unwrap();
    expect(renderer.inspect().capabilities.backendKind).toBe(
      mode === 'native' ? 'webgpu' : 'wgpu-webgl2',
    );
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World();
    const assets = testAssets(world);
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: assets.create(createPrimitiveMesh('quad').unwrap()).unwrap() },
        },
        {
          component: MeshRenderer,
          data: { materials: [assets.create(Materials.unlit([0, 1, 0, 1])).unwrap()] },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: -1,
            right: 1,
            top: 1,
            bottom: -1,
            near: 0.1,
            far: 100,
            aspect: 1,
            antialias: 0,
            tonemap: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    lease = renderer.attach(world).unwrap();
    let completed = 0;
    let receipt: FrameReceipt | undefined;
    for (let attempt = 0; completed < 60 && attempt < 180; attempt++) {
      propagateTransforms(world);
      world.update(1 / 60).unwrap();
      if (completed === 59) renderer.requestObservation?.(['final-display']).unwrap();
      receipt = renderer
        .draw({ leases: [lease], camera: { lease }, environment: { lease } })
        .unwrap();
      (await receipt.completed).unwrap();
      if (receipt.presentation === 'ready') completed++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(completed).toBe(60);
    expect(errors).toEqual([]);
    if (receipt === undefined) throw new Error('Missing completed frame');
    const observation = (await renderer.observe(receipt, { include: ['final-display'] }))
      .unwrap()
      .observations?.find((item) => item.domain === 'final-display');
    if (observation?.domain !== 'final-display') throw new Error('Missing display pixels');
    const offset = 32 * observation.metadata.bytesPerRow + 32 * 4;
    expect([...observation.bytes.subarray(offset, offset + 4)]).toEqual([0, 255, 0, 255]);
    expect([...observation.bytes.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  } finally {
    try {
      lease?.dispose();
      if (renderer !== undefined) (await renderer.dispose()).unwrap();
    } finally {
      canvas.remove();
      if (original !== undefined) Object.defineProperty(navigator, 'gpu', original);
      else Reflect.deleteProperty(navigator, 'gpu');
    }
  }
});
