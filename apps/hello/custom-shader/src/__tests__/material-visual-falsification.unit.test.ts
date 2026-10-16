import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FALSIFICATION_VARIANTS,
  assertFalsificationFailed,
  falsificationEnvironment,
} from '../../scripts/smoke-falsify.mjs';

describe('custom-shader visual falsification contract', () => {
  it('projects real browser readback into the terminal receipt', () => {
    const smoke = readFileSync(new URL('../../scripts/smoke-browser.mjs', import.meta.url), 'utf8');
    expect(smoke).toContain('frames: evidence.frameCount');
    expect(smoke).toContain('readback: evidence.renderDiagnostics.readback');
    expect(smoke).toContain('pixel: evidence.renderDiagnostics.readback.pixel');
    expect(smoke).toContain('format');
    expect(smoke).toContain('coordinate');
    expect(smoke).not.toContain('sample: evidence.renderDiagnostics.readback.sample');
  });

  it('requires semantic browser receipts to prove the selected publication GUID', () => {
    const semantic = readFileSync(new URL('../../scripts/smoke-material-semantics.mjs', import.meta.url), 'utf8');
    expect(semantic).toContain('019f0000-0000-7000-8000-000000000201');
    expect(semantic).toContain('FORGEAX_CUSTOM_SHADER_EXPECTED_GUID');
    expect(semantic).toContain('materialIdentity?.materialGuid');
    expect(semantic).toContain('PULSE_MATERIAL_GUID');
  });

  it('requires semantic publications to expose the canonical Forward pass', async () => {
    const semantic = readFileSync(new URL('../../scripts/smoke-material-semantics.mjs', import.meta.url), 'utf8');
    expect(semantic).toContain("renderState: { queue: 2000, tags: { LightMode: 'Forward' } }");
    const selectorModuleUrl = new URL(
      '../../../../../packages/render/src/systems/pass-selector.ts',
      import.meta.url,
    ).href;
    const { selectPasses } = await import(selectorModuleUrl);
    const pass = {
      name: 'Forward',
      program: { module: 'semantic::root' },
      renderState: { queue: 2000, tags: { LightMode: 'Forward' } },
    } as const;
    expect(selectPasses([pass], { LightMode: ['Forward'] })).toHaveLength(1);
    expect(selectPasses([{ ...pass, renderState: { queue: 2000, tags: {} } }], { LightMode: ['Forward'] })).toHaveLength(0);
  });

  it('keeps semantic carriers on one mesh-compatible artifact and one runtime bool row', () => {
    const semantic = readFileSync(new URL('../../scripts/smoke-material-semantics.mjs', import.meta.url), 'utf8');
    const browser = readFileSync(new URL('../../scripts/smoke-browser.mjs', import.meta.url), 'utf8');
    expect(semantic).not.toContain('function sourcesFor(');
    expect(semantic).toContain("const rootModule = 'semantic::root';");
    expect(semantic).toContain('runtimeMode ? [warm] : [warm, browserDerived]');
    expect(semantic).toContain("runtimeMode ? warm.guid : browserDerived.guid");
    expect(browser).toContain("perFramePassNames?.includes('Forward')");
    expect(browser).toContain('renderSceneRecordCount ?? 0');
  });

  it('rejects a background texel when a later format-aware texel is visible', () => {
    const app = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(app).toContain('decodeTexelRaw');
    expect(app).toContain('bytesPerTexel');
    expect(app).toContain('coordinate: [x, y]');
    expect(app).toContain('pixel[3] > 0');
    expect(app).toContain('pixel.slice(0, 3).some');
  });

  it('defines material inheritance and per-slot resource variants outside CI', () => {
    expect(Object.keys(FALSIFICATION_VARIANTS)).toEqual([
      'missing-derived-parent',
      'uv0-transform-loss',
      'missing-normal-resource',
      'swapped-normal-binding',
      'normal-slot-swap',
    ]);
    expect(falsificationEnvironment('missing-derived-parent')).toEqual({
      FORGEAX_FALSIFY_MISSING_PARENT: '1',
    });
    expect(falsificationEnvironment('uv0-transform-loss')).toEqual({
      FORGEAX_FALSIFY_UV0_TRANSFORM: '1',
    });
    expect(falsificationEnvironment('missing-normal-resource')).toEqual({
      FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE: '1',
    });
    expect(falsificationEnvironment('swapped-normal-binding')).toEqual({
      FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING: '1',
    });
    expect(falsificationEnvironment('normal-slot-swap')).toEqual({
      FORGEAX_FALSIFY_NORMAL_SLOT_SWAP: '1',
    });
  });

  it('rejects a variant that passes the original smoke', () => {
    expect(() => assertFalsificationFailed({ variant: 'missing-derived-parent', exitCode: 0, output: '' })).toThrow(
      'passed the original smoke',
    );
    expect(() =>
      assertFalsificationFailed({
        variant: 'missing-derived-parent',
        exitCode: 1,
        output: 'FALSIFY_EXPECTED_FAILURE:missing-derived-parent',
      }),
    ).not.toThrow();
  });
});
