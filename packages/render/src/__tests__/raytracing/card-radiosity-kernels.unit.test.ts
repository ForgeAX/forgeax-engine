import { expect, it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../../../../naga/src/index';
import {
  irradianceFieldKernelBindings,
  irradianceFieldKernelWgsl,
} from '../../raytracing/irradiance-field';
import { cardRadiosityStatusFixture } from './card-radiosity-status.fixture';
import { cardVisibilityFixture } from './card-radiosity-visibility.fixture';

it('validates the actual probe-visibility helpers and controlled plane-only negative', async () => {
  const parsed = (await parse(cardVisibilityFixture)).unwrap();
  const checked = (await validate(parsed)).unwrap();
  try {
    expect(
      parseReflectionWire((await emit_reflection(checked, '{}')).unwrap()).entryPoints?.map(
        (entry) => entry.name,
      ),
    ).toEqual(['auditCardProbeVisibility']);
  } finally {
    checked.free();
  }
});

it('validates the production transport handler and former-classifier GPU negative control', async () => {
  const parsed = (await parse(cardRadiosityStatusFixture)).unwrap();
  const checked = (await validate(parsed)).unwrap();
  try {
    expect(
      parseReflectionWire((await emit_reflection(checked, '{}')).unwrap()).entryPoints?.map(
        (entry) => entry.name,
      ),
    ).toEqual(['auditCardRadiosityStatus']);
  } finally {
    checked.free();
  }
});

const stages = [
  'prepareCardRadiosityBounce',
  'placeCardRadiosity',
  'traceCardRadiosity',
  'visibilityCardRadiosity',
  'filterCardRadiosity',
  'integrateCardRadiosity',
  'resolveCardRadiosity',
] as const;

for (const traversal of ['global-sdf', 'ray-query'] as const) {
  it(`validates actual ${traversal} Card-space producer entries and reflected storage limits`, async () => {
    const sources = irradianceFieldKernelWgsl(traversal);
    for (const stage of stages) {
      // These complete owner-generated programs already have one entry. Parse,
      // validate and reflect directly: portable WGSL re-emission does not support
      // the native Ray Query extension. No source or descriptor is substituted.
      const parsed = await parse(sources[stage]);
      if (!parsed.ok) throw new Error(`${stage}: ${parsed.error.message}`);
      const checked = await validate(parsed.value);
      if (!checked.ok) {
        parsed.value.free();
        throw new Error(`${stage}: ${checked.error.message}`);
      }
      try {
        const reflected = await emit_reflection(checked.value, '{}');
        if (!reflected.ok) throw new Error(`${stage}: ${reflected.error.message}`);
        const wire = parseReflectionWire(reflected.value);
        expect(wire.entryPoints?.map((entry) => entry.name)).toEqual([stage]);
        const storage = wire.boundGlobals.filter(
          (entry) => entry.resourceKind === 'storage-buffer',
        );
        const roster = irradianceFieldKernelBindings(traversal, stage);
        expect(storage.length, stage).toBe(
          roster.filter(([, kind]) => kind === 'read' || kind === 'storage').length,
        );
        expect(storage.length, stage).toBeLessThanOrEqual(8);
        expect(
          wire.boundGlobals.map((entry) => entry.binding).sort((a, b) => a - b),
          stage,
        ).toEqual(roster.map(([binding]) => binding).sort((a, b) => a - b));
        expect(sources[stage]).not.toContain('sampleIrradianceField');
      } finally {
        checked.value.free();
      }
    }
  }, 120000);
}
