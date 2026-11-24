import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { frozenCardStatusQuery } from './card-shadow-status.fixture';

it('compiles the production Card material projection with the controlled visibility boundary', async () => {
  const result = await compileShader(
    frozenCardStatusQuery(irradianceFieldKernelWgsl('global-sdf').cardSurface),
    { id: 'card-fully-rough-production-projection' },
  );
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
});
