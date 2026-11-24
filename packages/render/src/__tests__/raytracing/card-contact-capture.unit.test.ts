import { writeFileSync } from 'node:fs';
import { assert, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { prepareCardContactCapture } from './card-contact-capture.fixture';
import { observedCardContact } from './card-contact-capture-gpu.fixture';

it('prepares the actual authored same-Mesh capture and a preregistered physical bias counterexample', async () => {
  const fixture = await prepareCardContactCapture();
  expect(fixture.source.instance.indices).toEqual(Uint32Array.from([0, 1, 2, 3, 4, 5]));
  const instance = fixture.instances[0];
  assert(instance && !('missing' in instance.field));
  expect(instance.field.surface?.indices).toEqual(fixture.source.instance.indices);
  expect(fixture.scene.sourceExpected).toBeDefined();
  expect(fixture.source.sections[0]?.material.program.source).toContain('fs_card_identity');
  expect(fixture.expectedViewProjection.byteLength).toBe(64);
  expect(fixture.expectedDepth).toBe(45 / 128);
  expect(fixture.physicalMasks).toEqual([0, 0, 0, 1]);
  if (process.env.FORGEAX_CARD_CONTACT_PREPARED)
    writeFileSync(
      process.env.FORGEAX_CARD_CONTACT_PREPARED,
      JSON.stringify(
        {
          pixel: fixture.pixel,
          card: fixture.card,
          resolution: fixture.resolution,
          point: fixture.point,
          exact: fixture.exact.map((v) => ({ n: String(v.n), d: String(v.d) })),
          expectedViewProjection: Array.from(
            new Float32Array(fixture.expectedViewProjection.buffer),
          ),
          expectedDepth: fixture.expectedDepth,
          sourceExpected: fixture.scene.sourceExpected,
          physicalMasks: fixture.physicalMasks,
          primitiveCount: 2,
          meshDigest: instance.field.meshDigest,
          scope:
            'CPU authored fixture preparation only; actual Capture VP/ID and full World GPU are not yet qualified.',
        },
        null,
        2,
      ),
    );
}, 60000);

it('validates the full production World observer without replacing its query result', async () => {
  const source = observedCardContact(irradianceFieldKernelWgsl('global-sdf').cardSurface);
  const result = await compileShader(source, { id: 'card-capture-physical-observer' });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
});
