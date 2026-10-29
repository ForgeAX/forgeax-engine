// pbr-skin-compose.unit.test.ts — feat-20260523-skin-skeleton-animation M3 / T-32.
//
// Tests that compileShader composes default-standard-pbr-skin.wgsl successfully
// through naga_oil (naga parse/validate passes). Verifies the composed output
// contains the skin-specific bindings and vertex inputs.
//
// Anchors:
//   - plan acceptanceCheck: compileShader not error
//   - plan acceptanceCheck: compose output contains palette: array<mat4x4<f32>>
//   - plan acceptanceCheck: compose output contains skinIndex/skinWeight @location
//   - AC-23 / AC-24 vertex input + palette binding verification
//   - plan-strategy D-3: independent WGSL template compose

import { compileShader, generateParameterModule } from '@forgeax/engine-shader-compiler';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../../shader/src/material-schemas.js';
import { beforeAll, describe, expect, it } from 'vitest';

// === Engine import map (mirrors vite-plugin-shader's loadEngineShaderEntries) =====
//
// Each #import directive in default-standard-pbr-skin.wgsl resolves to a
// sibling .wgsl file in packages/shader/src/. The import map keys are the
// #define_import_path values declared in the target files.
//
// Building the import map by reading files from the source directory avoids
// a hard resolve-path dependency on @forgeax/engine-shader/package.json;
// the test runs under vitest where the working directory is the shader
// package root, and the src/ files are accessible via relative paths.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GENERATED_STANDARD_INTERFACE = generateParameterModule(DEFAULT_STANDARD_PBR_PARAM_SCHEMA, {
  includeResources: false,
});

function loadEngineImports(): Record<string, string> {
  const srcDir = join(import.meta.dirname, '..', '..', 'shader', 'src');
  const read = (name: string) => readFileSync(join(srcDir, name), 'utf8');

  return {
    'forgeax_material::displacement': read('standard-displacement.wgsl'),
    'forgeax_material::texture_coordinates': read('texture-coordinates.wgsl'),
    'forgeax_clipping::planes': read('clipping.wgsl'),
    'forgeax_view::common': read('common.wgsl'),
    forgeax_scene_temporal: read('scene-temporal.wgsl'),
    'forgeax_view::fog': read('fog.wgsl'),
    'forgeax_view::atmosphere': read('view-atmosphere.wgsl'),
    'forgeax_atmosphere::optics': read('atmosphere-optics.wgsl'),
    'forgeax_atmosphere::visibility': read('atmosphere-visibility.wgsl'),
    'forgeax_atmosphere::coordinates': read('atmosphere-coordinates.wgsl'),
    'forgeax_atmosphere::sampling': read('atmosphere-sampling.wgsl'),
    'forgeax_cloud::layer': read('cloud.wgsl'),
    'forgeax_standard::cluster': read('standard-cluster.wgsl'),
    'forgeax_pbr::brdf': read('brdf.wgsl'),
    'forgeax_pbr::specular_aa': read('specular-aa.wgsl'),
    'forgeax_material::alpha_hash': read('alpha-hash.wgsl'),
    'forgeax_material::oit': read('oit.wgsl'),
    'forgeax_pbr::temporal': read('pbr-temporal.wgsl'),
    'forgeax_pbr::ibl_shared': read('ibl-shared.wgsl'),
    'forgeax_pbr::ibl_sampling': read('ibl-sampling.wgsl'),
    'forgeax_pbr::pmrem': read('ibl-pmrem.wgsl'),
    'forgeax_pbr::tbn': read('tbn.wgsl'),
    'forgeax_pbr::lighting_directional': read('lighting-directional.wgsl'),
    'forgeax_pbr::lighting_punctual': read('lighting-punctual.wgsl'),
    'forgeax_pbr::lighting_probe': read('lighting-probe.wgsl'),
    'forgeax_pbr::standard_lighting': read('standard-lighting.wgsl'),
    'forgeax_pbr::gbuffer': read('standard-gbuffer.wgsl'),
    'forgeax_pbr::gbuffer_output': read('standard-gbuffer-output.wgsl'),
    'forgeax_pbr::lighting_spot_modifiers': read('lighting-spot-modifiers.wgsl'),
    'forgeax_pbr::lighting_ies_profile': read('lighting-ies-profile.wgsl'),
    'forgeax_pbr::lighting_rect_area': read('lighting-rect-area.wgsl'),
    'forgeax_pbr::lighting_attenuation': read('lighting-attenuation.wgsl'),
    'forgeax_pbr::lighting_spot_projector': read('lighting-spot-projector.wgsl'),
    // feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1:
    // lighting-directional.wgsl now imports forgeax_pbr::shadow_pcf (shared PCF core).
    'forgeax_pbr::shadow_pcf': read('shadow-pcf.wgsl'),
    'forgeax_skin::task': read('skin-task.wgsl'),
    'forgeax_pbr::clearcoat': read('material/physical/clearcoat.wgsl'),
    'forgeax_pbr::anisotropy': read('material/physical/anisotropy.wgsl'),
    'forgeax_pbr::sheen': read('material/physical/sheen.wgsl'),
    'forgeax_pbr::iridescence': read('material/physical/iridescence.wgsl'),
    'forgeax_material::surface_v1': read('surface_v1.wgsl'),
    'forgeax_material::surface_sampling': read('surface-sampling.wgsl'),
    'forgeax_material::default_standard_surface': read('default_standard_surface.wgsl'),
    'forgeax_material::slot::surface': read('default_standard_surface.wgsl').replace(
      /^\s*#define_import_path\s+[^\n]+/m,
      '#define_import_path forgeax_material::slot::surface',
    ),
  };
}

const engineImports = loadEngineImports();

describe('T-32 — default-standard-pbr-skin.wgsl compose test', () => {
  let composedWgsl: string;

  beforeAll(async () => {
    const srcPath = join(import.meta.dirname, '..', '..', 'shader', 'src', 'default-standard-pbr-skin.wgsl');
    let source = readFileSync(srcPath, 'utf8');
    source = source.replace(/^\s*#pragma\s+(?!material_slot\b).*$/gm, '');
    const r = await compileShader(source, {
      id: srcPath,
      imports: engineImports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        PER_INSTANCE_REGION: false,
        CLUSTER_FORWARD_AVAILABLE: false,
        TRANSMISSION_AVAILABLE: false,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      },
      generatedParameters: GENERATED_STANDARD_INTERFACE,
    });
    if (!r.ok) {
      throw new Error(`compileShader failed: ${r.error.message}\nhint: ${r.error.hint}`);
    }
    composedWgsl = r.value.manifestEntry.wgsl;
  });

  it('compileShader succeeds (naga parse/validate passes)', () => {
    // If beforeAll completed without throwing, compose succeeded.
    expect(composedWgsl.length).toBeGreaterThan(0);
  });

  it('composed output contains the Skin task binding declaration', () => {
    // The storage variant reads transient Skin task output at @group(2)
    // @binding(1) and its per-draw task address at @binding(2). naga_oil may
    // prefix member names; check the declarations and binding annotations.
    expect(composedWgsl).toMatch(/skinTaskOutput/);
    expect(composedWgsl).toMatch(/binding\(1\)/);
    expect(composedWgsl).toMatch(/array<vec4<u32>>/);
    expect(composedWgsl).toMatch(/skinTaskAddress/);
  });

  it('composed output contains skinIndex vertex input @location(4)', () => {
    // skinIndex at @location(4) — may be renamed by naga_oil writeback
    expect(composedWgsl).toMatch(/skinIndex/);
    expect(composedWgsl).toMatch(/location\(4\)/);
  });

  it('composed output contains skinWeight vertex input @location(5)', () => {
    // skinWeight at @location(5) -- float32x4 per vertex-attribute-layout.ts
    expect(composedWgsl).toMatch(/@location\(5\)\s*\w*\s*skinWeight\s*:\s*vec4<f32>/);
  });

  it('composed output contains meshes binding (existing @group(2)@binding(0))', () => {
    // The meshes binding should be preserved from common.wgsl at @group(2)@binding(0)
    expect(composedWgsl).toMatch(/@group\(2\)\s*@binding\(0\)/);
  });

  it('composed output contains a vertex entry point vs_main', () => {
    expect(composedWgsl).toMatch(/fn\s+vs_main\s*\(/);
  });

  it('composed output contains a fragment entry point fs_main', () => {
    expect(composedWgsl).toMatch(/fn\s+fs_main\s*\(/);
  });
});
