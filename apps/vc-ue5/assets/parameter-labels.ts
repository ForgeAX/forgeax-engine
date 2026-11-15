// The HUD, wire validation and R6 attribute table share these definitions.
export type ParameterCondition = 'always' | 'enabled' | 'sampled' | 'program' | 'ray' | 'map' | 'surface' | 'atmosphere' | 'multiple';
type Owner = 'Layer' | 'Material' | 'Sun' | 'Camera' | 'Clock';
type Group = 'layer' | 'density' | 'motion' | 'sun' | 'scattering' | 'shadows' | 'tracing';
interface Label {
  readonly part: string;
  readonly label: string;
  readonly ue: string;
  readonly unit: string;
  readonly owner: Owner;
  readonly group: Group;
  readonly condition: ParameterCondition;
  readonly update: 'dynamic' | 'cooked-static';
}
const num = (part: string, label: string, ue: string, unit: string, owner: Owner, group: Group,
  condition: ParameterCondition, min: number, max: number, integer = false) =>
  ({ part, label, ue, unit, owner, group, condition, update: 'dynamic', kind: 'number', min, max, integer } as const satisfies Label & {kind: 'number'; min: number; max: number; integer: boolean});
const flag = (part: string, label: string, ue: string, owner: Owner, group: Group,
  condition: ParameterCondition, update: Label['update'] = 'dynamic') =>
  ({ part, label, ue, unit: '', owner, group, condition, update, kind: 'boolean' } as const satisfies Label & {kind: 'boolean'});

export const cloudParameterLabels = {
  bottomMeters: num('cloud-bottom', '云底高度', 'Layer Bottom', 'm', 'Layer', 'layer', 'enabled', 1, 20000),
  thicknessMeters: num('cloud-thickness', '云层厚度', 'Layer Height', 'm', 'Layer', 'layer', 'enabled', 1, 20000),
  extinctionPerMeter: num('cloud-extinction', '消光系数', 'Cloud_GlobalDensity (output)', 'm⁻¹', 'Layer', 'density', 'enabled', 0, 0.02),
  layoutWeight: num('cloud-layout', '布局权重', 'Layout_CloudType (reference blend)', 'ratio', 'Layer', 'density', 'sampled', 0, 1),
  maskWeight: num('cloud-mask', '遮罩权重', 'Layout_CloudTypeMask (reference blend)', 'ratio', 'Layer', 'density', 'sampled', 0, 1),
  profileWeight: num('cloud-profile', '剖面权重', 'Layout_CloudHeightProfile (reference blend)', 'ratio', 'Layer', 'density', 'sampled', 0, 1),
  bodyWeight: num('cloud-body', '主体权重', 'Noise_Strength (body blend)', 'ratio', 'Layer', 'density', 'sampled', 0, 1),
  erosionWeight: num('cloud-erosion', '侵蚀强度', 'Noise_Strength (erosion blend)', 'ratio', 'Layer', 'density', 'sampled', 0, 1),
  coverageBias: num('cloud-coverage', '覆盖偏置', 'Cloud_GlobalCoverage', 'ratio', 'Layer', 'density', 'sampled', -1, 1),
  useDetail: flag('cloud-detail', '细节噪声', 'UseNoise3', 'Material', 'density', 'sampled', 'cooked-static'),
  skipEmpty: flag('cloud-skip', '空域跳过', 'Conservative Density', 'Layer', 'density', 'sampled'),
  windX: num('cloud-wind-x', '风速 X', 'Physical Wind X', 'm/s', 'Clock', 'motion', 'program', -200, 200),
  windY: num('cloud-wind-y', '风速 Y', 'Physical Wind Y', 'm/s', 'Clock', 'motion', 'program', -200, 200),
  windZ: num('cloud-wind-z', '风速 Z', 'Physical Wind Z', 'm/s', 'Clock', 'motion', 'program', -200, 200),
  referenceTimeSeconds: num('cloud-time', '参考时间', 'Reference Time', 's', 'Clock', 'motion', 'always', 0, 9999999),
  sunElevation: num('sun-elevation', '太阳高度', 'Atmosphere Sun Light Elevation', '°', 'Sun', 'sun', 'always', -90, 180),
  sunAzimuth: num('sun-azimuth', '太阳方位', 'Atmosphere Sun Light Azimuth', '°', 'Sun', 'sun', 'always', -360, 360),
  sunIlluminanceLux: num('sun-illuminance', '太阳照度', 'Directional Light Intensity', 'lx', 'Sun', 'sun', 'always', 0, 200000),
  exposure: num('exposure', '曝光', 'Camera Exposure (multiplier)', '×', 'Camera', 'sun', 'always', 0.000001, 10),
  phaseG: num('phase-g', '相位 G', 'Phase G', 'ratio', 'Layer', 'scattering', 'program', -0.99, 0.99),
  phaseG2: num('phase-g2', '相位 G2', 'Phase G2', 'ratio', 'Layer', 'scattering', 'program', -0.99, 0.99),
  phaseBlend: num('phase-blend', '双瓣混合', 'Phase Blend', 'ratio', 'Layer', 'scattering', 'program', 0, 1),
  multiScatteringOctaves: num('ms-octaves', '额外散射层', 'Approximation Octave Count', 'count', 'Layer', 'scattering', 'program', 0, 2, true),
  msContribution: num('ms-contribution', '散射贡献', 'Multi Scattering Contribution', 'ratio', 'Layer', 'scattering', 'multiple', 0, 1),
  msOcclusion: num('ms-occlusion', '消光缩放', 'Multi Scattering Occlusion', 'ratio', 'Layer', 'scattering', 'multiple', 0, 1),
  msEccentricity: num('ms-eccentricity', '相位缩放', 'Multi Scattering Eccentricity', 'ratio', 'Layer', 'scattering', 'multiple', 0, 1),
  atmosphereTransmittanceMode: num('atmosphere-mode', '太阳大气透射', 'Use Per Sample Atmospheric Light Transmittance', 'enum', 'Layer', 'scattering', 'program', 0, 1, true),
  enableDistantSkyLightSampling: flag('sky-sampling', '天空填充', 'Distant Sky Light Sampling', 'Layer', 'scattering', 'program'),
  selfShadow: flag('self-shadow', '云内自阴影', 'Ray March Volume Shadow / Self Shadow', 'Layer', 'shadows', 'program'),
  groundShadowEnabled: flag('ground-shadow', '地面云影', 'Cast Cloud Shadows (surface)', 'Layer', 'shadows', 'enabled'),
  atmosphereShadowEnabled: flag('atmosphere-shadow', '大气云影', 'Cast Cloud Shadows (atmosphere)', 'Layer', 'shadows', 'enabled'),
  shadowMode: num('shadow-mode', '自阴影路径', 'Ray March Volume Shadow (route)', 'enum', 'Layer', 'shadows', 'program', 0, 1, true),
  surfaceShadowStrength: num('surface-shadow-strength', '地表混合', 'Cloud Shadow on Surface Strength', 'ratio', 'Layer', 'shadows', 'surface', 0, 1),
  atmosphereShadowStrength: num('atmosphere-shadow-strength', '大气混合', 'Cloud Shadow on Atmosphere Strength', 'ratio', 'Layer', 'shadows', 'atmosphere', 0, 1),
  entryLimitMeters: num('trace-entry', '入层距离上限', 'Tracing Start Max Distance', 'm', 'Layer', 'tracing', 'enabled', 1, 1000000),
  traceLimitMeters: num('trace-limit', '追踪距离上限', 'Tracing Max Distance', 'm', 'Layer', 'tracing', 'enabled', 1, 1000000),
  viewSampleCountScale: num('cloud-samples', '视线采样倍率', 'View Sample Count Scale', '×', 'Layer', 'tracing', 'program', 0, 8),
  stopTransmittance: num('cloud-stop', '停止透射阈值', 'Stop Tracing Transmittance Threshold', 'ratio', 'Layer', 'tracing', 'program', 0, 1),
  shadowSamples: num('shadow-samples', '光路样本', 'Shadow View Sample Count (absolute)', 'count', 'Layer', 'tracing', 'ray', 1, 64, true),
  shadowDistanceMeters: num('shadow-distance', '光路长度', 'Shadow Tracing Distance', 'm', 'Layer', 'tracing', 'ray', 0, 100000),
  shadowExtentMeters: num('shadow-extent', '图全宽', 'Cloud Shadow Full Width', 'm', 'Layer', 'tracing', 'map', 1, 600000),
  shadowLightDistanceMeters: num('shadow-light-distance', '光平面距离', 'Cloud Shadow Light Distance', 'm', 'Layer', 'tracing', 'map', 1, 1000000),
  shadowFarDepthMeters: num('shadow-far-depth', '图追踪深度', 'Cloud Shadow Far Depth', 'm', 'Layer', 'tracing', 'map', 1, 2000000),
  shadowDepthBiasMeters: num('shadow-bias', '深度偏差', 'Cloud Shadow Depth Bias', 'm', 'Layer', 'tracing', 'map', -1000, 1000),
  shadowStrength: num('shadow-strength', '阴影图强度', 'Cloud Shadow Strength', 'ratio', 'Layer', 'tracing', 'map', 0, 1),
  shadowResolution: num('shadow-resolution', '阴影图分辨率', 'Cloud Shadow Map Resolution (absolute)', 'texels', 'Layer', 'tracing', 'map', 16, 2048, true),
  shadowMapSamples: num('shadow-map-samples', '阴影图采样', 'Cloud Shadow Ray Sample Count (absolute)', 'count', 'Layer', 'tracing', 'map', 1, 256, true),
} as const;
export type CloudParameterKey = keyof typeof cloudParameterLabels;

export const conditionReasons: Record<ParameterCondition, string> = {
  always: '', enabled: '云层已关闭', sampled: '当前材质没有参考密度参数或对应 Cook 变体',
  program: '当前路径是解析均匀云，或云层已关闭',
  ray: '启用云内自阴影并选择二级光路后生效',
  map: '启用地面／大气云影或 Beer 自阴影后生效',
  surface: '启用地面云影后生效', atmosphere: '启用大气云影后生效',
  multiple: '增加散射层后生效',
};

export const cookedParameterLabels: Readonly<Record<string, string>> = {
  layoutScaleMeters: 'Layout_CloudGlobalScale (m)',
  albedo: 'Cloud_AlbedoColor / Material AO (linear RGB + AO)',
  layoutPattern: 'Layout_CloudType (texture GUID)',
  layoutMask: 'Layout_GlobalCloudMask (texture GUID)',
  heightProfile: 'Layout_CloudHeightProfile (texture GUID)',
  bodyNoise: 'Noise_Texture3D (texture GUID)',
  centerMeters: '云带中心 (m)',
  halfWidthMeters: '云带半宽 (m)',
};
