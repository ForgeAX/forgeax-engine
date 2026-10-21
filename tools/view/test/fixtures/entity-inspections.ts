// Explicit schema fixtures for presentation tests, not Engine integration evidence.
const field = (type: string, labels?: Record<string, number>) => ({ type, ...(labels ? { labels } : {}) });
const component = (name: string, fields: Record<string, ReturnType<typeof field>>, values: Record<string, unknown>) => ({ name, fields, values, schema: {}, meta: {}, writable: false });
const mesh = () => [component('MeshFilter', { assetHandle: field('asset<mesh>') }, { assetHandle: 1025 }),
  component('MeshRenderer', { materials: field('array<asset<material>>'), lightingChannels: field('f64') }, { materials: [], lightingChannels: 1 })];
const light = (name: string) => component(name, { color: field('array<f32, 3>'), intensity: field('f32'), castShadow: field('bool') }, { color: [1, 0.85, 0.6], intensity: 3, castShadow: true });
export const fixtureTransform = component('Transform', { pos: field('array<f32, 3>'), quat: field('array<f32, 4>'), scale: field('array<f32, 3>') }, { pos: [0, -0.2800000011920929, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] });
export const entityInspectorCases = [
  { kind: 'entity', group: 'all', components: [component('CustomHealth', { health: field('f32'), samples: field('array<f32>') }, { health: 7, samples: [1, 2, 3] })] },
  { kind: 'sceneInstance', group: 'object', components: [component('SceneInstance', { source: field('asset<scene>'), mapping: field('array<entity>'), state: field('unique<SceneInstanceState>') }, { source: 2050, mapping: [1, 2, 3], state: { entities: 3 } })] },
  { kind: 'mesh', group: 'rendering', components: mesh() },
  { kind: 'skinnedMesh', group: 'animation', components: [...mesh(), component('Skin', { skeleton: field('asset<skeleton>'), joints: field('array<entity>') }, { skeleton: 2051, joints: [1, 2, 3] })] },
  { kind: 'instancedMesh', group: 'rendering', components: [...mesh(), component('Instances', { transforms: field('array<f32>') }, { transforms: Array(32).fill(0) })] },
  { kind: 'camera', group: 'rendering', components: [component('Camera', {
    projection: field('enum', { perspective: 0, orthographic: 1 }), fov: field('f32'), near: field('f32'), far: field('f32'),
    exposure: field('f32'), antialias: field('enum', { none: 0, taa: 1 }), bloomIntensity: field('f32'), clearColor: field('array<f32, 4>'),
  }, { projection: 0, fov: 0.785398, near: 0.1, far: 1000, exposure: 1, antialias: 0, bloomIntensity: 0.25, clearColor: [0.03, 0.06, 0.12, 1] }),
    component('StereoCamera', { eyeSeparation: field('f32') }, { eyeSeparation: 0.065 }), component('CubeCamera', { size: field('u32') }, { size: 512 })] },
  { kind: 'directionalLight', group: 'rendering', components: [light('DirectionalLight')] },
  { kind: 'pointLight', group: 'rendering', components: [light('PointLight'), component('PointLightShadow', { bias: field('f32') }, { bias: 0.001 })] },
  { kind: 'spotLight', group: 'rendering', components: [light('SpotLight')] },
  { kind: 'areaLight', group: 'rendering', components: [light('RectAreaLight')] },
  { kind: 'skylight', group: 'rendering', components: [component('Skylight', { equirect: field('asset<equirect>'), color: field('array<f32, 3>'), intensity: field('f32') }, { equirect: 2052, color: [1, 1, 1], intensity: 0.8 })] },
  { kind: 'sky', group: 'rendering', components: [component('SkyboxBackground', { equirect: field('asset<equirect>') }, { equirect: 2052 }), component('Atmosphere', { density: field('f32') }, { density: 0.8 }), component('CloudLayer', { height: field('f32') }, { height: 1200 })] },
  { kind: 'fog', group: 'rendering', components: [component('Fog', { color: field('array<f32, 3>'), density: field('f32') }, { color: [0.5, 0.5, 0.5], density: 0.1 }), component('VolumetricFog', { density: field('f32') }, { density: 0.01 })] },
  { kind: 'reflection', group: 'rendering', components: ['ReflectionProbe', 'LightProbe', 'PlanarReflection'].map(name => component(name, { radius: field('f32') }, { radius: 4 })) },
  { kind: 'postProcess', group: 'rendering', components: [component('PostProcessParams', { params: field('unique<PostProcessParams>') }, { params: { exposure: 1 } }), ...['AmbientOcclusion', 'DepthOfField', 'ScreenSpaceReflection', 'MotionBlur'].map(name => component(name, { enabled: field('bool') }, { enabled: true }))] },
  { kind: 'physics', group: 'physics', components: [component('RigidBody', { type: field('enum', { static: 0, dynamic: 1 }), mass: field('f32') }, { type: 0, mass: 1 }), component('Collider', { shape: field('enum', { box: 0, sphere: 1 }), isSensor: field('bool') }, { shape: 0, isSensor: false }), component('CharacterController', { grounded: field('bool') }, { grounded: true })] },
  { kind: 'animation', group: 'animation', components: [component('AnimationPlayer', { clips: field('array<asset<animation-clip>>'), weights: field('array<f32>'), paused: field('bool') }, { clips: [100, 101, 102], weights: [0.2, 0.3, 0.5], paused: false }), component('MorphWeights', { weights: field('array<f32>') }, { weights: { items: Array(128).fill(0.5), truncated: true, length: 300 } }), component('AnimationRootMotion', { enabled: field('bool') }, { enabled: true }), component('SplineIK', { joints: field('array<entity>') }, { joints: [1, 2, 3, 4] })] },
  { kind: 'audio', group: 'media', components: [component('AudioSource', { clip: field('asset<audio>'), playing: field('bool'), volume: field('f32') }, { clip: 2053, playing: false, volume: 0.8 }), component('AudioListener', {}, {}), component('AcousticRegion', { size: field('array<f32, 3>') }, { size: [1, 2, 3] })] },
  { kind: 'vfx', group: 'effects', components: [component('ParticleEffectPlayer', { effect: field('asset<particle-effect>'), playing: field('bool'), seed: field('u32'), timeScale: field('f32') }, { effect: 2054, playing: false, seed: 17, timeScale: 1 })] },
  { kind: 'sprite', group: 'rendering', components: [component('SpriteInstances', { frames: field('array<u32>') }, { frames: [1, 2, 3] }), component('SpriteAnimation', { playing: field('bool') }, { playing: false }), component('SpriteRegionOverride', { region: field('u32') }, { region: 1 })] },
  { kind: 'tilemap', group: 'rendering', components: ['Tilemap', 'TileLayer'].map(name => component(name, { tiles: field('array<u32>') }, { tiles: [1, 2, 3, 4] })) },
  { kind: 'text', group: 'rendering', components: [component('GlyphText', { text: field('string'), size: field('f32') }, { text: 'Inspector fixture', size: 16 })] },
  { kind: 'geometry', group: 'rendering', components: ['Lines', 'Points'].map(name => component(name, { vertices: field('array<f32>') }, { vertices: [0, 1, 2] })) },
  { kind: 'decal', group: 'rendering', components: [component('ProjectedDecal', { material: field('asset<material>'), opacity: field('f32') }, { material: 2055, opacity: 0.5 })] },
  { kind: 'terrain', group: 'rendering', components: [component('Terrain', { asset: field('asset<terrain>'), forcedLod: field('u32') }, { asset: 2056, forcedLod: 0 })] },
  { kind: 'navigation', group: 'behavior', components: ['NavigationAgent', 'NavigationCharacter', 'Path', 'PathFollower', 'DesiredPathPose'].map(name => component(name, { path: field('array<f32>'), speed: field('f32') }, { path: [1, 2, 3], speed: 2 })) },
  { kind: 'npc', group: 'behavior', components: [component('NpcBrain', { soulId: field('string'), enabled: field('bool'), lod: field('enum', { active: 0, distant: 1 }) }, { soulId: 'fixture-npc', enabled: true, lod: 0 })] },
  { kind: 'video', group: 'media', components: [component('VideoPlayer', { clip: field('asset<video>'), playing: field('bool'), loop: field('bool'), currentTime: field('f32') }, { clip: 2057, playing: false, loop: false, currentTime: 0 })] },
] as const;
