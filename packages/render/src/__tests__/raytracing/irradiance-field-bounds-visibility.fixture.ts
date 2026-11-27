import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { SDF_SCENE_TEXTURE_LAYOUT } from '../../../../shader/src/sdf-scene-texture-wgsl';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { packSdfSceneTexture, planSdfSceneTexture } from '../../raytracing/sdf-scene-texture';
import { segmentCases } from './irradiance-field-segment.fixture';

export interface CanonicalVisibilityCase {
  readonly origin: readonly number[];
  readonly endpoint: readonly number[];
  readonly expected: -1 | 0 | 1;
  readonly kind: 'clear-near' | 'clear-far' | 'blocked';
}

/** Same 33 historical positions, with an independent finite opaque solid. Its
 * top face is y=0 and all queries remain inside that face's x/z extent. */
export const canonicalVisibilityCases: readonly CanonicalVisibilityCase[] = [
  ...segmentCases.map((c) => ({ ...c, expected: 1 as const, kind: 'clear-near' as const })),
  ...segmentCases.map((c) => ({
    ...c,
    endpoint: [0, 0.3, 0],
    expected: 1 as const,
    kind: 'clear-far' as const,
  })),
  { origin: [0.35, 0.7, 0.2], endpoint: [0.15, -0.3, 0.2], expected: 0, kind: 'blocked' },
];

const point = (m: ArrayLike<number>, p: readonly number[]) =>
  [
    (m[0] ?? 0) * (p[0] ?? 0) + (m[4] ?? 0) * (p[1] ?? 0) + (m[8] ?? 0) * (p[2] ?? 0),
    (m[1] ?? 0) * (p[0] ?? 0) + (m[5] ?? 0) * (p[1] ?? 0) + (m[9] ?? 0) * (p[2] ?? 0),
    p[2] ?? 0,
  ].map(Math.fround);

/** Pure preparation; this is not a GPU or material-admission result. The actual
 * SceneFieldRows material certificate path is covered by the Field owner tests. */
export async function prepareCanonicalVisibility(rotated: boolean) {
  const height = rotated ? 1 / 64 : 4;
  const mesh = createBoxGeometry(4, height, 4).unwrap();
  const indices = mesh.indices;
  if (!indices) throw new Error('Canonical visibility requires the complete indexed box');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, indices, {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const cosine = Math.fround(rotated ? Math.cos(Math.PI / 6) : 1),
    sine = rotated ? 0.5 : 0;
  const rotation = Float32Array.from([
    cosine,
    sine,
    0,
    0,
    -sine,
    cosine,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
  const forward = rotation.slice();
  forward[12] = (height / 2) * sine;
  forward[13] = -(height / 2) * cosine;
  const size = rotated ? 17 : 9,
    low = rotated ? -2 : -1;
  const grid = {
    origin: [low, low, low] as const,
    dimensions: [size, size, size] as const,
    spacing: 0.25,
    maxDistance: 4,
    coverageDistance: 0.125,
  };
  const source = packGlobalSdfComposition(
    [
      {
        instanceId: 0,
        geometryId: 0,
        mask: 255,
        transform: forward,
        field,
        surfaceCoverage: 'opaque',
      },
    ],
    grid,
  ).unwrap();
  const plan = planSdfSceneTexture(
    source.data.instances.byteLength,
    source.data.fields.byteLength,
    1,
    {
      maxTextureDimension2D: 8192,
      maxBytes: 16 * 1024 * 1024,
    },
  ).unwrap();
  const epoch = 17;
  const parameters = packSdfSceneTexture(plan, epoch).unwrap();
  const projected = new Uint32Array(plan.bytes / 4);
  projected.set([
    SDF_SCENE_TEXTURE_LAYOUT.magic,
    SDF_SCENE_TEXTURE_LAYOUT.version,
    epoch,
    1,
    16,
    plan.instanceWords,
    16 + plan.instanceWords,
    plan.fieldWords,
    1,
    36,
    plan.width,
    plan.height,
    plan.logicalWords,
    0,
    0,
    0,
  ]);
  projected.set(
    new Uint32Array(
      source.data.instances.buffer,
      source.data.instances.byteOffset,
      plan.instanceWords,
    ),
    16,
  );
  projected.set(
    new Uint32Array(source.data.fields.buffer, source.data.fields.byteOffset, plan.fieldWords),
    16 + plan.instanceWords,
  );
  const visibilityInputs = new Uint8Array(64);
  visibilityInputs.set(source.data.settings);
  new Uint32Array(visibilityInputs.buffer, 48, 4).set(parameters.subarray(0, 4));
  const fieldUniform = new Uint8Array(
    packIrradianceFieldUniform(
      {
        origin: [low, low, low],
        spacing: 0.25,
        dimensions: [size, size, size],
        probeCount: size ** 3,
        levels: 1,
      },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [size, size, size] }],
    ),
  );
  const cases = canonicalVisibilityCases.map((c) => ({
    ...c,
    origin: point(rotation, c.origin),
    endpoint: point(rotation, c.endpoint),
  }));
  const pairs = Float32Array.from(cases.flatMap((c) => [...c.origin, 0, ...c.endpoint, 0]));
  const samples = new Float32Array(size ** 3 * 2);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const p = [low + x * 0.25, low + y * 0.25, low + z * 0.25];
        // Independent analytic distance to the authored closed box. Identity mode
        // exactly reproduces the historical signed-y grid at every 9^3 lattice point.
        const denominator = cosine * cosine + sine * sine;
        const local = [
          (cosine * (p[0] ?? 0) + sine * (p[1] ?? 0)) / denominator,
          (-sine * (p[0] ?? 0) + cosine * (p[1] ?? 0)) / denominator + height / 2,
          p[2] ?? 0,
        ];
        const q = local.map((v, axis) => Math.abs(v) - (axis === 1 ? height / 2 : 2));
        const value = Math.hypot(...q.map((v) => Math.max(0, v))) + Math.min(0, Math.max(...q));
        samples.set([value, 1], ((z * size + y) * size + x) * 2);
      }
  return {
    rotated,
    height,
    grid,
    plan,
    projected,
    fieldUniform,
    visibilityInputs,
    samples,
    cases,
    pairs,
    vertices: mesh.attributes.position as Float32Array,
    indices,
    forward,
    materialCertificateScope:
      'Fixture-declared opaque; real SceneFieldRows adoption is a separate owner gate.',
  };
}
