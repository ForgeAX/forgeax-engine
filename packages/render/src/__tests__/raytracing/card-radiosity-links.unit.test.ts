import { expect, it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../../../../naga/src/index';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import { irradianceFieldKernelBindings } from '../../raytracing/irradiance-field';
import {
  authoredWallIntersects,
  cardCrossWallLinks,
  cardLinkConsumer,
  cardLinkStageSource,
  cardLinkStatus,
  unknownLinkStates,
} from './card-radiosity-links.fixture';

for (const traversal of ['global-sdf', 'ray-query'] as const) {
  it(`validates the actual ${traversal} geometry-only Card-link stage`, async () => {
    const parsed = (await parse(cardLinkStageSource(traversal))).unwrap();
    const checked = await validate(parsed);
    if (!checked.ok) {
      parsed.free();
      throw new Error(checked.error.message);
    }
    try {
      const reflection = parseReflectionWire((await emit_reflection(checked.value, '{}')).unwrap());
      expect(reflection.entryPoints?.map((entry) => entry.name)).toEqual([
        'visibilityCardRadiosity',
      ]);
      const storage = reflection.boundGlobals.filter(
        (entry) => entry.resourceKind === 'storage-buffer',
      );
      // Global World uses four storage resources; hardware World uses two.
      // Pages/surfaces/origins/links add four, within the original device cap8.
      expect(storage.length).toBe(traversal === 'global-sdf' ? 8 : 6);
      expect(storage.length).toBeLessThanOrEqual(8);
      expect(reflection.boundGlobals.map((row) => row.binding).sort((a, b) => a - b)).toEqual(
        irradianceFieldKernelBindings(traversal, 'visibilityCardRadiosity')
          .map(([binding]) => binding)
          .sort((a, b) => a - b),
      );
      expect(
        reflection.boundGlobals.find((row) => row.binding === 8)?.typeDescriptor,
      ).toMatchObject({
        kind: 'array',
        stride: 16,
        element: { kind: 'vector', scalarKind: 'uint', components: 4 },
      });
      expect(
        reflection.boundGlobals.find((row) => row.binding === 9)?.typeDescriptor?.byteSize,
      ).toBe(128);
      expect(
        reflection.boundGlobals.find((row) => row.binding === 10)?.typeDescriptor?.byteSize,
      ).toBe(64);
    } finally {
      checked.value.free();
    }
  });
}

it('rejects both actual crossing links instead of treating positive soft weights as clear', () => {
  for (const link of cardCrossWallLinks) {
    expect(authoredWallIntersects(link.a, link.b), link.name).toBe(true);
    expect(link.formerSoftWeight).toBeGreaterThan(0);
    const mask = cardLinkStatus(GlobalSdfQueryStatus.hit);
    expect(mask, link.name).toBe(2);
    for (const stage of ['filterCardRadiosity', 'resolveCardRadiosity'] as const)
      expect(cardLinkConsumer(stage, { forward: mask, reverse: mask, texel: mask })).toBe(false);
  }
  expect(authoredWallIntersects([0, 0, -2], [1, 0, -2])).toBe(false);
  expect(cardLinkStatus(GlobalSdfQueryStatus.miss)).toBe(1);
  expect(cardLinkStatus(GlobalSdfQueryStatus.negativeStart)).toBe(2);
});

it('preserves unknown and requires current model and epoch before either mask consumer accepts', () => {
  for (const status of unknownLinkStates) expect(cardLinkStatus(status)).toBe(0);
  for (const stage of ['filterCardRadiosity', 'resolveCardRadiosity'] as const) {
    expect(cardLinkConsumer(stage, { forward: 1, reverse: 1, texel: 1 })).toBe(true);
    for (const mask of [0, 2])
      expect(cardLinkConsumer(stage, { forward: mask, reverse: mask, texel: mask })).toBe(false);
    expect(cardLinkConsumer(stage, { forward: 1, reverse: 1, texel: 1, epoch: 2 })).toBe(false);
    expect(cardLinkConsumer(stage, { forward: 1, reverse: 1, texel: 1, model: 2 })).toBe(false);
    // Controlled deletion of each real gate activates the otherwise rejected input.
    expect(
      cardLinkConsumer(stage, { forward: 0, reverse: 0, texel: 0, removeMaskGuard: true }),
    ).toBe(true);
    expect(
      cardLinkConsumer(stage, { forward: 1, reverse: 1, texel: 1, epoch: 2, ignoreStamp: true }),
    ).toBe(true);
  }
  expect(cardLinkConsumer('filterCardRadiosity', { forward: 1, reverse: 0, texel: 1 })).toBe(false);
  expect(cardLinkConsumer('filterCardRadiosity', { forward: 0, reverse: 1, texel: 1 })).toBe(false);
});
