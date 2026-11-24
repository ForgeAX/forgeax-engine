import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  clearanceQuery,
  clearanceThirdEdgeBlock,
  runClearanceQualification,
} from './irradiance-field-clearance-qualification-gpu.fixture';

it('retains known independent clearance support without publishing pending relocation history', {
  timeout: 30_000,
}, async () => {
  const sampler = readFileSync(
    new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
    'utf8',
  );
  const compiled = (
    await compileShader(clearanceQuery, {
      id: 'field-independent-clearance-qualification',
      imports: { 'forgeax_ray::irradiance_field_sample': sampler },
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  expect(adapter).not.toBeNull();
  if (!adapter) throw Error('Actual GPU adapter required');
  const info = adapter.info,
    actual = Object.fromEntries(
      ['vendor', 'architecture', 'device', 'description'].map((k) => [
        k,
        info[k as keyof GPUAdapterInfo],
      ]),
    );
  const out = process.env.FORGEAX_GI_CLEARANCE_EVIDENCE;
  const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
  const prepared = process.env.FORGEAX_GI_CLEARANCE_PREPARED
    ? JSON.parse(readFileSync(process.env.FORGEAX_GI_CLEARANCE_PREPARED, 'utf8'))
    : undefined;
  const receipt: {
    adapter: typeof actual;
    samplerSHA256: string;
    wgslSHA256: string;
    inputs: unknown[];
    results?: Record<string, number[]>;
    error?: string;
    deviceDestroyed: boolean;
    validationErrors: string[];
    phases: { stage: string; name: string | null; at: number }[];
    thirdEdgeMutant?: { wgslSHA256: string; output: number[]; outputSHA256: string };
  } = {
    adapter: actual,
    samplerSHA256: sha(sampler),
    wgslSHA256: sha(compiled.wgsl),
    inputs: [],
    deviceDestroyed: false,
    validationErrors: [],
    phases: [],
  };
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/actual-production.wgsl`, compiled.wgsl);
    writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  }
  let device: GPUDevice | undefined;
  const phase = (scope: string) => (stage: string, name?: string) => {
    receipt.phases.push({ stage: `${scope}.${stage}`, name: name ?? null, at: Date.now() });
    if (out) writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  };
  const caseInputHashes = new Map<string, unknown>();
  try {
    if (process.env.FORGEAX_GI_REQUIRE_RTX4080 === '1')
      expect(actual).toEqual({
        vendor: 'nvidia',
        architecture: 'lovelace',
        device: 'nvidia-geforce-rtx-4080',
        description: 'D3D12 driver version 32.0.16.1742',
      });
    if (process.env.FORGEAX_GI_EXPECT_WGSL_SHA)
      expect(receipt.wgslSHA256).toBe(process.env.FORGEAX_GI_EXPECT_WGSL_SHA);
    device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) =>
      receipt.validationErrors.push(e.error.message),
    );
    const result = await runClearanceQualification(
      device,
      compiled.wgsl,
      (name, input, output) => {
        const fields = Object.fromEntries(
          Object.entries(input).map(([key, data]) => {
            const b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (out) writeFileSync(`${out}/${name}-${key}.bin`, b);
            return [key, { bytes: b.length, sha256: sha(b) }];
          }),
        );
        if (prepared) {
          const expected = prepared.inputs.find((r: { name: string }) => r.name === name);
          expect(expected).toBeDefined();
          for (const [key, value] of Object.entries(fields)) {
            const match = expected.spans.find((s: { key: string }) => s.key === key);
            expect(value).toEqual({ bytes: match.bytes, sha256: match.sha256 });
          }
        }
        if (out) writeFileSync(`${out}/${name}-output.bin`, output);
        if (process.env.FORGEAX_GI_EXPECT_MAIN_ROOT)
          expect(
            Buffer.compare(
              Buffer.from(output),
              readFileSync(`${process.env.FORGEAX_GI_EXPECT_MAIN_ROOT}/${name}-output.bin`),
            ),
            'Same actual10 raw output bytes after fixture pipeline de-duplication',
          ).toBe(0);
        caseInputHashes.set(name, fields);
        receipt.inputs.push({
          name,
          fields,
          outputBytes: output.length,
          outputSHA256: sha(output),
        });
      },
      undefined,
      phase('production'),
    );
    receipt.results = result;
    expect(receipt.validationErrors).toEqual([]);
    const output = (name: string) => {
      const r = result[name];
      if (!r) throw Error(`Missing ${name}`);
      return r;
    };
    expect(output('inside')[3], 'Known inside-only fallback positive control').toBe(1);
    for (const [c, v] of [0.25, 0.125, 0.5].entries())
      expect(Math.abs((output('inside')[c] ?? NaN) - v)).toBeLessThanOrEqual(2e-6);
    expect(output('supported-black').slice(0, 4)).toEqual([0, 0, 0, 1]);
    for (const name of [
      'untraced',
      'invalid',
      'alternative-untraced',
      'bad-anchor',
      'unknown-anchor',
      'across-wall',
    ])
      expect(output(name)[3], `${name} must not become supported`).toBeLessThanOrEqual(0);
    expect(output('pending')[4], 'Actual normal-clearance anchor must be clear').toBe(1);
    expect(output('bad-anchor')[4]).toBe(0);
    expect(output('unknown-anchor')[4]).toBe(-1);
    expect(output('third-edge-wedge')[4], 'Biased receiver to anchor must be clear').toBe(1);
    expect(
      output('third-edge-wedge')[8],
      'Biased receiver to sole active probe must be clear',
    ).toBe(1);
    expect(
      output('third-edge-wedge')[12],
      'Anchor to active probe must hit the authored wedge',
    ).toBe(0);
    expect(
      output('third-edge-wedge')[3],
      'Blocked third edge must not publish the alternative',
    ).toBeLessThanOrEqual(0);
    for (const index of [8, 12, 16, 20])
      expect(
        output('across-wall')[index],
        'Actual segment to bright other side must be occluded',
      ).toBe(0);
    // This exact assertion is intentionally RED on the original production
    // sampler and must become GREEN through its owning implementation only.
    expect(
      output('pending')[3],
      'Independent known alternative must survive while pending corner itself remains unpublished',
    ).toBe(1);
    expect(
      sampler.split(clearanceThirdEdgeBlock).length,
      'Exactly one explicit third-edge control site',
    ).toBe(2);
    const missingThird = sampler.replace(clearanceThirdEdgeBlock, '');
    const mutant = (
      await compileShader(clearanceQuery, {
        id: 'field-independent-clearance-third-edge-mutant',
        imports: { 'forgeax_ray::irradiance_field_sample': missingThird },
        defines: { IRRADIANCE_FIELD_VISIBILITY: true },
      })
    ).unwrap();
    if (prepared?.mutantWGSLHash) expect(sha(mutant.wgsl)).toBe(prepared.mutantWGSLHash);
    if (out) writeFileSync(`${out}/third-edge-mutant.wgsl`, mutant.wgsl);
    const wrong = await runClearanceQualification(
      device,
      mutant.wgsl,
      (name, input, bytes) => {
        const fields = Object.fromEntries(
          Object.entries(input).map(([key, data]) => [
            key,
            {
              bytes: data.byteLength,
              sha256: sha(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
            },
          ]),
        );
        expect(fields).toEqual(caseInputHashes.get(name));
        if (out) writeFileSync(`${out}/third-edge-mutant-output.bin`, bytes);
        receipt.thirdEdgeMutant = {
          wgslSHA256: sha(mutant.wgsl),
          output: Array.from(new Float32Array(bytes.buffer)),
          outputSHA256: sha(bytes),
        };
      },
      ['third-edge-wedge'],
      phase('mutant'),
    );
    expect(
      wrong['third-edge-wedge']?.[3],
      'Removing only third-edge verification must expose the lit wrong alternative',
    ).toBe(1);
    expect(receipt.validationErrors).toEqual([]);
  } catch (error) {
    receipt.error = String(error);
    throw error;
  } finally {
    if (device) {
      device.destroy();
      receipt.deviceDestroyed = true;
    }
    if (out) writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  }
});
