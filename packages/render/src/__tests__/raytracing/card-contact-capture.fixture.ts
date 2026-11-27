import { fileURLToPath } from 'node:url';
import { buildMeshCardLayout, buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import {
  exactReceiverPoint,
  executeReceiver,
} from '../../../../shader/src/__tests__/canonical-receiver-reconstruction.fixture';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { captureViewProjection, transformCardProjection } from '../../raytracing/capture-view';
import { CardReceiverGeometry } from '../../raytracing/card-receiver';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { referenceSurfaceMaterialSnapshot } from '../../raytracing/material-bindings';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import type { SurfaceCaptureSource } from '../../raytracing/surface-cards';
import { CARD_SHADOW_CASES, triangleOnSegment, type V3 } from './card-contact-physical.fixture';

const forward = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const resolution = 8;

/** Original physical row 3: the receiver and near-light blocker are different
 * original primitives of one Mesh. No uploaded primitive ID is patched. */
export async function prepareCardContactCapture() {
  const original = CARD_SHADOW_CASES[3];
  if (original?.name !== 'near-light-end-blocker')
    throw Error('The original physical row 3 is required');
  const positions = Float32Array.from([-2, -2, 0, 2, -2, 0, 0, 2, 0, ...original.triangle.flat()]);
  const indices = Uint32Array.from([0, 1, 2, 3, 4, 5]);
  const sides = new Uint8Array(2);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.125,
      triangleSidedness: sides,
    })
  ).unwrap();
  const geometry = CardReceiverGeometry.from(field, positions, indices);
  if (!geometry) throw Error('The authored capture and canonical source must match');
  const layout = (
    await buildMeshCardLayout(positions, indices, { triangleSidedness: sides })
  ).unwrap();
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const asset = Materials.standard({ baseColor: [0, 1, 0, 1], renderState: { cullMode: 'back' } });
  const material = (
    await cookRayMaterial({
      material: 'physical-contact',
      table: { 'physical-contact': asset },
      sources,
      context: 'card-capture',
    })
  ).unwrap();
  const source: SurfaceCaptureSource = {
    instance: { instanceId: 0, geometryId: 31, mask: 255, transform: forward, positions, indices },
    captureKey: 'same-mesh-near-light-contact',
    layout,
    receiverGeometry: geometry,
    sections: [
      {
        indexOffset: 0,
        indexCount: 6,
        material: {
          id: 0,
          program: { source: material.program.wgsl, paramSchema: material.program.paramSchema },
          snapshot: referenceSurfaceMaterialSnapshot({
            asset: material.asset,
            program: material.program,
          }),
        },
      },
    ],
  };
  const instances: SdfMeshInstance[] = [
    {
      instanceId: 0,
      geometryId: 31,
      mask: 255,
      transform: forward,
      field,
      surfaceCoverage: 'opaque' as const,
    },
  ];
  const scene = packGlobalSdfComposition(
    instances,
    {
      origin: [-3, -3, -1],
      dimensions: [25, 25, 17],
      spacing: 0.25,
      maxDistance: 4,
      coverageDistance: 0.25,
    },
    { sourceEpoch: 1 },
  ).unwrap();
  const blocker = original.triangle;
  for (const [card, local] of layout.cards.entries()) {
    if (local.n[2] < 0.99) continue;
    const projection = transformCardProjection(local, forward).unwrap();
    const context = captureViewProjection(projection).unwrap();
    // Preselection uses the same public projection owner. The GPU test must
    // compare this with the real Capture-published VP; it is not an upload receipt.
    const expectedViewProjection = new Uint8Array(
      context.matrix.buffer,
      context.matrix.byteOffset,
      64,
    ).slice();
    for (let y = 0; y < resolution; y++)
      for (let x = 0; x < resolution; x++) {
        const input = {
          name: 'same-mesh-near-light',
          vertices: [
            [-2, -2, 0],
            [2, -2, 0],
            [0, 2, 0],
          ] as const,
          forward: Array.from(forward),
          viewProjection: Array.from(context.matrix),
          pixel: [x, y] as const,
          extent: [resolution, resolution] as const,
          sampleOffset: [0.5, 0.5] as const,
        };
        if (executeReceiver(input).state !== 1) continue;
        const exact = exactReceiverPoint(input);
        const p = exact.map((v) => Number(v.n) / Number(v.d)) as [number, number, number];
        const delta: V3 = [
            original.light[0] - p[0],
            original.light[1] - p[1],
            original.light[2] - p[2],
          ],
          d = Math.hypot(...delta);
        const biased: V3 = [p[0], p[1], p[2] + 0.25];
        const old: V3 = [delta[0] / d, delta[1] / d, delta[2] / d];
        const directional: V3 = old;
        if (
          !triangleOnSegment(p, delta, 1, blocker) ||
          triangleOnSegment(biased, old, d - 0.25, blocker) ||
          !triangleOnSegment(p, directional, 4, blocker) ||
          triangleOnSegment(biased, directional, 4, blocker)
        )
          continue;
        return {
          source,
          instances,
          scene,
          resolution,
          card,
          pixel: [x, y] as const,
          expectedViewProjection,
          // This authored receiver is exactly z=0 and the orthographic VP is
          // dyadic. Its depth is the actual VP translation, not a generic .5.
          expectedDepth: context.matrix[14],
          exact,
          point: p,
          blocker,
          physicalMasks: [0, 0, 0, 1] as const,
          lights: [
            {
              kind: 1,
              position: [0, 0, 0] as V3,
              direction: [-delta[0], -delta[1], -delta[2]] as V3,
            },
            { kind: 2, position: original.light, direction: [0, 0, -1] as V3 },
            { kind: 3, position: original.light, direction: [0, 0, -1] as V3 },
            { kind: 2, position: [0.75, 0, 0.5] as V3, direction: [0, 0, -1] as V3 },
          ],
        };
      }
  }
  throw Error(
    'Actual owner projection must expose a strict receiver pixel that distinguishes the legacy bias',
  );
}
