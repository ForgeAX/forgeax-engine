import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColorImage } from '../tools/image-metrics';
import { plate, subject } from './visual-fixture';

let root = '';

function png(name: string, image: ColorImage): void {
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++)
      rgba[i * 4 + c] = Math.round((image.rgb[i * 3 + c] as number) * 255);
    rgba[i * 4 + 3] = 255;
  }
  writeFileSync(join(root, name), encodePng(image.width, image.height, rgba));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'visual-tools-'));
  mkdirSync(join(root, 'out'));
  png('ref.png', subject(160, { eye: [0.58, 0.38, 0.06] }));
  png('same.png', subject(224, { eye: [0.58, 0.38, 0.06] }));
  png('other.png', subject(160, { eye: [0.58, 0.38, 0.06], body: [0.5, 0.5, 0.42, 0.18] }));
  for (const a of [0, 90, 180, 270]) png(`t${a}.png`, plate(128, { azimuth: a }));
  png('t90-thin.png', plate(128, { azimuth: 90, thin: true }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(id: string, args: Record<string, unknown>) {
  const tool = createModelingTools({ projectRoot: root }).find((t) => t.descriptor.id === id);
  if (tool === undefined) throw new Error(id);
  return tool.execute(args as never, {} as never) as Promise<{
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string };
  }>;
}

describe('visual feedback tools', () => {
  it('model.compare reads project PNGs and writes the sheet under out', async () => {
    const r = await run('model.compare', { reference: 'ref.png', render: 'same.png', out: 'out' });
    expect(r.ok).toBe(true);
    expect(r.value?.verdict).toBe('pass');
    expect(r.value?.artifacts).toEqual(['out/compare-sheet.png', 'out/compare-delta-e.png']);
    expect(existsSync(join(root, 'out/compare-sheet.png'))).toBe(true);
  });

  it('model.compare reports a rejected silhouette without writing when out is absent', async () => {
    const r = await run('model.compare', { reference: 'ref.png', render: 'other.png' });
    expect(r.value?.verdict).toBe('reject');
    expect(r.value?.artifacts).toBeUndefined();
  });

  it('refuses paths outside the project root and unreadable files', async () => {
    expect(
      (await run('model.compare', { reference: '../ref.png', render: 'ref.png' })).error?.code,
    ).toBe('tool-invalid-args');
    expect(
      (await run('model.compare', { reference: 'missing.png', render: 'ref.png' })).error?.code,
    ).toBe('tool-invalid-args');
    expect(
      (await run('model.compare', { reference: 'ref.png', render: 'ref.png', out: '../escape' }))
        .error?.code,
    ).toBe('tool-invalid-args');
  });

  it('model.compare validates options', async () => {
    const r = await run('model.compare', { reference: 'ref.png', render: 'ref.png', size: 100 });
    expect(r.error?.code).toBe('tool-invalid-args');
  });

  it('model.microscope scores features from files', async () => {
    const r = await run('model.microscope', {
      reference: 'ref.png',
      render: 'same.png',
      features: [{ id: 'eye', tier: 'critical', roi: [0.5, 0.2, 0.85, 0.55] }],
    });
    expect(r.ok).toBe(true);
    expect(r.value?.schema).toBe('forgeax.model.microscope/1');
    expect(r.value?.pass).toBe(true);
    const bad = await run('model.microscope', {
      reference: 'ref.png',
      render: 'same.png',
      features: [{ id: 'eye', tier: 'critical', roi: [0.9, 0.2, 0.5, 0.55] }],
    });
    expect(bad.error?.code).toBe('tool-invalid-args');
  });

  it('model.turntable passes a full orbit and fails a missing azimuth and a billboard', async () => {
    const orbit = (side: string) =>
      [0, 90, 180, 270].map((a) => ({ azimuth: a, path: a === 90 ? side : `t${a}.png` }));
    const ok = await run('model.turntable', { captures: orbit('t90.png') });
    expect(ok.value?.pass).toBe(true);
    const thin = await run('model.turntable', { captures: orbit('t90-thin.png') });
    expect(thin.value?.pass).toBe(false);
    const missing = await run('model.turntable', {
      captures: [0, 180].map((a) => ({ azimuth: a, path: `t${a}.png` })),
    });
    expect(
      (missing.value?.issues as { code: string }[]).some((i) => i.code === 'azimuth-missing'),
    ).toBe(true);
  });

  it('model.converge routes a history and validates it', async () => {
    const stop = await run('model.converge', {
      history: [{ fidelity: 0.9, defectTags: [], reverted: false }],
    });
    expect(stop.value).toMatchObject({ stop: true, rule: 'success', action: 'accept' });
    const bad = await run('model.converge', {
      history: [{ fidelity: 1.5, defectTags: [], reverted: false }],
    });
    expect(bad.error?.code).toBe('tool-invalid-args');
  });

  it('model.accept folds results into a pass table and rejects an unknown gate', async () => {
    const contract = [{ level: 'L0', part: 'body', gates: ['validate'] }];
    const ok = await run('model.accept', {
      build: 'b1',
      contract,
      results: [{ level: 'L0', part: 'body', gate: 'validate', pass: true, build: 'b1' }],
    });
    expect(ok.value).toMatchObject({ pass: true, reached: 'L0' });
    const bad = await run('model.accept', {
      build: 'b1',
      contract,
      results: [{ level: 'L0', part: 'body', gate: 'nope', pass: true, build: 'b1' }],
    });
    expect(bad.error?.code).toBe('tool-invalid-args');
  });
});
