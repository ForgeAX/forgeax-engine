// multi-uv-pbr-compose-regression.unit.test.ts
// feat-20260629-multi-uv-set-support — implement-review round 1 F-3 + F-7.
// The built-in PBR reserves UV0-UV7 and uses each material slot's texCoord
// selector to sample the corresponding glTF texture coordinate set.
//
// Regression guard for two distinct concerns, running on the SAME composer the
// vite-plugin-shader build path wraps (compileShader -> naga_oil compose ->
// naga validate). The dawn e2e tests use test-local WGSL and so bypass the
// built-in PBR composer entirely; this test is the missing vite-compose-path
// probe the dawn smokes cannot provide.
//
// What it pins:
//   F-3: default-standard-pbr.wgsl + default-standard-pbr-skin.wgsl compose and
//        validate. The original M5 fragment multiplied albedo (vec3) by in.uv1
//        (vec2) -- a WGSL type error naga surfaced as the opaque "Entry point
//        fs_main at Fragment is invalid". If that (or any other validation-
//        breaking edit) returns, compileShader fails here.
//   Built-in multi-UV: standard-PBR + skin reserve all eight supported sets.
//        Missing mesh sets remain byte-stable through clamp-to-last aliases. A
//        custom 2-UV-set fixture below still pins the opt-in reflection path.

import { compileShader, generateParameterModule } from '../src/index.js';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../../shader/src/material-schemas.js';
import { derive } from '@forgeax/engine-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GENERATED_STANDARD_INTERFACE = generateParameterModule(DEFAULT_STANDARD_PBR_PARAM_SCHEMA, {
  includeResources: false,
});

function loadEngineImports(): Record<string, string> {
  const srcDir = join(import.meta.dirname, '..', '..', 'shader', 'src');
  const read = (name: string) => readFileSync(join(srcDir, name), 'utf8');
  return {
    'forgeax_material::displacement': read('standard-displacement.wgsl'),
    'forgeax_material::texture_coordinates': read('texture-coordinates.wgsl'),
    'forgeax_material::terrain_vertex': read('terrain-vertex.wgsl'),
    'forgeax_material::terrain_layer_sampling': read('terrain-layer-sampling.wgsl'),
    'forgeax_material::terrain_surface': read('terrain-surface.wgsl'),
    'forgeax_material::surface_v1': read('surface_v1.wgsl'),
    'forgeax_material::surface_sampling': read('surface-sampling.wgsl'),
    'forgeax_material::default_standard_surface': read('default_standard_surface.wgsl'),
    'forgeax_material::slot::surface': read('default_standard_surface.wgsl').replace(
      /^\s*#define_import_path\s+[^\n]+/m,
      '#define_import_path forgeax_material::slot::surface',
    ),
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
    'forgeax_pbr::brdf': read('brdf.wgsl'),
    'forgeax_pbr::specular_aa': read('specular-aa.wgsl'),
    'forgeax_material::fragment_output': read('material/fragment-output.wgsl'),
    'forgeax_view::tone_mapping': read('tone-mapping.wgsl'),
    'forgeax_view::output_encoding': read('output-encoding.wgsl'),
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
    'forgeax_standard::cluster': read('standard-cluster.wgsl'),
    'forgeax_pbr::shadow_pcf': read('shadow-pcf.wgsl'),
    'forgeax_pbr::clearcoat': read('material/physical/clearcoat.wgsl'),
    'forgeax_pbr::anisotropy': read('material/physical/anisotropy.wgsl'),
    'forgeax_pbr::sheen': read('material/physical/sheen.wgsl'),
    'forgeax_pbr::iridescence': read('material/physical/iridescence.wgsl'),
  };
}

const engineImports = loadEngineImports();

async function composePbr(file: string, defines: Record<string, boolean> = {}) {
  const srcPath = join(import.meta.dirname, '..', '..', 'shader', 'src', file);
  // Keep the Surface slot directive so compileShader exercises the same
  // lexical lowering path as the Vite manifest producer. Variant directives
  // are still omitted because this regression covers the canonical base
  // composition only.
  const source = readFileSync(srcPath, 'utf8').replace(/^\s*#pragma\s+(?!material_slot\b).*$/gm, '');
  return compileShader(source, {
    id: srcPath,
    imports: engineImports,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      POINT_SHADOW_AVAILABLE: true,
      PER_INSTANCE_REGION: false,
      CLUSTER_FORWARD_AVAILABLE: false,
      TRANSMISSION_AVAILABLE: false,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      TERRAIN_GEOMETRY_AVAILABLE: false,
      ...defines,
    },
    ...(defines.VISIBLE_SURFACE_AVAILABLE ? { renderEntries: {
      vertex: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE ? 'vs_scene_index' : 'vs_main',
      fragment: 'fs_gbuffer',
      colorFormats: ['rgba16float', 'r32uint', 'r32uint', 'r32uint', 'r32uint', 'r32uint', 'rgba32uint', 'rgba16float'],
    } } : {}),
    generatedParameters: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE
      ? generateParameterModule(DEFAULT_STANDARD_PBR_PARAM_SCHEMA, {
          includeResources: false, sceneIndex: true, sceneIndexDeclarations: false, sceneMaterialPrivate: true,
          // Language/entry validation of the full authoring schema. Runtime
          // row admission remains the production compiler's separate gate.
          sceneRowStride: derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA).totalBytes,
        })
      : GENERATED_STANDARD_INTERFACE,
  });
}

// A minimal custom material shader that declares a SECOND UV set the way the
// hello-multi-uv demo shader does (@location(6) uv1). Pins that naga reflection
// still derives uvSetCount=2 for shaders that opt INTO multi-UV -- the data
// layer the demo relies on is untouched by the built-in PBR single-UV revert.
const CUSTOM_TWO_UV_WGSL = `
struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  @location(6) uv1 : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) uv1 : vec2<f32>,
};
@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clip = vec4<f32>(in.pos, 1.0);
  out.uv = in.uv;
  out.uv1 = in.uv1;
  return out;
}
@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.uv1, 0.5, 1.0);
}
`;

describe('built-in standard-PBR single-UV + multi-UV pathway regression (F-3 + F-7)', () => {
  it('default-standard-pbr.wgsl composes + validates (F-3: no fs_main type error)', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.error.message}`).toBe(true);
  });

  it('primitive extension preserves an imported type namespace', async () => {
    const r = await compileShader(`enable primitive_index;
#import test::types::{Value}
@fragment fn fs_main(@builtin(primitive_index) primitive: u32) -> @location(0) u32 {
  let v = Value(primitive);
  return v.index;
}`, { imports: { 'test::types': '#define_import_path test::types\nstruct Value { index: u32, };' } });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (r.ok) expect(r.value.wgsl).toContain('enable primitive_index;');
  });

  it.each([
    { sceneIndex: false, transmission: false },
    { sceneIndex: true, transmission: false },
    { sceneIndex: false, transmission: true },
    { sceneIndex: true, transmission: true },
  ])('visible raster surface composes with $sceneIndex/$transmission', async ({ sceneIndex, transmission }) => {
    const r = await composePbr('default-standard-pbr.wgsl', {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
      TRANSMISSION_AVAILABLE: transmission,
    });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
  });

  it('default-standard-pbr-skin.wgsl composes + validates (F-3)', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.error.message}`).toBe(true);
  });

  it('built-in PBR reflects all eight supported UV sets for per-slot texCoord', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The built-in PBR reserves every supported set so each texture slot can
    // select its glTF texCoord. Single-UV meshes stay byte-identical through
    // clamp-to-last aliases.
    expect(r.value.uvSetCount).toBe(8);
  });

  it('built-in PBR skin reflects all eight supported UV sets', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(8);
  });

  it('a custom shader declaring @location(6) uv1 still reflects uvSetCount=2 (multi-UV pathway preserved)', async () => {
    const r = await compileShader(CUSTOM_TWO_UV_WGSL, {
      id: 'test://custom-two-uv',
      imports: {},
      defines: {},
    });
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(2);
  });

  it('built-in PBR fragment resolves each texture through the material UV transform (feat-city-glb Bug 4 multi-UV)', async () => {
    // feat-city-glb Bug 4: the fragment now picks its UV set per-material via
    // `selectUv(in)` = select(in.uv, in.uv1, material.coordinatesSet >= 0.5). It samples
    // `uv` (the selected set), not `in.uv` directly, so texCoord=1 materials get
    // UV set 1. Single-UV content is byte-identical (selector defaults to 0 and
    // clamp-to-last aliases uv1 onto uv0). This replaces the pre-revert
    // single-UV-only assertion.
    const srcPath = join(
      import.meta.dirname,
      '..',
      '..',
      'shader',
      'src',
      'default-standard-pbr.wgsl',
    );
    const source = readFileSync(srcPath, 'utf8');
    // fs_main and the OIT accumulation entries share the forward body.
    expect(source).toMatch(/fn fs_main\([^)]*\)[^{]*\{\s*return standardForward\(in, frontFacing\);/);
    const fragmentStart = source.indexOf('fn standardForward');
    const fragmentEnd = source.indexOf('fn fs_gbuffer');
    expect(fragmentStart).toBeGreaterThan(0);
    expect(fragmentEnd).toBeGreaterThan(fragmentStart);
    const fragmentBody = source.slice(fragmentStart, fragmentEnd);
    const defaultSurface = readFileSync(
      join(import.meta.dirname, '..', '..', 'shader', 'src', 'default_standard_surface.wgsl'),
      'utf8',
    );
    // The authored material now carries one UV transform per texture slot;
    // the composed shader resolves each slot through that shared helper.
    expect(fragmentBody).toMatch(/evaluateStandardSurface\s*\(\s*in\s*,\s*frontFacing\s*,\s*geometricNormal\s*\)/);
    expect(defaultSurface).toMatch(
      /surfaceSample\s*\(\s*baseColorTexture\s*,[^;]*materialValue\.baseColorTextureCoordinatesTransform/,
    );
    expect(defaultSurface).toMatch(
      /let transform = materialValue\.normalTextureCoordinatesTransform;.*?surfaceUv\s*\(\s*input\s*,\s*transform/s,
    );
  });
});
