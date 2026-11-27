import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FIELD_VISIBILITY_BOUNDS_WGSL } from '../../../../shader/src/field-visibility-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import { prepareCanonicalVisibility } from './irradiance-field-bounds-visibility.fixture';
import {
  canonicalSegmentPipeline,
  runCanonicalSegments,
} from './irradiance-field-bounds-visibility-gpu.fixture';
import { segmentShader } from './irradiance-field-segment.fixture';

it('certifies covered near-surface clearance by excluding Mesh leaf enclosures and rejects unknown coverage', async () => {
  const sampler = readFileSync(
    new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
    'utf8',
  );
  const compiled = (
    await compileShader(segmentShader, {
      id: 'irradiance-field-canonical-segment-endpoint',
      imports: {
        'forgeax_ray::irradiance_field_sample': sampler,
        'forgeax_ray::field_visibility': FIELD_VISIBILITY_BOUNDS_WGSL,
      },
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
      computeEntry: 'verifySegmentEndpoint',
    })
  ).unwrap();
  if (process.env.FORGEAX_GI_CANONICAL_COMPILED_SHA)
    expect(createHash('sha256').update(compiled.wgsl).digest('hex')).toBe(
      process.env.FORGEAX_GI_CANONICAL_COMPILED_SHA,
    );
  const out =
    process.env.FORGEAX_GI_CANONICAL_VISIBILITY_EVIDENCE ?? 'artifacts/irradiance-field/segment';
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/compiled.wgsl`, compiled.wgsl);
  writeFileSync(`${out}/sampler.wgsl`, sampler);
  writeFileSync(`${out}/canonical-module.wgsl`, FIELD_VISIBILITY_BOUNDS_WGSL);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('Canonical segment regression requires a real GPU');
  const actual = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  };
  if (process.env.FORGEAX_GI_CANONICAL_EXPECT_ADAPTER)
    expect(actual).toEqual(JSON.parse(process.env.FORGEAX_GI_CANONICAL_EXPECT_ADAPTER));
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const records: {
    rotated: boolean;
    covered: number[];
    unavailable: number[];
    expected: number[];
    admission: { name: string; word: number; bits: number; valid: boolean; values: number[] }[];
  }[] = [];
  const inputs: { name: string; bytes: number; sha256: string }[] = [];
  const frozenInputs: { name: string; bytes: number; sha256: string }[] = process.env
    .FORGEAX_GI_CANONICAL_FROZEN_INPUTS
    ? JSON.parse(readFileSync(process.env.FORGEAX_GI_CANONICAL_FROZEN_INPUTS, 'utf8'))
    : [];
  const save = (name: string, value: Uint8Array<ArrayBuffer>) => {
    const sha256 = createHash('sha256').update(value).digest('hex');
    const frozen = frozenInputs.find((input) => input.name === name);
    if (frozen) {
      expect(value.byteLength).toBe(frozen.bytes);
      expect(sha256).toBe(frozen.sha256);
    }
    writeFileSync(`${out}/${name}`, value);
    inputs.push({
      name,
      bytes: value.byteLength,
      sha256,
    });
  };
  try {
    const pipeline = await canonicalSegmentPipeline(device, compiled.wgsl, (stage) => {
      writeFileSync(
        `${out}/pipeline-${stage}.json`,
        JSON.stringify({ stage, at: new Date().toISOString() }),
      );
    });
    for (const rotated of [false, true]) {
      const prepared = await prepareCanonicalVisibility(rotated),
        prefix = rotated ? 'rotated-thin' : 'original';
      save(`${prefix}-segments.bin`, new Uint8Array(prepared.pairs.buffer));
      save(`${prefix}-field.bin`, prepared.fieldUniform);
      save(`${prefix}-visibility-inputs.bin`, prepared.visibilityInputs);
      save(`${prefix}-coarse.bin`, new Uint8Array(prepared.samples.buffer));
      save(`${prefix}-canonical.bin`, new Uint8Array(prepared.projected.buffer));
      const result = await runCanonicalSegments(device, pipeline, prepared);
      records.push({
        rotated,
        covered: result.covered,
        unavailable: result.unavailable,
        expected: prepared.cases.map((query) => query.expected),
        admission: result.admission,
      });
      save(`${prefix}-covered.f32`, new Uint8Array(Float32Array.from(result.covered).buffer));
      save(
        `${prefix}-unavailable.f32`,
        new Uint8Array(Float32Array.from(result.unavailable).buffer),
      );
      for (const control of result.admission)
        save(
          `${prefix}-${control.name}.f32`,
          new Uint8Array(Float32Array.from(control.values).buffer),
        );
    }
    // Keep blocker and unknown evidence even when the physical clear gate is RED.
    for (const record of records) {
      for (const control of record.admission) {
        const expected = control.valid
          ? record.covered
          : [...Array(33).fill(-1), ...Array(33).fill(1), -1];
        expect.soft(control.values, control.name).toEqual(expected);
      }
      expect
        .soft(
          record.unavailable.slice(0, 66),
          `original unknown footprint, rotated=${record.rotated}`,
        )
        .toEqual(Array(66).fill(-1));
      expect
        .soft(
          record.unavailable.at(-1),
          `blocker stays rejected; no claim of unknown classification, rotated=${record.rotated}`,
        )
        .not.toBe(1);
      expect.soft(record.covered.at(-1), `real blocker, rotated=${record.rotated}`).toBe(0);
      expect
        .soft(record.covered.slice(33, 66), `far clear, rotated=${record.rotated}`)
        .toEqual(Array(33).fill(1));
    }
    for (const record of records)
      expect
        .soft(
          record.covered.slice(0, 33),
          `independently clear near surface, rotated=${record.rotated}`,
        )
        .toEqual(Array(33).fill(1));
  } finally {
    try {
      await device.queue.onSubmittedWorkDone();
    } finally {
      device.destroy();
      writeFileSync(
        `${out}/result.json`,
        JSON.stringify(
          {
            adapter: actual,
            records,
            assessment: records.map((record) => ({
              rotated: record.rotated,
              clearNear: record.covered.slice(0, 33),
              clearFar: record.covered.slice(33, 66),
              opaqueBlocker: record.covered[66],
              originalUnavailable: record.unavailable.slice(0, 66),
              blockerUnavailablePolicyRaw: record.unavailable[66],
            })),
            inputs,
            errors,
            backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
            scope:
              'Actual compute visibility queries, not Ray Query, rendered GI, whole-scene or performance acceptance.',
          },
          null,
          2,
        ),
      );
      expect.soft(errors).toEqual([]);
    }
  }
}, 60_000);
