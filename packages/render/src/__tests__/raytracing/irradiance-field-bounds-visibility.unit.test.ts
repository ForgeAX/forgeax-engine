import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FIELD_VISIBILITY_BOUNDS_WGSL } from '../../../../shader/src/field-visibility-wgsl';
import { SDF_INSTANCE_WORD_GUARDS_WGSL } from '../../../../shader/src/sdf-instance-word-guards-wgsl';
import { SDF_SURFACE_POOL_LAYOUT } from '../../../../shader/src/sdf-surface-pool-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { SDF_INSTANCE_WGSL } from '../../raytracing/sdf-instance-wgsl';
import {
  canonicalVisibilityCases,
  prepareCanonicalVisibility,
} from './irradiance-field-bounds-visibility.fixture';
import { canonicalRawAdmissionCases } from './irradiance-field-bounds-visibility-gpu.fixture';
import { segmentCases, segmentShader } from './irradiance-field-segment.fixture';

it('composes placement coverage through the real live Field and Screen Builtin programs', async () => {
  const builtin = await loadEngineShaderEntries();
  const directory = process.env.FORGEAX_PARTIAL_COVERAGE_PREPARE;
  if (directory !== undefined) mkdirSync(directory, { recursive: true });
  for (const [name, program] of [
    ['field', builtin.rayIrradianceField],
    ['screen', builtin.rayScreenProbe],
  ] as const) {
    const result = (
      await compileShader(program.source, {
        id: program.id,
        imports: builtin.imports,
        ...(program.defines === undefined ? {} : { defines: program.defines }),
      })
    ).unwrap();
    expect(result.wgsl).toContain('sdfSurfaceCoverage');
    if (directory !== undefined) {
      writeFileSync(`${directory}/${name}.wgsl`, result.wgsl);
      writeFileSync(
        `${directory}/${name}.reflection.json`,
        JSON.stringify(result.reflection, null, 2),
      );
    }
  }
}, 60_000);

it('retains the old raw-word guard and isolates each authored admission control to one word', async () => {
  expect(SDF_INSTANCE_WGSL).toContain(SDF_INSTANCE_WORD_GUARDS_WGSL.trim());
  expect(FIELD_VISIBILITY_BOUNDS_WGSL).toContain(SDF_INSTANCE_WORD_GUARDS_WGSL);
  const prepared = await prepareCanonicalVisibility(false);
  for (const control of canonicalRawAdmissionCases) {
    const changed = prepared.projected.slice();
    changed[16 + control.word] = control.bits;
    expect(Array.from(changed.keys()).filter((i) => changed[i] !== prepared.projected[i])).toEqual([
      16 + control.word,
    ]);
    expect(changed[16 + control.word]).toBe(control.bits);
  }
  expect(canonicalRawAdmissionCases.filter((row) => row.valid).map((row) => row.name)).toEqual([
    'legal-affine-negative-zero',
  ]);
  const out = process.env.FORGEAX_GI_CANONICAL_VISIBILITY_CPU_EVIDENCE;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      `${out}/raw-admission-controls.json`,
      JSON.stringify(
        canonicalRawAdmissionCases.map((control) => {
          const changed = prepared.projected.slice();
          changed[16 + control.word] = control.bits;
          return {
            ...control,
            offsetBytes: (16 + control.word) * 4,
            baseBits: prepared.projected[16 + control.word],
            sha256: createHash('sha256').update(new Uint8Array(changed.buffer)).digest('hex'),
          };
        }),
        null,
        2,
      ),
    );
  }
  // These are authored malformed-word/valid-zero controls. Only the Dawn test
  // executes the real Field adapter and determines its rejection semantics.
});

it('retains the historical 33 positions and proves positive clearance to the authored solid', async () => {
  expect(
    canonicalVisibilityCases.slice(0, 33).map(({ origin, endpoint }) => ({ origin, endpoint })),
  ).toEqual(segmentCases);
  for (const rotated of [false, true]) {
    const prepared = await prepareCanonicalVisibility(rotated);
    const c = prepared.forward[0] ?? 0,
      s = prepared.forward[1] ?? 0;
    const signed = (p: readonly number[]) => -s * (p[0] ?? 0) + c * (p[1] ?? 0);
    for (const query of prepared.cases) {
      if (query.kind === 'blocked') {
        expect(signed(query.origin)).toBeGreaterThan(0);
        expect(signed(query.endpoint)).toBeLessThan(0);
      } else {
        expect(Math.min(signed(query.origin), signed(query.endpoint))).toBeGreaterThan(0.059);
      }
    }
    const field = prepared.projected.subarray(16 + prepared.plan.instanceWords);
    expect(Array.from(field.subarray(0, 3))).toEqual([
      SDF_SURFACE_POOL_LAYOUT.magic,
      SDF_SURFACE_POOL_LAYOUT.version,
      1,
    ]);
    expect(new Uint32Array(prepared.visibilityInputs.buffer, 48, 4)).toEqual(
      Uint32Array.from([prepared.plan.instanceWords, prepared.plan.fieldWords, 1, 17]),
    );
    expect(prepared.indices).toHaveLength(36);
    if (!rotated) {
      for (let z = 0; z < 9; z++)
        for (let y = 0; y < 9; y++)
          for (let x = 0; x < 9; x++)
            expect(prepared.samples[((z * 9 + y) * 9 + x) * 2]).toBe(-1 + y * 0.25);
    }
    const out = process.env.FORGEAX_GI_CANONICAL_VISIBILITY_CPU_EVIDENCE;
    if (out) {
      mkdirSync(out, { recursive: true });
      const prefix = rotated ? 'rotated-thin' : 'original';
      const inputs = {
        segments: new Uint8Array(prepared.pairs.buffer),
        field: prepared.fieldUniform,
        'visibility-inputs': prepared.visibilityInputs,
        coarse: new Uint8Array(prepared.samples.buffer),
        canonical: new Uint8Array(prepared.projected.buffer),
      };
      const files = Object.entries(inputs).map(([name, bytes]) => {
        const file = `${prefix}-${name}.bin`;
        writeFileSync(`${out}/${file}`, bytes);
        return {
          name: file,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      });
      writeFileSync(
        `${out}/${prefix}-prepared.json`,
        JSON.stringify(
          {
            files,
            grid: prepared.grid,
            plan: prepared.plan,
            cases: prepared.cases,
            forward: Array.from(prepared.forward),
            vertices: Array.from(prepared.vertices),
            indices: Array.from(prepared.indices),
            height: prepared.height,
            gpuCreated: false,
          },
          null,
          2,
        ),
      );
    }
  }
});

it('publishes the typed live interface through Builtin imports and preserves the baked four-buffer closure', async () => {
  const sampler = readFileSync(
    new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
    'utf8',
  );
  const imports = {
    'forgeax_ray::irradiance_field_sample': sampler,
    'forgeax_ray::field_visibility': FIELD_VISIBILITY_BOUNDS_WGSL,
  };
  const builtin = await loadEngineShaderEntries();
  expect(builtin.imports['forgeax_ray::field_visibility']).toBe(FIELD_VISIBILITY_BOUNDS_WGSL);
  const live = (
    await compileShader(segmentShader, {
      id: 'irradiance-field-canonical-segment-endpoint',
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
      computeEntry: 'verifySegmentEndpoint',
    })
  ).unwrap();
  const layout = live.reflection.boundGlobals.find(
    (entry) => entry.group === 1 && entry.binding === 4,
  );
  expect(layout?.span).toBe(64);
  expect(layout?.members?.map(({ name, offset, size }) => ({ name, offset, size }))).toEqual([
    { name: 'originSpacing', offset: 0, size: 16 },
    { name: 'dimensionsCount', offset: 16, size: 16 },
    { name: 'ranges', offset: 32, size: 16 },
    { name: 'expected', offset: 48, size: 16 },
  ]);
  expect(
    layout?.members?.find((member) => member.name === 'expected')?.typeDescriptor,
  ).toMatchObject({
    kind: 'vector',
    scalarKind: 'uint',
    width: 4,
    components: 4,
    byteSize: 16,
  });
  const source = `
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField}
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn verifyBaked(){result[0]=sampleIrradianceField(vec3f(0),vec3f(0,1,0),vec3f(0));}`;
  const baked = (
    await compileShader(source, {
      id: 'canonical-segment-baked-unaffected',
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: false },
      computeEntry: 'verifyBaked',
    })
  ).unwrap();
  expect(Array.from(baked.bindings[1]?.entries ?? []).map((entry) => entry.binding)).toEqual([
    0, 1, 2, 3,
  ]);
  // deps is a conservative HMR closure, not the selected entry's resource ABI.
  expect(
    baked.manifestEntry.entryPoints?.[0]?.bindings
      .filter((read) => read.group === 1)
      .map((read) => read.binding),
  ).toEqual([0, 1, 2, 3]);
  const out = process.env.FORGEAX_GI_CANONICAL_VISIBILITY_CPU_EVIDENCE;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/baseline-compiled.wgsl`, live.wgsl);
    writeFileSync(`${out}/baked-compiled.wgsl`, baked.wgsl);
    writeFileSync(
      `${out}/compilation.json`,
      JSON.stringify(
        { live: live.manifestEntry, baked: baked.manifestEntry, gpuCreated: false },
        null,
        2,
      ),
    );
  }
});
