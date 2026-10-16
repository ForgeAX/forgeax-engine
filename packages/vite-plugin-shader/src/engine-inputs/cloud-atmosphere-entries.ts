import { CLOUD_RESOLVE_FULLSCREEN_WGSL, CLOUD_VIEW_FULLSCREEN_WGSL } from '@forgeax/engine-shader';
import type { EngineShaderFile } from './load-engine-shader-entries';

/** Build-time composition keeps cloud transport on the shared atmosphere kernel. */
export function cloudAtmosphereEntries(): readonly EngineShaderFile[] {
  const header = `#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{View, view}
#import forgeax_view::atmosphere::{view_solar_transmittance}
#import forgeax_view::fog::{view_fog}
`;
  const common = (source: string) =>
    source
      .replace(/struct CloudCameraView \{[\s\S]*?\};/, '')
      .replace('@group(0) @binding(0) var<uniform> view: CloudCameraView;', '');
  // Solar attenuation is sampled at each cloud integration point. Cloud's own
  // optical column already supplies its shadow, so do not multiply the projected
  // cloud-shadow map a second time through view_apply_direct_solar.
  const transport = common(CLOUD_VIEW_FULLSCREEN_WGSL)
    .replace(
      'fn cloud_incident_light(solarT: f32, cosTheta: f32, height: f32)',
      'fn cloud_incident_light(solarT: f32, cosTheta: f32, height: f32, position: vec3<f32>)',
    )
    .replace(
      'return cloud.sunRadiance.xyz *',
      'return cloud.sunRadiance.xyz * view_solar_transmittance(view, position) *',
    )
    // Atmosphere lights are irradiance (lux); its normalized phase already
    // integrates to one over the sphere. Preserve the legacy non-atmosphere
    // cloud convention only when no physical medium is active.
    .replace(
      '(direct + multiple) * 12.5663706144',
      '(direct + multiple) * select(12.5663706144, 1.0, view.atmosphereControl.w > 0.5)',
    )
    .replaceAll(
      'solarTransmittance, dot(ray, sunDirection), cloudHeight,',
      'solarTransmittance, dot(ray, sunDirection), cloudHeight, samplePosition,',
    );
  const resolve = common(CLOUD_RESOLVE_FULLSCREEN_WGSL).replace(
    'return vec4<f32>(scene.rgb * transmittance + radiance, scene.a);',
    `let air=view_fog(view,cloudDepth.xyz);
  // Coverage weights inscattering: already-rendered sky is never fogged twice.
  let cloudRadiance=air.transmittance*radiance+(1.0-transmittance)*air.inscatter;
  return vec4<f32>(scene.rgb*transmittance+cloudRadiance,scene.a);`,
  );
  const programs: ReadonlyArray<readonly [string, string]> = [
    ['transport', transport],
    [
      'transport-analytic',
      transport.replace(
        'cloud_solar_cached_transmittance(samplePosition)',
        'cloud_solar_transmittance(samplePosition)',
      ),
    ],
    ['resolve', resolve],
  ];
  return programs.map(([name, source]) => ({
    id: `forgeax-cloud-atmosphere-${name}.wgsl`,
    reservedIdentifier: `forgeax::cloud-atmosphere-${name}`,
    source: `#define_import_path forgeax_cloud::atmosphere_${name.replaceAll('-', '_')}\n${header}${source}`,
  }));
}
