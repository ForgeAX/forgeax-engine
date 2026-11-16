import { expect, it } from 'vitest';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import {
  buffer,
  compute,
  program,
  read,
  storage,
  texture,
  view,
  write,
} from '../water/advanced-graph';
import { dispersiveOceanShader } from '../water/dispersive-ocean-shader';
import { dispersiveGpuFixture } from './dispersive-ocean-gpu.fixture';

it('retains the original phase denominator across half and complete wave turns', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    for (const input of [
      0,
      0.249999,
      0.25,
      0.250001,
      Math.PI - 1e-6,
      Math.PI,
      Math.PI + 1e-6,
      2 * Math.PI - 1e-6,
      2 * Math.PI,
      2 * Math.PI + 1e-6,
    ]) {
      const phase = Math.fround(input);
      const resources: RenderFeatureResourceDeclaration[] = [
        texture('integrals', 1, 1, 'rgba32float', 'integrals'),
        view('integrals-view', 'integrals'),
        buffer('params', new Float32Array([phase, 0, 0, 0])),
        program(
          'phase-integrals',
          `${dispersiveOceanShader('rgba32float')}
@compute @workgroup_size(8,8) fn phaseContract(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>vec2<u32>(0))){return;}
  textureStore(outputGrid,vec2<i32>(0),vec4<f32>(phaseIntegrals(p[0].x),0.0,0.0));
}`,
          'phaseContract',
          [write(1, 'rgba32float'), storage(2)],
        ),
      ];
      const passes: RenderFeaturePassDeclaration[] = [];
      compute(
        resources,
        passes,
        'integrals',
        'phase-integrals',
        'phaseContract',
        [
          { binding: 1, resource: 'integrals-view' },
          { binding: 2, resource: 'params' },
        ],
        1,
        1,
      );
      await gpu.run(resources, passes);
      const values = await gpu.read('integrals');
      expect(
        Math.abs((values[0] ?? NaN) + 2 * Math.sin(phase / 2) ** 2),
        `cos-1(${phase})`,
      ).toBeLessThan(0.000002);
      const sinc = phase === 0 ? 1 : Math.sin(phase) / phase;
      expect(Math.abs((values[1] ?? NaN) - sinc), `sinc(${phase})`).toBeLessThan(0.000002);
    }
  } finally {
    gpu.dispose();
  }
});

it('advances entry deltas and continuous transport rates through shallow cancellation and deep exponential overflow', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const n = 8,
      gravity = 9.81;
    const seed = new Float32Array(n * n * 4);
    const source = new Float32Array(n * n * 4);
    for (let cell = 0; cell < n * n; cell++) seed.set([0.3, -0.2, 0.1, -0.05], cell * 4);
    for (let cell = 0; cell < n * n; cell++) source.set([0.07, -0.04, 0.09, -0.06], cell * 4);
    const measurements = [];
    for (const dt of [1 / 240, 0.1, 0.2])
      for (const depth of [1e-9, 1e-7, 1e-5, 0.2499, 0.25, 0.2501, 1, 16, 88.7, 88.73, 142.17]) {
        const resources: RenderFeatureResourceDeclaration[] = [],
          passes: RenderFeaturePassDeclaration[] = [];
        for (const name of ['seed', 'source', 'old-source', 'state', 'next-source']) {
          const target = texture(name, n, n, 'rgba32float', name);
          if (target.kind !== 'graph-texture') throw new Error('Expected mode texture');
          resources.push(
            {
              ...target,
              descriptor: {
                ...target.descriptor,
                usage: (target.descriptor.usage ?? 0) | GPUTextureUsage.COPY_DST,
              },
            },
            view(`${name}-view`, name),
          );
        }
        const params = new Float32Array(32);
        params.set([n, 2 * Math.PI, dt], 0);
        params.set([depth, gravity], 4);
        params[8] = 1;
        params[30] = 0.35;
        params[31] = 1;
        resources.push(
          buffer('params', params),
          program('advance', dispersiveOceanShader('rgba32float'), 'advance', [
            read(0),
            write(1, 'rgba32float'),
            storage(2),
            read(3),
            read(6),
            write(7, 'rgba32float'),
          ]),
        );
        compute(
          resources,
          passes,
          'advance',
          'advance',
          'advance',
          [
            { binding: 0, resource: 'seed-view' },
            { binding: 1, resource: 'state-view' },
            { binding: 2, resource: 'params' },
            { binding: 3, resource: 'source-view' },
            { binding: 6, resource: 'old-source-view' },
            { binding: 7, resource: 'next-source-view' },
          ],
          n,
          n,
        );
        await gpu.run(resources, []);
        gpu.write('seed', seed);
        gpu.write('source', source);
        await gpu.run(resources, passes);
        const actual = await gpu.read('state');
        let maximumError = 0;
        let worst: unknown;
        for (let z = 0; z < n; z++)
          for (let x = 0; x < n; x++) {
            const k = Math.hypot(x > n / 2 ? x - n : x, z > n / 2 ? z - n : z);
            const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
            const phase = omega * dt,
              c = Math.cos(phase);
            const sinc = phase === 0 ? 1 : Math.sin(phase) / phase;
            const cosMinusOne = -2 * Math.sin(phase / 2) ** 2;
            const at = (z * n + x) * 4;
            const expected = [
              0.3 * c + (0.19 * dt + 0.07) * sinc,
              -0.2 * c + (-0.11 * dt - 0.04) * sinc,
              0.1 * c - 0.3 * omega ** 2 * dt * sinc + ((0.07 + 0.09 * dt) * cosMinusOne) / dt,
              -0.05 * c + 0.2 * omega ** 2 * dt * sinc - ((0.04 + 0.06 * dt) * cosMinusOne) / dt,
            ].map((value) => value * (k === 0 ? 1 : Math.exp(-0.35 * dt)));
            for (let lane = 0; lane < 4; lane++) {
              const value = actual[at + lane];
              expect(Number.isFinite(value), `depth=${depth}, bin=${x},${z}, lane=${lane}`).toBe(
                true,
              );
              const error = Math.abs((value ?? NaN) - (expected[lane] ?? NaN));
              if (error > maximumError) {
                maximumError = error;
                worst = { x, z, lane, value, expected: expected[lane], omega };
              }
            }
          }
        measurements.push({ depth, dt, maximumError });
        expect(maximumError, JSON.stringify({ depth, dt, worst })).toBeLessThan(0.000002);
      }
    expect(measurements).toHaveLength(33);
  } finally {
    gpu.dispose();
  }
});
