import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { prepareDiffuseGiFixture } from './diffuse-gi.commands';
import { runGi, verifyDiffuseGi, verifyGiReplay } from './diffuse-gi.fixture';

it('renders offscreen diffuse color bounce with raster primary and shared SDF lighting', async () => {
  const fixture = await prepareDiffuseGiFixture();
  const result = await runGi(fixture, { capture: true });
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    for (const name of ['field', 'reference', 'surface', 'probes'] as const)
      await writeFile(`${directory}/gi-${name}.bin`, result[name]);
    await writeFile(`${directory}/gi-prepared.json`, JSON.stringify(fixture));
    await writeFile(`${directory}/gi-diagnostics.json`, JSON.stringify(result.diagnostics));
    if (result.tape) await writeFile(`${directory}/gi.rhitape`, result.tape);
  }
  await verifyGiReplay(result);
  verifyDiffuseGi(result);
}, 120000);

import {
  verifyGiChanges,
  verifyGiEnergy,
  verifyGiOcclusion,
  verifyGiPunctual,
} from './diffuse-gi-cases.fixture';

it('preserves energy, finite generations and visibility through light/view/coverage changes', async () => {
  const fixture = await prepareDiffuseGiFixture();
  await verifyGiEnergy(fixture);
  await verifyGiChanges(fixture);
  await verifyGiOcclusion(fixture);
  await verifyGiPunctual(fixture);
}, 180000);

import { verifyGiPathReference } from './diffuse-gi-reference.fixture';

it('compares GI against independent exact-hit shared-material path tracing', async () => {
  const result = await verifyGiPathReference(await prepareDiffuseGiFixture());
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/gi-pt.bin`, result.reference);
    await writeFile(
      `${directory}/gi-pt-comparison.json`,
      JSON.stringify({ ...result, reference: undefined }),
    );
  }
}, 180000);

import { verifyGiRoom } from './diffuse-gi-room.fixture';

it('preserves known-solid shadow occlusion and exposes enclosed-room feedback gaps', async () => {
  const fixture = await prepareDiffuseGiFixture();
  const result = await verifyGiRoom(
    fixture,
    false,
    process.env.FORGEAX_RAY_EVIDENCE
      ? async (result) => {
          const directory = process.env.FORGEAX_RAY_EVIDENCE;
          if (!directory) throw new Error('Missing evidence directory');
          await mkdir(directory, { recursive: true });
          for (const name of ['field', 'reference', 'surface', 'probes'] as const)
            await writeFile(`${directory}/room-${name}.bin`, result[name]);
          await writeFile(`${directory}/room-diagnostics.json`, JSON.stringify(result.diagnostics));
          if (result.tape) await writeFile(`${directory}/room.rhitape`, result.tape);
        }
      : undefined,
  );
  const feedback = await verifyGiRoom(fixture, true);
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    for (const name of ['field', 'reference', 'surface', 'probes'] as const)
      await writeFile(`${directory}/room-${name}.bin`, result[name]);
    await writeFile(
      `${directory}/room-diagnostics.json`,
      JSON.stringify({ ...result.diagnostics, completePixels: result.completePixels }),
    );
    await writeFile(
      `${directory}/feedback-diagnostics.json`,
      JSON.stringify({ ...feedback.diagnostics, completePixels: feedback.completePixels }),
    );
    for (const name of ['field', 'reference', 'surface', 'probes'] as const)
      await writeFile(`${directory}/feedback-${name}.bin`, feedback[name]);
  }
}, 180000);

import { verifyGiFallback } from './diffuse-gi-cases.fixture';

it('falls back from unavailable probe support to local scene transport', async () => {
  await verifyGiFallback(await prepareDiffuseGiFixture());
}, 120000);

import { verifyGiPerspective } from './gi-view.fixture';

it('matches the perspective raster primary against independent exact triangle rays', async () => {
  await verifyGiPerspective(await prepareDiffuseGiFixture());
}, 120000);
