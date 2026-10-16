import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CARD_LOOKUP_STRIDE, CardLookupStatus } from '../../raytracing/card-lookup';
import { verifyCardCoverage } from './card-coverage.fixture';
import { verifyCardSampling } from './card-sampling.fixture';
import {
  verifyFittedNearPlaneCards,
  verifyMultiMaterialCards,
} from './multi-material-cards.fixture';
import { prepareLutSdfCardsFixture, prepareSdfCardsFixture } from './sdf-cards.commands';
import { verifySdfCards } from './sdf-cards.fixture';
import { verifySdfCases } from './sdf-cases.fixture';
import { verifySdfExpansion } from './sdf-expansion.fixture';
import { verifyCardMaterial } from './sdf-material.fixture';
import { verifyTwoSidedSdf } from './sdf-two-sided.fixture';
import { verifyVisibilityCards } from './visibility-cards.fixture';

it('preserves fitted inner Card near planes through actual raster capture', async () => {
  const evidence = await verifyFittedNearPlaneCards(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const item of evidence) {
      for (const [plane, bytes] of item.planes.entries())
        await writeFile(`${dir}/inner-card-${item.kind}-plane-${plane}.bin`, bytes);
    }
    await writeFile(
      `${dir}/inner-card.json`,
      JSON.stringify(
        evidence.map(({ planes, ...item }) => item),
        null,
        2,
      ),
    );
  }
}, 120000);

it('normalizes depth-qualified Card texels without leaking across atlas tiles', async () => {
  const captures = await verifyCardSampling(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const capture of captures) {
      await writeFile(`${dir}/card-sampling-${capture.mode}.rhitape`, capture.tape);
      await writeFile(`${dir}/card-sampling-${capture.mode}.bin`, capture.lookup);
      for (const [i, bytes] of capture.planes.entries())
        await writeFile(`${dir}/card-sampling-${capture.mode}-plane-${i}.bin`, bytes);
    }
  }
}, 120000);

it('retains valid LUT Card samples through depth and atlas filtering', async () => {
  const captures = await verifyCardSampling(await prepareLutSdfCardsFixture());
  for (const capture of captures) {
    const view = new DataView(
      capture.lookup.buffer,
      capture.lookup.byteOffset,
      capture.lookup.byteLength,
    );
    for (let offset = 0; offset < capture.lookup.byteLength; offset += CARD_LOOKUP_STRIDE) {
      if (view.getUint32(offset, true) === CardLookupStatus.mapped)
        expect(view.getFloat32(offset + 76, true)).toBe(5);
    }
  }
}, 120000);

it('selects caller-owned visibility expansion without losing the near-occluder control', async () => {
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  await verifySdfExpansion(async (tape, live) => {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/sdf-expansion.rhitape`, tape);
    for (const [i, bytes] of live.entries())
      await writeFile(`${dir}/sdf-expansion-${i}.bin`, bytes);
  });
}, 120000);

it('captures actual shared-material cards and traces conservative SDF bands on Dawn', async () => {
  const fixture = await prepareSdfCardsFixture();
  const result = await verifySdfCards(fixture);
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/sdf-cards.rhitape`, result.tape);
    await writeFile(`${dir}/sdf-hits.bin`, result.live);
    await writeFile(`${dir}/sdf-lookup.bin`, result.mapped);
    for (const [i, bytes] of result.planes.entries())
      await writeFile(`${dir}/card-plane-${i}.bin`, bytes);
    await writeFile(`${dir}/sdf-prepared.json`, JSON.stringify(fixture));
  }
}, 120000);

it('keeps transformed, missing, stale and uncaptured SDF outcomes explicit', async () => {
  await verifySdfCases(await prepareSdfCardsFixture());
}, 120000);

it('matches textured UV1 and vertex-color cards with ray-hit Surface', async () => {
  await verifyCardMaterial(await prepareSdfCardsFixture());
}, 120000);

it('captures open and two-sided MASK sheets with variable card counts and empty atlas padding', async () => {
  const result = await verifyCardCoverage(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/card-coverage.rhitape`, result.tape);
    await writeFile(
      `${dir}/card-coverage.json`,
      JSON.stringify({ counts: result.counts, viewCounts: result.viewCounts }),
    );
    for (const [i, bytes] of result.planes.entries())
      await writeFile(`${dir}/card-coverage-plane-${i}.bin`, bytes);
    for (const [i, view] of result.exactViews.entries()) {
      await writeFile(`${dir}/card-exact-view-${i}.rhitape`, view.tape);
      for (const [plane, bytes] of view.planes.entries())
        await writeFile(`${dir}/card-exact-view-${i}-plane-${plane}.bin`, bytes);
    }
  }
}, 120000);

it('traces both sides of loaded thin-sheet fields and replays hits and material mapping', async () => {
  const result = await verifyTwoSidedSdf(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/two-sided.rhitape`, result.tape);
    await writeFile(`${dir}/two-sided-hits.bin`, result.live);
    await writeFile(`${dir}/two-sided-lookup.bin`, result.mapped);
    await writeFile(`${dir}/two-sided.json`, JSON.stringify(result.metrics, null, 2));
  }
}, 120000);

it('shares whole-mesh card depth across material sections and rejects stale colors', async () => {
  const evidence = await verifyMultiMaterialCards(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const [i, item] of evidence.entries()) {
      await writeFile(`${dir}/multi-material-${i}.rhitape`, item.tape);
      for (const [plane, bytes] of item.planes.entries())
        await writeFile(`${dir}/multi-material-${i}-plane-${plane}.bin`, bytes);
      for (const read of item.buffers)
        await writeFile(`${dir}/multi-material-${i}-work-${read.work}.bin`, read.bytes);
    }
    await writeFile(
      `${dir}/multi-material.json`,
      JSON.stringify(
        evidence.map((e) => ({
          works: e.works,
          rasterWorks: e.rasterWorks,
          colors: e.colors,
          buffers: e.buffers.map((b) => ({ work: b.work, binding: b.binding })),
        })),
      ),
    );
  }
}, 120000);

it('maps sampled visibility hits with zero allowance and rejects invalid card associations', async () => {
  await verifyVisibilityCards(await prepareSdfCardsFixture());
}, 120000);
