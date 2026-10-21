import { type CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { type AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
  perspective,
  resolveVisibility,
} from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { AssetHandle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();


export const VisibilityCaster = defineComponent('EntityVisibilityCaster', {});
export const VisibilityTarget = defineComponent('EntityVisibilityTarget', {});
export const VisibilityAncestor = defineComponent('EntityVisibilityAncestor', {});
export const VisibilityVisibleChild = defineComponent('EntityVisibilityVisibleChild', {});
export const VisibilityInheritedDescendant = defineComponent(
  'EntityVisibilityInheritedDescendant',
  {},
);

type DemoEntity = EntityHandle;
export interface VisibilityEvidence {
  readonly targetEffective: 'hidden' | 'visible';
  readonly visibleChildEffective: 'hidden' | 'visible';
  readonly inheritedDescendantEffective: 'hidden' | 'visible';
  readonly explicitlyHidden: number;
  readonly visibleMeshCandidates: number;
}

export interface VisibilityDemoScene {
  readonly world: World;
  readonly caster: DemoEntity;
  readonly target: DemoEntity;
  readonly ancestor: DemoEntity;
  readonly visibleChild: DemoEntity;
  readonly inheritedDescendant: DemoEntity;
  setTargetHidden(): void;
  setTargetVisible(): void;
  setAncestorHiddenWithVisibleChild(): void;
  installShadowGateBypass(): void;
  evidence(): VisibilityEvidence;
}


function material(
  assets: AssetRegistry,
  baseColor: readonly [number, number, number, number],
): AssetHandle<'material'> {
  const asset: MaterialAsset = Materials.standard({
    baseColor,
    metallic: 0,
    roughness: 0.55,
  });
  return assets.create(asset).unwrap();
}

function shadowOnlyMaterial(assets: AssetRegistry): AssetHandle<'material'> {
  const asset = Materials.standard({
    baseColor: [0.9, 0.12, 0.08, 1],
    metallic: 0,
    roughness: 0.55,
  });
  if (asset.parent !== undefined) {
    throw new Error('visibility material child cannot override the root pass');
  }
  const shadowPass = asset.passes?.find((pass) => pass.name === 'shadow-caster');
  if (shadowPass === undefined) throw new Error('standard material has no shadow-caster pass');
  return assets.create({
    ...asset,
    passes: [shadowPass],
  }).unwrap();
}

function mesh(
  world: World,
  cube: AssetHandle<'mesh'>,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
  materialRef: AssetHandle<'material'>,
  tag:
    | typeof VisibilityCaster
    | typeof VisibilityTarget
    | typeof VisibilityVisibleChild
    | typeof VisibilityInheritedDescendant,
  parent?: DemoEntity,
): DemoEntity {
  const relation = parent === undefined ? [] : [{ component: ChildOf, data: { parent } }];
  return world
    .spawn(
      { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [materialRef] } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      { component: tag, data: {} },
      ...relation,
    )
    .unwrap();
}

export function createVisibilityDemoWorld(assets: AssetRegistry, world = new World({ assets })): VisibilityDemoScene {
  const cube = assets.create(BUILTIN_CUBE).unwrap();
  const red = material(assets, [0.9, 0.12, 0.08, 1]);
  const blue = material(assets, [0.08, 0.3, 0.95, 1]);
  const gold = material(assets, [0.95, 0.65, 0.08, 1]);
  const floorMaterial = material(assets, [0.24, 0.28, 0.34, 1]);
  const shadowOnlyRed = shadowOnlyMaterial(assets);

  const floor = world
    .spawn(
      { component: Transform, data: { pos: [0, -1.35, 0], scale: [5, 0.15, 3] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [floorMaterial] } },
    )
    .unwrap();
  void floor;

  const caster = mesh(world, cube, [-1.6, 0, 0], [0.8, 0.8, 0.8], blue, VisibilityCaster);
  const target = mesh(world, cube, [0, 0, 0], [0.8, 0.8, 0.8], red, VisibilityTarget);
  const ancestor = world
    .spawn(
      { component: Transform, data: { pos: [1.7, 0, 0], scale: [1, 1, 1] } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      { component: VisibilityAncestor, data: {} },
    )
    .unwrap();
  const visibleChild = mesh(
    world,
    cube,
    [0, 0, 0],
    [0.72, 0.72, 0.72],
    blue,
    VisibilityVisibleChild,
    ancestor,
  );
  world.set(visibleChild, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  const inheritedDescendant = mesh(
    world,
    cube,
    [0, 0.95, 0],
    [0.32, 0.32, 0.32],
    gold,
    VisibilityInheritedDescendant,
    visibleChild,
  );

  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.4, 7], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  void camera;
  const light = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -1, -0.35], color: [1, 1, 1], intensity: 1.5, castShadow: true },
    })
    .unwrap();
  void light;

  const meshEntities = [caster, target, visibleChild, inheritedDescendant];
  let shadowGateBypassInstalled = false;
  const scene: VisibilityDemoScene = {
    world,
    caster,
    target,
    ancestor,
    visibleChild,
    inheritedDescendant,
    setTargetHidden() {
      world.set(target, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    },
    setTargetVisible() {
      world.set(target, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    },
    setAncestorHiddenWithVisibleChild() {
      world.set(ancestor, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      world.set(visibleChild, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    },
    installShadowGateBypass() {
      if (shadowGateBypassInstalled) return;
      shadowGateBypassInstalled = true;
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] },
          },
          { component: MeshFilter, data: { assetHandle: cube } },
          { component: MeshRenderer, data: { materials: [shadowOnlyRed] } },
        )
        .unwrap();
    },
    evidence() {
      const snapshot = resolveVisibility(world);
      const visibleCount = meshEntities.filter(
        (entity) => snapshot.effective(entity) === 'visible',
      ).length;
      return {
        targetEffective: snapshot.effective(target),
        visibleChildEffective: snapshot.effective(visibleChild),
        inheritedDescendantEffective: snapshot.effective(inheritedDescendant),
        explicitlyHidden: meshEntities.length - visibleCount,
        visibleMeshCandidates: visibleCount,
      };
    },
  };
  return scene;
}

async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(canvas, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    reportError(appResult.error);
    return;
  }
  const app = appResult.value;
  if (app.assets === undefined) throw new Error('Visibility demo requires the host AssetRegistry');
  const scene = createVisibilityDemoWorld(app.assets, app.world);
  const variant = new URLSearchParams(location.search).get('variant');
  if (variant === 'shadow-gate-bypass') scene.installShadowGateBypass();
  const applyHiddenInput = (): void => {
    if (variant === 'hidden-target-visible') scene.setTargetVisible();
    else scene.setTargetHidden();
  };
  const waitForFrame = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  };
  const capture = async (): Promise<{
    readonly variant: string | null;
    readonly observed: Record<string, VisibilityEvidence>;
    readonly verdict: 'pass' | 'fail';
    readonly confidence: 'high' | 'medium';
  }> => {
    applyHiddenInput();
    await waitForFrame();
    const hidden = scene.evidence();
    scene.setTargetVisible();
    await waitForFrame();
    const restored = scene.evidence();
    scene.setAncestorHiddenWithVisibleChild();
    await waitForFrame();
    const child = scene.evidence();
    const observed = { hidden, restored, child };
    const verdict =
      hidden.targetEffective === 'hidden' &&
      hidden.visibleMeshCandidates < restored.visibleMeshCandidates &&
      restored.targetEffective === 'visible' &&
      child.visibleChildEffective === 'visible' &&
      child.inheritedDescendantEffective === 'visible'
        ? 'pass'
        : 'fail';
    return { variant, observed, verdict, confidence: 'high' };
  };

  Object.assign(globalThis, {
    __forgeaxEntityVisibility: {
      ready: () => true,
      capture,
      setTargetHidden: applyHiddenInput,
      setTargetVisible: () => scene.setTargetVisible(),
      setAncestorHiddenWithVisibleChild: () => scene.setAncestorHiddenWithVisibleChild(),
      evidence: () => scene.evidence(),
    },
  });
  app.start();
}

function reportError(error: CanvasAppError): void {
  if (error instanceof EngineEnvironmentError) {
    console.error(`[entity-visibility] no usable backend: ${error.reason}`);
    return;
  }
  console.error(`[entity-visibility] ${error.code}: ${error.hint}`);
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas) void bootstrap(canvas);
