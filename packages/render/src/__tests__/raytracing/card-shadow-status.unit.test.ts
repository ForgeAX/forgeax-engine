import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { frozenCardStatusQuery } from './card-shadow-status.fixture';

it('validates the controlled receiver and witnessed frozen World status consumer ABI', async () => {
  const source = frozenCardStatusQuery(irradianceFieldKernelWgsl('global-sdf').cardSurface);
  const result = await compileShader(source, { id: 'card-shadow-status-controlled-input' });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
});
