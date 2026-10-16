import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifyGpuPathSource } from './path-buffer.fixture';
import { prepareRayPathFixture } from './path-tracer.commands';

it('consumes GPU-written receiver rays in command order and replays both source generations', async () => {
  const result = await verifyGpuPathSource(await prepareRayPathFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'gpu-source.rhitape'), result.bytes);
    await writeFile(join(dir, 'gpu-source-lit.bin'), result.lit);
    await writeFile(join(dir, 'gpu-source-dark.bin'), result.dark);
  }
}, 120000);

it('declares real producer and transport work in RenderGraph without hiding compute in copy passes', async () => {
  const result = await verifyGpuPathSource(await prepareRayPathFixture(), true);
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'graph-source.rhitape'), result.bytes);
    await writeFile(join(dir, 'graph-source-lit.bin'), result.lit);
    await writeFile(join(dir, 'graph-source-dark.bin'), result.dark);
  }
}, 120000);
