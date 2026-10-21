import { expect, it } from 'vitest';
import { cookStaticShadow, OPAQUE_SWITCHES } from './standard-static-shadow.fixture';

it('carries native per-entry reads for opaque, alpha and displaced shadow programs', async () => {
  const opaque = await cookStaticShadow();
  const fields = (program: typeof opaque.shadow) =>
    program.compile.reflection.entryPoints?.flatMap((entry) =>
      entry.bindings
        .filter((binding) => binding.group === 1 && binding.binding === 0)
        .flatMap((binding) => binding.fields ?? []),
    );
  expect(fields(opaque.shadow)).toBeDefined();
  expect(fields(opaque.shadow)).not.toContain('roughness');
  expect(fields(opaque.shadow)).toContain('clippingControl');
  expect(opaque.shadow.abi.entryPoints).toEqual(opaque.shadow.compile.reflection.entryPoints);
  const alpha = await cookStaticShadow({
    staticSwitches: { ...OPAQUE_SWITCHES, alphaClipping: true },
  });
  expect(fields(alpha.shadow)).toContain('alphaCutoff');
  const displaced = await cookStaticShadow({
    staticSwitches: { ...OPAQUE_SWITCHES, displacement: true },
  });
  expect(fields(displaced.shadow)).toContain('displacementScale');
  expect(fields(displaced.shadow)).toContain('displacementBias');
});
