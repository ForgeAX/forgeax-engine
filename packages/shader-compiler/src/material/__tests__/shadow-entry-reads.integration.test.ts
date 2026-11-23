import { expect, it } from 'vitest';
import {
  cookStaticShadow,
  cookStaticShadowCoverage,
  OPAQUE_SWITCHES,
} from './standard-static-shadow.fixture';

it('carries native per-entry reads for lighting, coverage and displaced shadow programs', async () => {
  const opaque = await cookStaticShadowCoverage();
  const fields = (program: typeof opaque) =>
    program.compile.reflection.entryPoints?.flatMap((entry) =>
      entry.bindings
        .filter((binding) => binding.group === 1 && binding.binding === 0)
        .flatMap((binding) => binding.fields ?? []),
    );
  expect(fields(opaque)).toBeDefined();
  expect(fields(opaque)).not.toContain('roughness');
  expect(fields(opaque)).toContain('clippingControl');
  expect(opaque.abi.entryPoints).toEqual(opaque.compile.reflection.entryPoints);
  const alpha = await cookStaticShadow({
    normalMapped: true,
    staticSwitches: { ...OPAQUE_SWITCHES, alphaClipping: true },
  });
  expect(fields(alpha.shadow)).toContain('alphaCutoff');
  const materialTextures = (program: typeof alpha.forward, entryName: string) => {
    const { boundGlobals, entryPoints } = program.compile.reflection;
    const entry = entryPoints?.find(({ name }) => name === entryName);
    expect(entry, entryName).toBeDefined();
    return boundGlobals
      .filter(
        (global) =>
          global.group === 1 &&
          global.textureClass === 'sampled' &&
          entry?.bindings.some(({ group, binding }) => group === 1 && binding === global.binding),
      )
      .map(({ name }) => name);
  };
  expect(materialTextures(alpha.forward, 'fs_main')).toContain('normalTexture');
  for (const entry of ['fs_depth_masked', 'fs_temporal', 'fs_scene_velocity']) {
    expect(materialTextures(alpha.forward, entry)).toEqual(['baseColorTexture']);
  }
  expect(materialTextures(alpha.shadow, 'fs_shadow')).toEqual(['baseColorTexture']);
  const displaced = await cookStaticShadowCoverage({
    staticSwitches: { ...OPAQUE_SWITCHES, displacement: true },
  });
  expect(fields(displaced)).toContain('displacementScale');
  expect(fields(displaced)).toContain('displacementBias');
});
