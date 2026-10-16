export const SCENE_ENTITY_KINDS = [
  'entity', 'sceneInstance', 'mesh', 'skinnedMesh', 'instancedMesh', 'camera',
  'directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight', 'sky',
  'fog', 'reflection', 'postProcess', 'physics', 'animation', 'audio', 'vfx',
  'sprite', 'tilemap', 'text', 'geometry', 'decal', 'terrain', 'navigation', 'npc', 'video',
] as const;
export type SceneEntityKind = typeof SCENE_ENTITY_KINDS[number];

export const SCENE_ENTITY_COMPONENTS = {
  entity: [],
  sceneInstance: ['SceneInstance'],
  mesh: ['MeshFilter', 'MeshRenderer'],
  skinnedMesh: ['Skin'],
  instancedMesh: ['Instances'],
  camera: ['Camera', 'StereoCamera', 'CubeCamera'],
  directionalLight: ['DirectionalLight'],
  pointLight: ['PointLight', 'PointLightShadow'],
  spotLight: ['SpotLight'],
  areaLight: ['RectAreaLight'],
  skylight: ['Skylight'],
  sky: ['SkyboxBackground', 'Atmosphere', 'CloudLayer'],
  fog: ['Fog', 'VolumetricFog'],
  reflection: ['ReflectionProbe', 'LightProbe', 'PlanarReflection'],
  postProcess: ['PostProcessParams', 'AmbientOcclusion', 'DepthOfField', 'ScreenSpaceReflection', 'MotionBlur', 'LensEffects', 'LensFlare', 'BarrelDistortion', 'DynamicResolution', 'Outline'],
  physics: ['RigidBody', 'Collider', 'CharacterController', 'CollidingEntities'],
  animation: ['AnimationPlayer', 'MorphWeights', 'AnimationRootMotion', 'SplineIK', 'AnimationTargetId'],
  audio: ['AudioSource', 'AudioListener', 'AcousticRegion'],
  vfx: ['ParticleEffectPlayer'],
  sprite: ['SpriteInstances', 'SpriteAnimation', 'SpriteRegionOverride'],
  tilemap: ['Tilemap', 'TileLayer'],
  text: ['GlyphText'],
  geometry: ['Lines', 'Points'],
  decal: ['ProjectedDecal'],
  terrain: ['Terrain'],
  navigation: ['NavigationAgent', 'NavigationCharacter', 'Path', 'PathFollower', 'DesiredPathPose'],
  npc: ['NpcBrain'],
  video: ['VideoPlayer'],
} as const satisfies Record<SceneEntityKind, readonly string[]>;

const PRIMARY_ORDER: readonly SceneEntityKind[] = [
  'camera', 'directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight',
  'skinnedMesh', 'instancedMesh', 'terrain', 'decal', 'sprite', 'tilemap', 'text', 'geometry', 'mesh',
  'physics', 'animation', 'audio', 'video', 'vfx', 'navigation', 'npc',
  'sky', 'fog', 'reflection', 'postProcess', 'sceneInstance', 'entity',
];

/** Presentation facts only: the supplied component names remain Engine-owned. */
export function classifySceneEntity(componentNames: readonly string[]) {
  const names = new Set(componentNames);
  const capabilities: SceneEntityKind[] = SCENE_ENTITY_KINDS.filter(kind => kind !== 'entity'
    && (kind !== 'instancedMesh' || names.has('MeshFilter') || names.has('MeshRenderer'))
    && SCENE_ENTITY_COMPONENTS[kind].some((name: string) => names.has(name)));
  const kind = PRIMARY_ORDER.find(candidate => capabilities.includes(candidate)) ?? 'entity';
  const primaryComponents = SCENE_ENTITY_COMPONENTS[kind].filter((name: string) => names.has(name));
  return { kind, capabilities, primaryComponents };
}
