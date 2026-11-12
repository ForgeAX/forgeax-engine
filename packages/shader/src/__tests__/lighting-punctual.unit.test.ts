import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderPath = join(dirname(fileURLToPath(import.meta.url)), '../lighting-punctual.wgsl');
const standardClusterShaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../standard-cluster.wgsl',
);
const spotProjectorShaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../lighting-spot-projector.wgsl',
);
const pbrShaderPath = join(dirname(fileURLToPath(import.meta.url)), '../default-standard-pbr.wgsl');
const brdfShaderPath = join(dirname(fileURLToPath(import.meta.url)), '../brdf.wgsl');
const directionalShaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../lighting-directional.wgsl',
);

describe('direct punctual lighting shader contract', () => {
  it('exposes independent point and spot paths with explicit range and cone inputs', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).toContain('fn evalPoint(');
    expect(source).toContain('fn evalSpot(');
    expect(source).toContain('fn evalPointFlat(');
    expect(source).toContain('fn evalSpotFlat(');
    expect(source).toContain('invRangeSquared');
    expect(source).toContain('cosInner');
    expect(source).toContain('cosOuter');
    expect(source).toContain('evalSpotCone(cosInner, cosOuter, dot(l, -lightDir))');
  });

  it('does not introduce a separate physical-light component or intensity profile', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).not.toContain('PhysicalLight');
    expect(source).not.toMatch(/intensityMultiplier|magicMultiplier|profile/);
  });

  it('keeps point-shadow cube direction and bias arguments in the shared convention', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).toContain('let lightLocal = fromLight;');
    expect(source).not.toContain('vec3<f32>(fromLight.x, fromLight.y, -fromLight.z)');
    expect(source).toContain('let fromLight = offsetPos - shadowPosition;');
  });

  it('leaves spot direction normalization to extract instead of HDRP', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).toContain('lightDir');
    expect(source).not.toContain('normalize(lightDir)');
  });

  it('biases the point receiver in world space before hyperbolic depth reconstruction', async () => {
    const [source, pcf] = await Promise.all([
      readFile(shaderPath, 'utf8'),
      readFile(join(dirname(shaderPath), 'shadow-pcf.wgsl'), 'utf8'),
    ]);
    const cube = pcf.slice(pcf.indexOf('fn sample_shadow_cube_hw2x2('));
    expect(cube.slice(0, cube.indexOf('}'))).not.toContain('shadow_biased_receiver_depth');
    expect(source).toContain('largest - select(depthBias, 0.0, constantBias), near);');
    expect(source).toContain('facing * (normalBias * distanceToLight)');
  });

  it('shares default Surface evaluation between CPU, GPU-driven and skinned Standard', async () => {
    for (const name of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
      const source = await readFile(join(dirname(shaderPath), name), 'utf8');
      expect(source).toContain('slot::surface::{evaluate_surface, evaluate_standard_surface}');
      expect(source).not.toContain('fn evaluateSelectedStandardSurface');
    }
    const source = await readFile(
      join(dirname(shaderPath), 'default_standard_surface.wgsl'),
      'utf8',
    );
    expect(source).toContain('return evaluate_standard_surface(input, material);');
  });

  it('shares direct-PBR Fresnel and multiscatter ownership across DFG providers', async () => {
    const [source, brdf, directional] = await Promise.all([
      readFile(shaderPath, 'utf8'),
      readFile(brdfShaderPath, 'utf8'),
      readFile(directionalShaderPath, 'utf8'),
    ]);

    expect(brdf).toContain('exp2((-5.55473 * vDotH - 6.98316) * vDotH)');
    expect(brdf).toContain('fn directMultiScatter(');
    expect(brdf).toContain('energyLoss * favg * favg + vec3<f32>(1e-6)');
    expect(brdf).not.toContain('energyLoss * favg + vec3<f32>(1e-6)');
    expect(source).toContain(
      'standardOpaqueBrdfFromView(baseColor, metallic, directAlpha, F0, ms, nDotL, nDotH, vDotH,',
    );
    expect(brdf).toContain('directMultiScatter(sqrt(max(alpha, 0.0)), nDotV, nDotL, f0,');
    expect(brdf).toContain('return (1.0 - metallic) * baseColor / 3.14159265 + specular;');
    expect(source).toContain('evalDistanceAttenuation(dSquared, invRangeSquared, decay, 1e-4)');
    expect(source).not.toContain('let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);');
    expect(directional).toContain(
      'standardOpaqueBrdfEnergy(baseColor, metallic, directAlpha, F0, nDotV, nDotL, nDotH, vDotH, dEnergy,',
    );
    expect(directional).not.toContain('THREE_R184_DFG_LUT');
  });

  it('keeps cluster punctual evaluation in the shared lighting owner', async () => {
    const source = await readFile(standardClusterShaderPath, 'utf8');

    expect(source).toContain('DirectLightSlot');
    expect(source).toContain('light.metadata.x');
    expect(source).toContain('evalPoint');
    expect(source).toContain('evalSpot');
    expect(source).toContain('evalSpotShadowed');
    expect(source).not.toContain('fn evaluate_point_light(');
    expect(source).not.toContain('fn evaluate_spot_light(');
    expect(source).not.toMatch(/kind\s*==\s*KIND_POINT[\s\S]{0,80}else\s*\{/);
  });

  it('decodes HDRP spot cone lanes in the shared evaluator order', async () => {
    const source = await readFile(standardClusterShaderPath, 'utf8');

    expect(source).toContain('light.colorTimesIntensity.w, light.direction.w, light.position.w');
    expect(source).not.toContain('light.direction.w, light.color.w, light.position.w');
  });

  it('keeps the unshadowed spot sentinel out of the projector flag branch', async () => {
    const [source, projector] = await Promise.all([
      readFile(standardClusterShaderPath, 'utf8'),
      readFile(spotProjectorShaderPath, 'utf8'),
    ]);

    expect(source).toContain('if (encoded_tile >= 0 && (encoded_tile & PROJECTOR_FLAG) != 0)');
    expect(source).toContain(
      'sampleStandardSpotProjector(view.spotLightViewProj[tile], world_pos, light.metadata)',
    );
    expect(projector).toContain(
      'textureSampleLevel(cookieTexture, spotModifierSampler, uv, metadata.w, 0.0).rgb',
    );
  });

  it('passes precomputed base and clearcoat roughness/F0 facts to cluster lights', async () => {
    const source = await readFile(pbrShaderPath, 'utf8');

    expect(source).toContain(
      'physicalNormal, v, diffuseAlbedo, transmissionAlbedo, metallic, a, f0, directionalShadow',
    );
    const shared = await readFile(new URL('../standard-lighting.wgsl', import.meta.url), 'utf8');
    expect(shared).toMatch(
      /evaluateStandardClusterLights\(ndc, pixel, viewZ, worldPosition, normal, direction,\s*albedo, metallic, alpha, f0, transmission, false, receiveShadows, receiverChannels,\s*useDirectDfgLut,/u,
    );
    expect(source).toContain('clearcoatAlpha,');
    expect(source).toContain('vec3<f32>(0.04),');
  });

  it('requires one shared Directional PCSS orchestration owner', async () => {
    const source = await readFile(directionalShaderPath, 'utf8');

    expect(source).toContain('PCSS_MEDIUM_RAW_TAPS');
    expect(source).toContain('PCSS_MEDIUM_COMPARE_TAPS');
    expect(source).toContain('PCSS_HIGH_RAW_TAPS');
    expect(source).toContain('PCSS_HIGH_COMPARE_TAPS');
    expect(source).toContain('fn _samplePcssForCascade');
    expect(source).toContain('if (blockerCount == 0u)');
    expect(source).toContain('shadow_load_raw_depth');
    expect(source).toContain('shadow_sample_compare');
    expect(source).not.toMatch(/frameIndex|frame_index|taaJitter|taa_jitter|jitter/);
  });
  it('threads one diffuse-transmission lobe through direct, shadow and environment paths', async () => {
    const punctual = await readFile(shaderPath, 'utf8');
    const directional = await readFile(directionalShaderPath, 'utf8');
    const shared = await readFile(new URL('../standard-lighting.wgsl', import.meta.url), 'utf8');
    const pbr = await readFile(pbrShaderPath, 'utf8');

    for (const source of [punctual, directional]) {
      expect(source).toContain('transmission * (max(-signedNDotL, 0.0) / 3.14159265)');
    }
    // Back-lit receivers still need a finite shadow bias on the far hemisphere:
    // Point and Spot offset the receiver toward its lit hemisphere.
    expect(punctual).toContain(
      'let receiver = worldPos + select(facing, normal, shadowControls.y > 0.5) * normalBias;',
    );
    expect(punctual).toContain('select(-normal, normal, dot(normal, toLight) >= 0.0)');
    expect(shared).toContain('if (any(transmission > vec3<f32>(0.0)))');
    expect(shared).toContain(
      'sampleIblDiffuse(-normal, rotation, irradianceMap, irradianceSampler)',
    );
    expect(pbr).toContain('#ifdef DIFFUSE_TRANSMISSION_AVAILABLE');
    expect(pbr).toContain('diffuseAlbedo = diffuseAlbedo * (1.0 - diffuseTransmissionFactor);');
    expect(pbr).toMatch(/directionalShadowNormal = select\(receiverNormal, -receiverNormal,/);
  });
});

describe('exact-zero light reach gates', () => {
  it('derives the range gate from the attenuation window and the cone gate from evalSpotCone', async () => {
    const [source, attenuation] = await Promise.all([
      readFile(shaderPath, 'utf8'),
      readFile(join(dirname(shaderPath), 'lighting-attenuation.wgsl'), 'utf8'),
    ]);
    // The gate must use the same floored distance as the window it predicts.
    expect(attenuation).toContain(
      'let window = clamp(1.0 - (safeDistance * invRangeSquared) * (safeDistance * invRangeSquared), 0.0, 1.0);',
    );
    const range = source.slice(source.indexOf('fn punctualRangeReaches('));
    const rangeBody = range.slice(0, range.indexOf('\n}'));
    expect(rangeBody).toContain('let dSquared = max(dot(toLight, toLight), 1e-4);');
    // NaN-preserving: a NaN product still reaches the evaluator.
    expect(rangeBody).toContain('return !(dSquared * invRangeSquared >= 1.0);');
    const cone = source.slice(source.indexOf('fn spotConeReaches('));
    const coneBody = cone.slice(0, cone.indexOf('\n}'));
    expect(coneBody).toContain('normalize(lightPos - worldPos)');
    expect(coneBody).toContain('!(evalSpotCone(cosInner, cosOuter, dot(l, -lightDir)) == 0.0)');
  });

  it('skips shadow taps only when the unshadowed body is exactly zero', async () => {
    const source = await readFile(shaderPath, 'utf8');
    const point = source.slice(source.indexOf('fn evalPointShadowed('));
    expect(point.indexOf('if (all(lit == vec3<f32>(0.0))) { return lit; }')).toBeGreaterThan(0);
    expect(point.indexOf('if (all(lit == vec3<f32>(0.0))) { return lit; }')).toBeLessThan(
      point.indexOf('sample_shadow_cube_vogel('),
    );
    const spot = source.slice(source.indexOf('fn evalSpotShadowed('));
    expect(spot.indexOf('if (all(body == vec3<f32>(0.0))) { return body; }')).toBeGreaterThan(0);
    expect(spot.indexOf('if (all(body == vec3<f32>(0.0))) { return body; }')).toBeLessThan(
      spot.indexOf('sample_shadow_2d_punctual('),
    );
  });

  it.each([
    'standard-cluster.wgsl',
    'hdrp-cluster-forward.wgsl',
  ])('gates point and spot members in %s before any per-light shading', async (name) => {
    const source = await readFile(join(dirname(shaderPath), name), 'utf8');
    const body = source.slice(source.indexOf('fn evaluate_cluster_light('));
    const rangeGate = body.indexOf(
      '!punctualRangeReaches(light.position.xyz, world_pos, light.position.w)',
    );
    expect(rangeGate).toBeGreaterThan(0);
    expect(rangeGate).toBeLessThan(body.indexOf('if (kind == KIND_POINT) {'));
    const spot = body.slice(body.indexOf('if (kind == KIND_SPOT) {'));
    expect(spot.indexOf('!spotConeReaches(')).toBeGreaterThan(0);
    expect(spot.indexOf('!spotConeReaches(')).toBeLessThan(spot.indexOf('evalSpotShadowed('));
  });

  it('looks the standard cluster cell up from the fragment screen position', async () => {
    const source = await readFile(standardClusterShaderPath, 'utf8');
    const body = source.slice(source.indexOf('fn evaluateStandardClusterLights('));
    // The screen-linear NDC comes from @builtin(position) and the View
    // viewport, not the interpolated NDC varying or a per-pixel reprojection.
    const screen = body.indexOf('pixel / vec2<f32>(view.viewportWidth, view.viewportHeight)');
    expect(screen).toBeGreaterThan(0);
    expect(body).not.toContain('view.worldViewProj * vec4<f32>(world_pos, 1.0)');
    expect(body).toContain('ndc_position_to_cluster(fragment_ndc,');
    expect(screen).toBeLessThan(body.indexOf('ndc_position_to_cluster(fragment_ndc,'));
  });
});
