import { expect, it } from 'vitest';
import { cardParameterSource, cardParameterValues } from './custom-surface-card-parameters.fixture';
import { numericCardFixture } from './custom-surface-cards.fixture';

it('keeps zero-to-positive emissive scalar updates in one cooked Card program contract', async () => {
  const source = cardParameterSource();
  const initial = await numericCardFixture({ source, values: cardParameterValues[0] });
  const changed = await numericCardFixture({ source, values: cardParameterValues[2] });
  expect(initial.program.context).toBe('card-capture');
  expect(initial.program.paramSchema.some((parameter) => parameter.name === 'roughness')).toBe(
    true,
  );
  expect(
    initial.program.paramSchema.some((parameter) => parameter.name === 'emissiveIntensity'),
  ).toBe(true);
  expect(changed.program.wgsl).toBe(initial.program.wgsl);
  expect(changed.program.contract).toBe(initial.program.contract);
  expect(changed.program.sourceClosureDigest).toBe(initial.program.sourceClosureDigest);
}, 60_000);
