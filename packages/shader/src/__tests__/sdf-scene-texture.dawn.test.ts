import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/index';
import {
  sceneTextureCases,
  sceneTextureExpected,
  sceneTextureInitializationExpected,
  sceneTextureInitializationKernel,
  sceneTextureReaderVariants,
} from './sdf-scene-texture.fixture';
import { assessSceneTextureReader, runSceneTextureReader } from './sdf-scene-texture-gpu.fixture';

it('reads only an accepted canonical snapshot and rejects epoch, padding and high-water mistakes', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Reader acceptance requires an actual GPU adapter');
  const info = adapter.info;
  const identity = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
  };
  if (![identity.vendor, identity.device, identity.description].some(Boolean))
    throw Error('Actual adapter identity required');
  if (process.env.FORGEAX_SCENE_TEXTURE_READER_EXPECT_ADAPTER)
    expect(identity).toEqual(JSON.parse(process.env.FORGEAX_SCENE_TEXTURE_READER_EXPECT_ADAPTER));
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const rows = sceneTextureCases();
  const expected = sceneTextureExpected(rows);
  const results = [];
  const directory =
    process.env.FORGEAX_SCENE_TEXTURE_READER_OUTPUT ??
    join(tmpdir(), `forgeax-scene-reader-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'cases.json'),
    JSON.stringify(
      rows.map((row) => ({ ...row, words: Array.from(row.words), source: Array.from(row.source) })),
      null,
      2,
    ),
  );
  try {
    for (const variant of sceneTextureReaderVariants()) {
      const compiled = (await compileShader(variant.source, { id: variant.name })).unwrap();
      writeFileSync(join(directory, `${variant.name}.wgsl`), compiled.wgsl);
      const raw = await runSceneTextureReader(device, compiled.wgsl, rows);
      writeFileSync(join(directory, `${variant.name}.bin`), new Uint8Array(raw.buffer));
      for (const index of rows.keys()) {
        expect(raw[index * 24 + 22], 'One independent expected-source read per invocation').toBe(1);
        expect(raw[index * 24 + 23], 'Every bound invocation must complete its own record').toBe(
          0x51df0000 | index,
        );
      }
      const failures = assessSceneTextureReader(rows, raw, expected);
      results.push({ name: variant.name, negative: variant.negative, failures });
      if (!variant.negative) expect(failures).toEqual([]);
      else {
        const names = failures.map((row) => row.name);
        const required =
          variant.name === 'epoch-ignored'
            ? ['stale-header-epoch', 'stale-expected-epoch']
            : variant.name === 'self-described-padding'
              ? [
                  'different-canonical-field-span',
                  'self-consistent-header-lies-about-field-padding',
                ]
              : [
                  'qualified-transport-row0',
                  'raw-capacity-is-not-candidate-highwater',
                  'zero-highwater-retains-raw-capacity',
                ];
        expect(names).toEqual(required);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'receipt.json'),
      JSON.stringify(
        {
          identity,
          results,
          errors,
          deviceDestroyed: true,
          scope:
            'Integer reader plus existing metadata decoder only. Not a triangle/Scene publication/World/GI/performance acceptance.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);

it('rejects uninitialized word reads and initializes exactly once before packet access', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Reader initialization requires an actual adapter');
  const identity = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  };
  if (process.env.FORGEAX_SCENE_TEXTURE_READER_EXPECT_ADAPTER)
    expect(identity).toEqual(JSON.parse(process.env.FORGEAX_SCENE_TEXTURE_READER_EXPECT_ADAPTER));
  const compiled = (
    await compileShader(sceneTextureInitializationKernel(), {
      id: 'scene-reader-explicit-initialization',
    })
  ).unwrap();
  if (process.env.FORGEAX_SCENE_TEXTURE_READER_INIT_COMPILED_SHA)
    expect(createHash('sha256').update(compiled.wgsl).digest('hex')).toBe(
      process.env.FORGEAX_SCENE_TEXTURE_READER_INIT_COMPILED_SHA,
    );
  const directory =
    process.env.FORGEAX_SCENE_TEXTURE_READER_INIT_OUTPUT ??
    join(tmpdir(), `forgeax-scene-init-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'compiled.wgsl'), compiled.wgsl);
  const rows = sceneTextureCases(),
    expected = sceneTextureInitializationExpected(rows);
  const cases = JSON.stringify(
    rows.map((row) => ({ ...row, words: Array.from(row.words), source: Array.from(row.source) })),
    null,
    2,
  );
  if (process.env.FORGEAX_SCENE_TEXTURE_READER_INIT_CASES_SHA)
    expect(createHash('sha256').update(cases).digest('hex')).toBe(
      process.env.FORGEAX_SCENE_TEXTURE_READER_INIT_CASES_SHA,
    );
  writeFileSync(join(directory, 'cases.json'), cases);
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const raw = await runSceneTextureReader(device, compiled.wgsl, rows);
    writeFileSync(join(directory, 'actual.u32'), new Uint8Array(raw.buffer));
    writeFileSync(join(directory, 'expected.u32'), new Uint8Array(expected.buffer));
    const failures = assessSceneTextureReader(rows, raw, expected);
    writeFileSync(
      join(directory, 'assessment.json'),
      JSON.stringify({ identity, failures, rows: rows.map((row) => row.name), errors }, null, 2),
    );
    expect(failures).toEqual([]);
  } finally {
    try {
      await device.queue.onSubmittedWorkDone();
    } finally {
      device.destroy();
      writeFileSync(
        join(directory, 'cleanup.json'),
        JSON.stringify({ destroyCalled: true, errors }),
      );
      expect.soft(errors).toEqual([]);
    }
  }
}, 60_000);
