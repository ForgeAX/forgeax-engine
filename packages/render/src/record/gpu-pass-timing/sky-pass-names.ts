/** Stable Standard graph pass identities for physical sky timing. */
export const SkyPass = {
  atmosphereBackground: 'atmosphere-background',
  atmosphereComposition: 'atmosphere-opaque-composition',
  cloudShadow: 'cloud-layer-shadow',
  cloudShadowFilter: 'cloud-layer-shadow-filter',
  cloudAnalyticTrace: 'cloud-analytic-trace',
  cloudSampledTrace: 'cloud-sampled-trace',
  cloudProbe: 'cloud-mode0-probe',
  cloudHistoryClear: 'cloud-mode0-history-clear',
  cloudReconstruction: 'cloud-layer-transport',
  cloudResolve: 'cloud-layer-resolve',
  analyticFog: 'analytic-fog',
  volumeInject: 'volume-inject',
  volumeIntegrate: 'volume-integrate',
  volumeTemporal: 'volume-temporal',
  volumeComposite: 'volume-composite',
} as const;

export const AtmosphereLutPass = {
  transmittance: 'atmosphere-transmittance',
  multiple_scattering: 'atmosphere-multiple-scattering',
  distant_sky_light: 'atmosphere-distant-sky-light',
  capture_sky_view: 'atmosphere-capture-sky-view',
  sky_view: 'atmosphere-sky-view',
  aerial_perspective: 'atmosphere-aerial-perspective',
} as const;

export const AtmosphereRasterLutPass = {
  transmittance: 'atmosphere-transmittance-fragment',
  multiple_scattering: 'atmosphere-multiple-scattering-fragment',
  sky_view: 'atmosphere-sky-view-fragment',
  capture_sky_view: 'atmosphere-capture-sky-view-fragment',
} as const;

export const ATMOSPHERE_PREFILTER_SIZE = 64;
export const ATMOSPHERE_SKY_FACES = 6;

export const atmosphereSkyCubePass = (face: number) => `atmosphere-cube-${face}`;
export const SkyShPass = {
  prepare: 'sky-sh-prepare',
  project: 'sky-sh-project',
  computeReduce: 'sky-sh-reduce',
  rasterReduce: 'sky-sh-reduce-0',
  rasterFinalize: 'sky-sh-reduce-1',
  publish: 'sky-sh-publish',
} as const;
export const atmospherePrefilterPass = (level: number) => `atmosphere-prefilter-${level}`;
export const atmospherePrefilterCopyPass = (level: number) => `atmosphere-prefilter-copy-${level}`;
