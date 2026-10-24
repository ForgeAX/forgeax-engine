# ForgeaX SDK API index

> Generated from Engine sources by `node scripts/forgeax/sdk-api-index.mjs`; do not edit.
> Look signatures up here before searching `node_modules`; `...` marks an abridged member list.

## Gotchas

- Import from `@forgeax/engine/<facade>` only, never physical `@forgeax/engine-*` packages.
- Expected failures return `Result` (`r.ok ? r.value : r.error`, `.unwrap()` throws): World methods, asset loads, geometry, pack builds.
- Math values are branded `Float32Array`s from `vec3.create(x, y, z)` / `quat.create()`; functions write into `out` and return it. Component data takes plain arrays (`{ pos: [0, 1, 0] }`).
- Euler order is a required argument: `quat.fromEuler(out: Quat, x: number, y: number, z: number, order: EulerOrder): Quat`.
- Pack output keys (sourceKeys) must match `PACK_SOURCE_KEY_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/` (lower case).
- Screen to ground: `viewportToWorld` (canvas pixels, top-left origin, after transform propagation) returns a world ray; solve `origin.y + t * dir.y = 0` for a ground plane. `pick` returns the nearest entity AABB hit.
- Input: in a system read `world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)`; `mouse.position` (canvas pixels, hover) may be `undefined`.
- Declare every service a plugin reads in `inject` (`inject: ['world', 'assets', 'gameHost']`); add systems inside `ctx.effect` and `yield` their removal.
- Camera: `{ component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }), clearColor: [0, 0, 0, 1] } }`; `fov` is radians. `DirectionalLight.direction` points from the light toward the scene (opposite of Three.js).
- Material transparency has no `opacity` field: use `baseColor` alpha plus `renderState: { blend, depthWriteEnabled: false }` and `queue: RenderQueue.Transparent`. Additive glow: `blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }`.
- `SpotLight` takes its position from `Transform` but aims by its world `direction` field (not the Transform rotation); cone angles are half-angles in degrees. Give a light-volume mesh `ShadowParticipation { cast: false, receive: false }` so it never shadows its own light.
- Custom lit shader: `Materials.standard({ surfaceModule, parameters, values })` names a `.wgsl` module under `assets/` (`#define_import_path`) that exports `evaluate_surface(input: SurfaceInput) -> SurfaceData` from `forgeax_material::surface_v1`; read parameters as `material.<name>` and seconds as `input.frameTime`. Feed a uniform per frame with `assets.update(handle, { values: { name } })`.

## `@forgeax/engine/types`
- `ok<T>(value: T): ResultOk<T>`
- `err<E>(error: E): ResultErr<E>`
- `type Result<T, E> = ResultOk<T> | ResultErr<E>`
- `RenderQueue = {Background: 1000, Geometry: 2000, AlphaTest: 2450, Transparent: 3000, Overlay: 4000 }`
- `MaterialRenderState { cullMode?: 'none' | 'front' | 'back'; depthWriteEnabled?: boolean; blend?: GPUBlendState; ... }`

## `@forgeax/engine/ecs`
- `World { spawn<SArr>(...componentDatas: {[K in keyof SArr]: {component: Component<string, SArr[K]>; data: Partial<InputShapeOf<SArr[K]>> } }): Result<EntityHandle, EcsError>; get<S>(entity: EntityHandle, component: Component<string, S>): Result<ShapeOf<S>, EcsError>; set<S, C>(entity: EntityHandle, component: C & WritableComponent<C>, value: Partial<InputShapeOf<S>>, markChanged?): Result<void, EcsError>; addComponent<S, C>(entity: EntityHandle, componentData: ComponentData<S> & {component: C & WritableComponent<C> }): Result<void, EcsError>; despawn(entity: EntityHandle): Result<void, EcsError>; insertResource<T>(key: string | {name: string }, value: T): void; getResource(key: typeof Time): TimeResource /* +2 overloads */; addSystem<Qs>(schedule: ScheduleToken, descriptor: SystemDescriptor<Qs>): Result<void, ScheduleScopeMismatchError>; removeSystem(schedule: ScheduleToken, name: string): Result<void, ScheduleMutationError | ScheduleScopeMismatchError>; ... }`
- `SystemDescriptor { name: string; queries: Qs; fn(world: World, queryResults: SystemQueryResults<Qs>, commands: CommandBuffer): void | unknown; after?: ReadonlyArray<string | ScheduleToken>; before?: ReadonlyArray<string | ScheduleToken>; ... }`
- `QueryDescriptor { read?: R; write?: W; with?: Component[]; without?: Component[]; ... }`
- `QueryRow { entity: EntityHandle; get<C>(component: C): ReadonlyRowShape<C> /* +1 overload */; mut<C>(component: C): MutableRowShape<C>; ... }`
- `defineComponent<N, S>(name: N, fields: S, options?: DefineComponentOptions): Component<N, SchemaOf<S>>`
- `TimeResource { delta: number; elapsed: number; ... }`
- Also: `Time`, `FixedTime`, `Update`, `FixedUpdate`, `EntityHandle`

## `@forgeax/engine/plugin`
- `type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>`
- `Context { world: World; assets?: AssetRegistry; physics?: PhysicsWorld | PhysicsWorld2D; gameHost?: GameHost; effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>> /* +1 overload */; ... }`

## `@forgeax/engine/app`
- `GameHost { canvas?: HTMLCanvasElement | OffscreenCanvas; uiRoot?: HTMLElement; assets: AssetRegistry; setPointerLockAllowed?(allowed: boolean): void; ... }`

## `@forgeax/engine/scene`
- `Transform { pos: array<f32, 3> = [0, 0, 0]; quat: array<f32, 4> = [0, 0, 0, 1]; scale: array<f32, 3> = [1, 1, 1]; shear: array<f32, 3> = [0, 0, 0] }` component
- `worldResolveSceneEntity(world: World, root: EntityHandle, ref: SceneEntityRef): Result<EntityHandle, EcsError>`
- `sceneEntity(sceneSourceKey: string, address: SceneEntityAddress): SceneEntityRef`
- `readPresentationWorldMatrix(world: World, entity: EntityHandle): ArrayLike<number> | undefined`
- Also: `Name`, `worldDespawnScene`, `GlobalTransform`, `ChildOf`, `Children`, `PROPAGATE_TRANSFORMS_SYSTEM`

## `@forgeax/engine/math`
- `vec3 { create(x?, y?, z?): Vec3; add(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3; sub(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3; scale(out: Vec3, a: Vec3Like, s: number): Vec3; normalize(out: Vec3, a: Vec3Like): Vec3; length(a: Vec3Like): number; distance(a: Vec3Like, b: Vec3Like): number; lerp(out: Vec3, a: Vec3Like, b: Vec3Like, t: number): Vec3; ... }`
- `quat { create(): Quat; fromEuler(out: Quat, x: number, y: number, z: number, order: EulerOrder): Quat; fromAxisAngle(out: Quat, axis: Vec3Like, angleRadians: number): Quat; fromLookAt(out: Quat, eye: Vec3Like, target: Vec3Like, up: Vec3Like): Quat; multiply(out: Quat, a: QuatLike, b: QuatLike): Quat; slerp(out: Quat, a: QuatLike, b: QuatLike, t: number): Quat; ... }`
- `ray { getOrigin(out: Vec3, r: RayLike): Vec3; getDirection(out: Vec3, r: RayLike): Vec3; ... }`
- `type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY'`
- Also: `vec2`, `vec4`, `mat3`, `mat4`, `euler`, `color`, `box3`, `easing`, `noise`

## `@forgeax/engine/picking`
- `viewportToWorld(world: World, cameraEntity: EntityHandle, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): ray.Ray | undefined`
- `pick(world: World, cameraEntity: EntityHandle, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): PickHit | undefined`
- `PickHit { entity: EntityHandle; point: Vec3Like; distance: number }`
- Also: `pickTriangle`, `pickVertex`, `pickTile`

## `@forgeax/engine/input`
- `INPUT_SNAPSHOT_RESOURCE_KEY = 'InputSnapshot'`
- `InputSnapshot { keyboard: {down(key: string): boolean; justPressed(key: string): boolean; up(key: string): boolean; downCode(code: string): boolean; justPressedCode(code: string): boolean; upCode(code: string): boolean }; mouse: {position: {x: number; y: number } | undefined; movementDelta: {x: number; y: number }; pointerLocked: boolean; button(i: MouseButtonIndex): boolean; justPressed(i: MouseButtonIndex): boolean; justReleased(i: MouseButtonIndex): boolean; wheelDelta: number }; ... }`
- Also: `getAxis`, `getVector`

## `@forgeax/engine/render`
- `perspective(opts) { fov: number; aspect: number; near?: number; far?: number; autoAspect?: boolean; ... }`
- `orthographic(opts) { left: number; right: number; bottom: number; top: number; near?: number; far?: number; ... }`
- `Camera { clearColor: array<f32, 4> = [0, 0, 0, 0]; tonemap: f32 = 0; exposure: f32 = 1.0; antialias: f32 = 0; bloom: f32 = 0; bloomThreshold: f32 = 0; bloomIntensity: f32 = 1.0; ... }` component
- `DirectionalLight { direction: array<f32, 3>; color: array<f32, 3> = [1, 1, 1]; intensity: f32 = 1; castShadow: bool = false; ... }` component
- `PointLight { color: array<f32, 3> = [1, 1, 1]; intensity: f32 = 1; range: f32; ... }` component
- `SpotLight { direction: array<f32, 3>; color: array<f32, 3> = [1, 1, 1]; intensity: f32 = 1; range: f32; innerConeDeg: f32 = 60; outerConeDeg: f32 = 60; castShadow: bool = false; ... }` component
- `Skylight { color: array<f32, 3> = [1, 1, 1]; intensity: f32 = 1.0; ... }` component
- `Fog { color: array<f32, 3> = [0.5, 0.5, 0.5]; density: f32 = 0.01; heightFalloff: f32 = 0; ... }` component
- `VolumetricFog { light: entity; spotLight: entity; density: asset<texture>; boundsMin: array<f32, 3>; boundsMax: array<f32, 3>; ... }` component
- `ShadowParticipation { cast: bool = true; receive: bool = true; ... }` component
- `MeshFilter { assetHandle: asset<mesh> }` component
- `MeshRenderer { materials: array<asset<material>>; ... }` component
- `Materials.standard(options) { baseColor: MaterialColorInput4; metallic?: number; roughness?: number; emissive?: MaterialColorInput3; emissiveIntensity?: number; baseColorTexture?: MaterialValue; alphaCutoff?: number; renderState?: MaterialRenderState; queue?: number; surfaceModule: string; parameters: MaterialParameter[]; values: Readonly<Record<string, MaterialValue>>; ... }`
- `Materials { unlit(rgba: MaterialColorInput4, opts?: UnlitOpts): MaterialRootAsset; ... }`
- Also: `setActiveCamera`, `SkyboxBackground`, `Atmosphere`, `TONEMAP_ACES_FILMIC`, `ANTIALIAS_FXAA`, `BLOOM_ENABLED`

## `@forgeax/engine/geometry`
- `createBoxGeometry(width: number, height: number, depth: number, widthSegments?: number, heightSegments?: number, depthSegments?: number): Result<MeshAsset, AssetError>`
- Also: `createSphereGeometry`, `createPlaneGeometry`, `createCylinderGeometry`, `createCapsuleGeometry`, `createConeGeometry`, `createTorusGeometry`, `createMeshBuilder`

## `@forgeax/engine/physics`
- `physicsPlugin(backend: PhysicsBackend): Plugin`
- `RigidBody { type: enum; mass: f32 = 1; linearDamping: f32 = 0; gravityScale: f32 = 1; lockRotation: bool = false; ... }` component
- `RigidBodyTypeValue = {static: 0, dynamic: 1, kinematic: 2 }`
- `Collider { shape: enum; halfExtents: array<f32, 3> = [0.5, 0.5, 0.5]; radius: f32 = 0.5; halfHeight: f32 = 0.5; friction: f32 = 0.5; isSensor: bool = false; ... }` component
- `ColliderShapeValue = {cuboid: 0, sphere: 1, capsule: 2, cylinder: 3, cone: 4, convexHull: 5, trimesh: 6 }`
- `CharacterController { snapToGroundDist: f32 = 0.2; grounded: bool = false; ... }` component
- `PhysicsWorld { raycast(origin: Vec3, direction: Vec3, maxDist: number, filterMask?: number): RaycastHit | undefined; moveAndSlide(entity: number, desiredDelta: Vec3): Vec3; teleport(entity: number, position: Vec3): void; applyBodyImpulse?(entity: number, impulse: PhysicsVector): Result<void, ManagedPhysicsFailure>; setBodyMotion?(entity: number, motion: Omit<BodyMotion, 'sleeping'>): Result<void, ManagedPhysicsFailure>; ... }`

## `@forgeax/engine/pack/source`
- `definePack(definition: NoParameterPackInput): ScriptablePackDefinition<undefined> /* +1 overload */`
- `definePackageId(value: string | PackageId): PackageId`

## `@forgeax/engine/assets-runtime`
- `AssetRegistry { load<K>(guid: AssetGuid | string, kind: K, options?: AssetLoadOptions): Promise<Result<AssetHandle<K>, RuntimeAssetError>> /* +1 overload */; create<P, K>(kind: AssetKind<P, K>, input: P): Result<AssetHandle<K, P>, AssetError | MaterialError> /* +2 overloads */; update<K, P>(handle: AssetHandle<K, P>, patch: Partial<Omit<P extends ParticleEffectAsset ? ParticleEffectInput : P, 'kind'>>): Result<void, AssetError | MaterialError>; release(handle: number): Result<void, AssetError>; instantiate(handle: AssetHandle<'scene'>, world: World, parent?: EntityHandle): Result<EntityHandle, SceneInstantiateError>; parseGuid(guidStr: string): AssetGuid; ... }`

## `@forgeax/engine/animation`
- `AnimationPlayer { clips: array<asset<animation-clip>>; times: array<f64>; speeds: array<f32>; looping: bool = true; ... }` component
- `bindAnimationTargets(world: World, player: EntityHandle, targets: EntityHandle[]): Result<void, BindAnimationTargetsError>`
- `deriveAnimationTargetId(path: string[]): AnimationTargetIdValue`

## `@forgeax/engine/audio`
- `AudioSource { clip: asset<audio>; playing: bool = false; loop: bool = false; volume: f32 = 1.0; spatialBlend: f32 = 0; bus: string = 'sfx'; ... }` component
- Also: `AudioListener`, `audioPlugin`

## `@forgeax/engine/vfx`
- `ParticleEffectPlayer { effect: asset<particle-effect>; playing: bool = true; seed: u32 = 0; timeScale: f32 = 1; ... }` component

## `@forgeax/engine/ui`
- `mountUi(asset: UiAsset, options: MountOptions): UiResult<UiInstance>`
- `mountUi(options) { root: HTMLElement; layer: number; onAction?(name: string, event: Event): void }`
- `UiInstance { host: HTMLElement; dispose(): void; ... }`

## `@forgeax/engine/state`
- `defineState<Name, Variants>(name: Name, variants: Variants): StateToken<Name, Variants[number]>`
- `setNextState<T>(world: World, token: T, variant: StateTokenVariant<T>): Result<void, StateError>`
- Also: `getState`, `addOnEnter`, `addOnExit`, `inState`

## `@forgeax/engine/navigation`
- `createNavigationGrid(source: NavigationGridSource): Result<NavigationGraph, NavigationError>`
- `NavigationGraph { findPath(start: number, goal: number, options?: {maxVisited?: number }): Result<NavigationPath, NavigationError>; ... }`
- Also: `setNavigationTarget`, `setNavigationPath`, `createNavigationMesh`
