import { SynchronousTransform } from '@forgeax/engine-scene/internal';
import type { ResolvedMaterialTextureCoordinates } from '@forgeax/engine-types';
import { DirectionalLightShadow } from 'three/src/lights/DirectionalLightShadow.js';
import { PointLightShadow } from 'three/src/lights/PointLightShadow.js';
import { SpotLightShadow } from 'three/src/lights/SpotLightShadow.js';
import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import {
  AmbientLight,
  AttachedBindMode,
  Bone,
  type BufferGeometry,
  Camera,
  CanvasTexture,
  Color,
  DataTexture,
  DetachedBindMode,
  DirectionalLight,
  Euler,
  Group,
  InstancedMesh,
  Line,
  LOD,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  RectAreaLight,
  Scene,
  type Skeleton,
  SkinnedMesh,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector2,
  Vector3,
} from 'three/src/Three.Core.js';
import { PointContentChannels } from './geometry';
import type { StockMaterialEdit } from './material';
import { NODE_MATERIAL_INPUTS, plainNodeMaterial, watchNodeMaterialHooks } from './node-materials';
import { boundSurfaceRoot, hasSurfaceBinding, watchThreeSurfaceInputs } from './node-surface';
import { SourcePoseEdits } from './scene-walk';
import { type ShadowLight, shadowCasterChannels } from './shadow';
import { SkeletonChanges, type SkinCursor } from './skeleton-changes';
import {
  createdTracked,
  ownsCollection,
  publishWorldMatrix,
  sourceCollectionStorage,
  watchCollection,
  watchPublishedWorldMatrix,
  watchSourceHierarchy,
  watchTargetMatrix,
} from './source-collections';
import {
  compactFieldRow,
  observeField,
  observePose,
  observeScale,
  ownSourceValue,
  releaseField,
  subscribe,
} from './source-fields';
import { bindSourceWorldPose, resolveSourceWorldPose } from './source-world-pose';

const selected = new WeakMap<Scene, boolean>();

/** Opt in at the integration boundary. See the tracked source mutation contract in the package README. */
export function setThreeSceneTracking(scene: Scene, enabled: boolean): void {
  selected.set(scene, enabled);
}

export function trackingSelected(root: Object3D): boolean {
  return root instanceof Scene && (selected.get(root) ?? createdTracked(root));
}

/** Explicitly ordered transparent meshes can be sorted independently of scene projection. */
export function localTransparentOrder(node: Object3D): node is Mesh {
  const prototype = Object.getPrototypeOf(node);
  return (
    (prototype === Mesh.prototype || prototype === InstancedMesh.prototype) &&
    node instanceof Mesh &&
    !Array.isArray(node.material) &&
    node.material.transparent === true
  );
}

type Notify = () => void;

/** An externally writable array has one accepted snapshot per live projection. */
class ForeignInput {
  private readonly accepted: unknown[];
  readonly readers = new Map<Notify, number>();

  constructor(private readonly read: () => readonly unknown[]) {
    this.accepted = read().slice();
  }

  sample(): void {
    const current = this.read();
    const accepted = this.accepted;
    let i = 0;
    while (i < current.length && i < accepted.length && Object.is(accepted[i], current[i])) i++;
    if (i === current.length && i === accepted.length) return;
    accepted.length = current.length;
    for (; i < current.length; i++) accepted[i] = current[i];
    for (const notify of this.readers.keys()) notify();
  }
}
// Entries are either a release callback or a field key (or key list), source, listener.
// Keeping the field operands allows each scope to release subscriptions without per-field closures.
type CleanupScope = (object | string)[];
function releaseFrom(scope: CleanupScope, start = 0): void {
  for (let index = start; index < scope.length; ) {
    const entry = scope[index++];
    if (typeof entry === 'function') {
      entry();
    } else {
      const source = scope[index++] as object;
      const notify = scope[index++] as Notify;
      if (typeof entry === 'string') releaseField(source, entry, notify);
      else for (const key of entry as readonly string[]) releaseField(source, key, notify);
    }
  }
  scope.length = start;
}
let localPoseVersion = 0;
// Scene schedules the implicit update. Explicit world reads dispatch through Three at the call site.
const matrixMethods = ['updateMatrix', 'updateMatrixWorld'];
const branchFields = ['matrixAutoUpdate', 'matrixWorldAutoUpdate', 'pivot'];
const drawFields = ['geometry', 'material', 'castShadow', 'receiveShadow', 'frustumCulled'];
const drawHooks = ['onBeforeRender', 'onAfterRender', 'morphTargetInfluences'];

function stockAutomaticPose(node: Object3D): boolean {
  return (
    node.updateMatrix === Object3D.prototype.updateMatrix &&
    node.matrixAutoUpdate &&
    node.matrixWorldAutoUpdate &&
    node.pivot === null
  );
}

type SourceLight = AmbientLight | DirectionalLight | PointLight | RectAreaLight | SpotLight;

function passiveParent(node: Object3D): boolean {
  const proto = Object.getPrototypeOf(node);
  return (
    proto === Scene.prototype ||
    proto === PerspectiveCamera.prototype ||
    proto === OrthographicCamera.prototype ||
    proto === Group.prototype ||
    proto === Object3D.prototype ||
    proto === Mesh.prototype ||
    proto === Bone.prototype ||
    proto === SkinnedMesh.prototype ||
    proto === PointLight.prototype ||
    proto === AmbientLight.prototype ||
    proto === DirectionalLight.prototype ||
    proto === RectAreaLight.prototype ||
    proto === SpotLight.prototype
  );
}

export enum NodeStateFields {
  Name = 1,
  Shadow = 2,
  All = Name | Shadow,
}

type Draw = Mesh | Line | Points | Sprite;

export function separateDrawPose(node: Object3D): node is Sprite | RectAreaLight {
  return node instanceof Sprite || node instanceof RectAreaLight;
}

type Admission = boolean | 'view';
type ViewAncestry = 'ordinary' | 'residual' | 'hidden';
type AdmitNode = (node: Object3D, hidden: boolean) => Admission;

function childViewAncestry(node: Object3D, ancestry: ViewAncestry): ViewAncestry {
  // LOD updates its direct children's visibility while visiting the view.
  if (ancestry === 'hidden' || (!node.visible && !(node.parent instanceof LOD))) return 'hidden';
  return ancestry === 'ordinary' && node.visible && node.renderOrder === 0 && passiveParent(node)
    ? 'ordinary'
    : 'residual';
}
type SavedUse = {
  view: boolean;
  direct: boolean;
  coordinates?: ReadonlyMap<Texture, ResolvedMaterialTextureCoordinates>;
  meshes: Set<Draw>;
  variant: string;
  shading: 0 | 1;
  skinProgram: 'unlit' | 'standard' | undefined;
};

/** Per-projection work queues. Shared field slots multicast writes to independent consumers. */
export class SceneChanges {
  private readonly left = new Matrix4();
  private readonly right = new Matrix4();
  private readonly output = new Matrix4();
  private readonly scratchElements = this.output.elements;
  private readonly scopes = new Map<object, CleanupScope>();
  private readonly bindingScopes = new Map<object, CleanupScope>();
  private cleanups: CleanupScope = [];
  private readonly parents = new Map<Object3D, Object3D | null>();
  private readonly enrolledChildren = new Map<Object3D, Set<Object3D>>();
  private readonly childOrder = new WeakMap<Object3D, Map<Object3D, number>>();
  readonly layouts = new Set<BufferGeometry | Material | Texture>();
  private readonly deletedTail = new Map<Object3D, Object3D>();
  private readonly removed = new Map<Object3D, Object3D>();
  private readonly appended = new Map<Object3D, Object3D>();
  readonly lodUpdates = new WeakMap<LOD, (camera: Camera) => void>();
  private readonly rosters = new Set<Object3D>();
  checkedInputs = 0;
  jointReads = 0;
  rosterEntries = 0;
  private readonly probes = new Set<Notify>();
  private readonly foreignInputs = new Map<object, ForeignInput>();

  readonly structural = new Set<Object3D>();
  private readonly visibilityBranches = new Set<Object3D>();
  private readonly dirtyBindings = new Set<Object3D>();
  readonly retired = new Set<Object3D>();
  private readonly admitted = new Map<Object3D, 'branch' | 'binding'>();
  pose = new SourcePoseEdits();
  poseTopology = new Set<Object3D>();
  private readonly translations = new Set<Object3D>();
  private sparePose = new SourcePoseEdits();
  /** World-pose edits with remaining compatibility-side consumers. */
  projectedPose = new Set<Object3D>();
  readonly unobservedNativePoses = new Set<Object3D>();
  materials = new Set<Material>();
  readonly materialEdits = new Map<Material, Set<number | StockMaterialEdit>>();
  readonly uses = new Map<Material, Map<string, SavedUse>>();
  readonly children = new Map<Object3D, Object3D[]>();
  readonly lights = new Set<SourceLight>();
  private dirtyLights = new Set<SourceLight>();
  private readonly shadowLights = new Set<ShadowLight>();
  private readonly shadowInputs = new WeakMap<object, WeakRef<ShadowLight> | null>();
  private shadowCasters: { view: number; channels: number } | undefined;
  private shadowViewChannels = 1;
  projectingShadow: ShadowLight | undefined;
  private readonly targets = new Map<Object3D, Set<SourceLight>>();
  private readonly ambient = new Set<AmbientLight>();
  private ambientSum: [number, number, number] | undefined;
  private lightMask: number | undefined;
  private readonly perView = new Set<Object3D>();
  private readonly residualEdges = new Map<Object3D, Set<Object3D>>();
  private readonly residualPaths = new Map<Object3D, Object3D[]>();
  private readonly dirtyResidualParents = new Set<Object3D>();
  /** Publish affected sibling rosters in source order for callbacks and LOD. */
  residualChildren(): ReadonlyMap<Object3D, Object3D[]> {
    for (const parent of this.dirtyResidualParents) {
      const required = this.residualEdges.get(parent);
      if (!required) {
        this.residualPaths.delete(parent);
        continue;
      }
      const children = [...required];
      if (children.length > 1) this.orderChildren(parent, children);
      this.rosterEntries += children.length;
      this.residualPaths.set(parent, children);
    }
    this.dirtyResidualParents.clear();
    return this.residualPaths;
  }

  /** A parent edge exists while the child or any descendant needs view work. */
  private setPerView(node: Object3D, required: boolean): void {
    const previous = this.perView.has(node);
    if (previous === required) return;
    if (required) this.perView.add(node);
    else this.perView.delete(node);
    if (this.residualEdges.has(node)) return;
    for (
      let child = node, parent = this.parents.get(child);
      parent;
      parent = this.parents.get(child)
    ) {
      let edges = this.residualEdges.get(parent);
      const hadChildren = edges !== undefined;
      if (required) {
        if (!edges) {
          edges = new Set();
          this.residualEdges.set(parent, edges);
        }
        edges.add(child);
      } else if (edges) {
        edges.delete(child);
        if (!edges.size) this.residualEdges.delete(parent);
      }
      this.dirtyResidualParents.add(parent);
      if (hadChildren === this.residualEdges.has(parent) || this.perView.has(parent)) break;
      child = parent;
    }
  }
  get hasResiduals(): boolean {
    return this.perView.size > 0;
  }
  private viewChanged = true;
  private readonly lastView: (number | undefined)[] = [];
  cameraMoved = true;
  cameraBasisMoved = true;
  spriteViewChanged = true;
  readonly retainedSprites = new Set<Sprite>();
  readonly spritePoses = new Set<Sprite>();
  readonly spriteVisibility = new Set<Sprite>();
  readonly viewDraws = new Map<
    Draw,
    {
      blended: boolean;
      rank: number;
      live: boolean;
      depth: number | undefined;
      zoom: number;
      perspective: number;
      pixelRatio: number;
      republishPointContent: boolean;
    }
  >();
  readonly residents = new Set<Object3D>();
  readonly nodeState = new Map<Object3D, NodeStateFields>();
  readonly unobservedNodeState = new Set<Object3D>();
  readonly dynamicMatrices = new Set<Object3D>();
  private readonly resolvedLocal = new Map<Object3D, number>();

  /** Only stock updates can attest that the observed world matrix came from local TRS. */
  resolvedLocalVersion(node: Object3D): number | undefined {
    return this.pose.has(node) ? undefined : this.resolvedLocal.get(node);
  }
  readonly geometry = new Map<BufferGeometry, Set<Draw>>();
  changedGeometry = new Map<BufferGeometry, PointContentChannels>();
  readonly textures = new Map<Texture, Set<Material>>();
  readonly members = new Set<Object3D>();
  readonly invalidate = () => {
    this.invalid = true;
  };
  invalid = false;
  constructor(
    readonly root: Object3D,
    readonly settings: readonly unknown[],
    initialMask: number,
    readonly unclipped?: Object3D,
    private readonly ecsPoses = false,
    private readonly nativeTransparentOrder = false,
  ) {
    this.lightMask = initialMask;
  }

  private scope<T>(owner: object, run: () => T, scopes = this.scopes): T {
    const previous = this.cleanups;
    let list = scopes.get(owner);
    if (!list) {
      list = [];
      scopes.set(owner, list);
    }
    this.cleanups = list;
    try {
      return run();
    } finally {
      this.cleanups = previous;
    }
  }

  hold(release: Notify | undefined): void {
    if (release) this.cleanups.push(release);
  }

  private release(owner: object): void {
    const list = this.scopes.get(owner);
    this.scopes.delete(owner);
    if (list) releaseFrom(list);
  }

  watch(object: object, key: string, notify: Notify, inherited = false): boolean {
    const hierarchy = watchSourceHierarchy(object, key, notify);
    if (hierarchy) {
      this.hold(hierarchy);
      return true;
    }
    if (!observeField(object, key, notify, inherited)) return false;
    this.cleanups.push(key, object, notify);
    return true;
  }

  fields(
    object: object,
    notify: Notify,
    keys: readonly string[] = Object.keys(object),
    inherited = false,
  ): boolean {
    let count = 0;
    for (const key of keys) {
      if (!observeField(object, key, notify, inherited)) break;
      count++;
    }
    if (count)
      this.cleanups.push(count === keys.length ? keys : keys.slice(0, count), object, notify);
    return count === keys.length;
  }

  /** A foreign collection assigned to a tracked input keeps its original identity and aliases. */
  private probe(check: Notify): void {
    this.probes.add(check);
    this.hold(() => this.probes.delete(check));
  }

  private observeLod(lod: LOD): void {
    if (!ownsCollection(lod.levels) || lod.update !== LOD.prototype.update) return;
    let lastDistance = NaN,
      lastLevel = -1,
      settled = false,
      evaluating = false;
    const dirty = () => {
      if (!evaluating) {
        settled = false;
        lastDistance = NaN;
      }
    };
    const layout = () => {
      this.lodUpdates.delete(lod);
      this.structural.add(lod);
    };
    this.hold(watchCollection(lod.levels, layout));
    if (
      !this.watch(lod, 'update', layout, true) ||
      !this.watch(lod, 'autoUpdate', dirty) ||
      !this.watch(lod, '_currentLevel', dirty)
    )
      return;
    for (const entry of lod.levels) {
      if (
        !this.fields(entry, dirty, ['distance', 'hysteresis']) ||
        !this.watch(entry, 'object', layout) ||
        !this.watch(entry.object, 'visible', dirty)
      )
        return;
    }
    this.lodUpdates.set(lod, (camera) => {
      const a = sourceCollectionStorage(lod.matrixWorld.elements),
        b = sourceCollectionStorage(camera.matrixWorld.elements);
      const x = a[12] - b[12],
        y = a[13] - b[13],
        z = a[14] - b[14];
      const distance =
        Math.sqrt(x * x + y * y + z * z) / ('zoom' in camera ? Number(camera.zoom) : NaN);
      if (settled && Object.is(distance, lastDistance)) return;
      evaluating = true;
      try {
        lod.update(camera);
      } finally {
        evaluating = false;
      }
      const level = lod.getCurrentLevel();
      settled = Object.is(distance, lastDistance) && level === lastLevel;
      lastDistance = distance;
      lastLevel = level;
    });
    this.hold(() => this.lodUpdates.delete(lod));
  }

  private readonly skeletons = new Map<Skeleton, SkeletonChanges>();
  private readonly skinCursors = new WeakMap<SkinnedMesh, SkinCursor>();
  readonly stockSkins = new Set<SkinnedMesh>();

  skinCursor(mesh: SkinnedMesh): SkinCursor | undefined {
    if (!this.members.has(mesh) || !mesh.skeleton) return;
    let cursor = this.skinCursors.get(mesh);
    if (cursor && cursor.owner.source !== mesh.skeleton) return;
    if (!cursor) {
      const source = mesh.skeleton;
      let owner = this.skeletons.get(source);
      if (!owner) {
        owner = new SkeletonChanges(source);
        this.skeletons.set(source, owner);
      }
      cursor = { owner, dirty: new Set(), work: this };
      const entry = cursor;
      owner.users.add(entry);
      this.skinCursors.set(mesh, entry);
      this.scope(mesh, () =>
        this.hold(() => {
          this.skinCursors.delete(mesh);
          owner.users.delete(entry);
          if (!owner.users.size) {
            owner.dispose();
            this.skeletons.delete(source);
          }
        }),
      );
    }
    cursor.owner.refresh();
    return cursor;
  }

  registerNode(node: Object3D): void {
    this.members.add(node);
    if (this.ecsPoses) {
      this.pose.add(node);
      this.poseTopology.add(node);
      if (separateDrawPose(node)) this.watchDrawPose(node);
    }
    if (node instanceof LOD) this.observeLod(node);
    if (
      node.renderOrder !== 0 &&
      (!localTransparentOrder(node) ||
        !this.watch(node, 'material', this.invalidate) ||
        !this.watch(node.material, 'transparent', this.invalidate))
    )
      this.invalid = true;
    if (node instanceof ClippingGroup && !this.unclipped) this.invalid = true;
    const parent = node.parent;
    this.parents.set(node, parent);
    if (parent) {
      let children = this.enrolledChildren.get(parent);
      if (!children) {
        children = new Set();
        this.enrolledChildren.set(parent, children);
      }
      children.add(node);
    }
    const roster = () => {
      this.childOrder.delete(node);
      this.rosters.add(node);
    };
    const children = watchCollection(node.children, (edit, child) => {
      const tail = this.deletedTail.get(node);
      if (tail) {
        this.deletedTail.delete(node);
        if (edit === 'shrink-one') {
          this.childOrder.get(node)?.delete(tail);
          this.removed.set(tail, node);
          return;
        }
        roster();
      }
      if (edit === 'delete-tail' && child instanceof Object3D) {
        this.deletedTail.set(node, child);
        return;
      }
      if (edit === 'unchanged-length') return;
      if (edit === 'append' && child instanceof Object3D && !this.appended.has(child)) {
        this.childOrder.get(node)?.set(child, node.children.length - 1);
        this.appended.set(child, node);
      } else roster();
    });
    if (children) this.hold(children);
    else {
      let snapshot = node.children.slice();
      this.probe(() => {
        if (
          snapshot.length !== node.children.length ||
          !snapshot.every((v, i) => v === node.children[i])
        ) {
          snapshot = node.children.slice();
          roster();
        }
      });
    }
    this.watch(node, 'children', this.invalidate);
    const branch = () => this.structural.add(node);
    this.watchSourceTransform(node, branch);
    const markNodeState = (bits: NodeStateFields) =>
      this.nodeState.set(node, (this.nodeState.get(node) ?? 0) | bits);
    const draw =
      node instanceof Mesh ||
      node instanceof Line ||
      node instanceof Points ||
      node instanceof Sprite;
    const nameObserved = this.watch(node, 'name', () => markNodeState(NodeStateFields.Name));
    const shadowObserved =
      !draw ||
      this.fields(node, () => markNodeState(NodeStateFields.Shadow), [
        'castShadow',
        'receiveShadow',
      ]);
    if (!nameObserved || !shadowObserved) this.unobservedNodeState.add(node);
    const layerStateChanged = () => {
      if (draw) markNodeState(NodeStateFields.Shadow);
    };
    const replaceLayers = () => {
      layerStateChanged();
      branch();
    };
    const layerMaskChanged = () => {
      layerStateChanged();
      if (draw) this.invalidateBinding(node);
      else branch();
    };
    // LOD children are already evaluated on the residual path after LOD.update().
    const visibility = () => {
      if (node instanceof Sprite && node.children.length === 0 && this.retainedSprites.has(node))
        this.spriteVisibility.add(node);
      else if (draw && node.children.length === 0) this.invalidateBinding(node);
      else if (this.ecsPoses) this.visibilityBranches.add(node);
      else branch();
    };
    if (!(node.parent instanceof LOD) && !this.watch(node, 'visible', visibility))
      this.invalid = true;
    if (!this.watch(node, 'renderOrder', this.invalidate)) this.invalid = true;
    if (
      !this.watch(node, 'layers', replaceLayers) ||
      !this.watch(node.layers, 'mask', layerMaskChanged)
    )
      this.invalid = true;
  }

  private watchSourceTransform(node: Object3D, structural: Notify): void {
    let synchronous: ReturnType<typeof bindSourceWorldPose> | undefined;
    let observedAddress: number | undefined;
    const enqueuePose = () => {
      observedAddress = this.pose.add(node, observedAddress);
    };
    const queuePose = () => {
      if (!this.ecsPoses) {
        this.translations.delete(node);
        this.resolvedLocal.delete(node);
      }
      enqueuePose();
    };
    const nativePoseChanged = () => {
      synchronous?.transform.invalidateLocal();
      enqueuePose();
    };
    const poseChanged = this.ecsPoses
      ? nativePoseChanged
      : () => {
          synchronous?.transform.invalidateLocal();
          queuePose();
        };
    const translated = this.ecsPoses
      ? nativePoseChanged
      : () => {
          if (synchronous !== undefined) {
            synchronous.transform.invalidateLocal();
            this.resolvedLocal.delete(node);
          }
          if (!this.pose.has(node)) this.translations.add(node);
          enqueuePose();
        };
    const repairMatrix = (matrix: 'local' | 'world') => {
      if (this.ecsPoses) {
        const repairs = this.pose.matrixRepairs;
        if (matrix === 'local') {
          enqueuePose();
          repairs.set(node, matrix);
        } else if (!repairs.has(node)) repairs.set(node, matrix);
      } else {
        queuePose();
        this.projectedPose.add(node);
      }
    };
    const revoke = () => {
      synchronous?.release();
      synchronous = undefined;
    };
    const branch = () => {
      revoke();
      structural();
    };
    const invalidateMatrix = () => {
      revoke();
      this.invalidate();
    };
    const localStorageObserved = this.watchSourceMatrix(
      node.matrix,
      () => {
        synchronous?.transform.invalidateLocal();
        repairMatrix('local');
      },
      branch,
    );
    const worldStorageObserved = this.watchSourceMatrix(
      node.matrixWorld,
      () => {
        synchronous?.transform.replaceWorld();
        repairMatrix('world');
      },
      branch,
    );
    const localObserved = this.watch(node, 'matrix', invalidateMatrix);
    const worldObserved = this.watch(node, 'matrixWorld', invalidateMatrix);
    if (
      this.observeStockPose(node, branch, translated, poseChanged) &&
      localObserved &&
      worldObserved &&
      localStorageObserved &&
      worldStorageObserved &&
      this.hasObservablePoseStorage(node, branch)
    ) {
      synchronous = bindSourceWorldPose(
        node,
        SynchronousTransform,
        this.ecsPoses
          ? undefined
          : () => {
              this.projectedPose.add(node);
              if (!this.resolvedLocal.has(node)) this.resolvedLocal.set(node, ++localPoseVersion);
            },
      );
      enqueuePose();
      this.hold(revoke);
    }
  }

  private observeStockPose(
    node: Object3D,
    branch: Notify,
    translated: Notify,
    poseChanged: Notify,
  ): boolean {
    if (this.ecsPoses && !this.watch(node, 'parent', branch)) this.invalid = true;
    const stockSkin = this.observeSkinPose(node, branch);
    const stockCamera =
      node instanceof Camera && node.updateMatrixWorld === Camera.prototype.updateMatrixWorld;
    const stock =
      (stockSkin ||
        stockCamera ||
        node.updateMatrixWorld === Object3D.prototype.updateMatrixWorld) &&
      stockAutomaticPose(node) &&
      observePose(node.position, node.scale, node.quaternion, translated, poseChanged, (release) =>
        this.hold(release),
      );
    if (stockSkin && (stock || this.ecsPoses)) this.stockSkins.add(node);
    const watchedMethods = this.fields(node, branch, matrixMethods, true);
    if (!stock || stockCamera || !watchedMethods) this.dynamicMatrices.add(node);
    if (this.ecsPoses && (!stock || !watchedMethods)) {
      this.unobservedNativePoses.add(node);
      this.hold(() => this.unobservedNativePoses.delete(node));
    }
    const watchedMode = this.fields(node, branch, branchFields);
    if (!watchedMode) this.invalid = true;
    return stock && watchedMethods && watchedMode;
  }

  private observeSkinPose(node: Object3D, branch: Notify): node is SkinnedMesh {
    if (!(node instanceof SkinnedMesh)) return false;
    this.watch(node, 'skeleton', branch);
    this.watch(node, 'bindMode', branch);
    return (
      node.updateMatrixWorld === SkinnedMesh.prototype.updateMatrixWorld &&
      (node.bindMode === AttachedBindMode || node.bindMode === DetachedBindMode)
    );
  }

  private hasObservablePoseStorage(node: Object3D, branch: Notify): boolean {
    return (
      (node instanceof Bone ||
        node instanceof Group ||
        node instanceof Scene ||
        Object.getPrototypeOf(node) === Object3D.prototype ||
        Object.getPrototypeOf(node) === Mesh.prototype ||
        this.stockSkins.has(node as SkinnedMesh)) &&
      ownsCollection(node.matrix.elements) &&
      ownsCollection(node.matrixWorld.elements) &&
      node.matrix.compose === Matrix4.prototype.compose &&
      node.matrixWorld.copy === Matrix4.prototype.copy &&
      node.matrixWorld.multiplyMatrices === Matrix4.prototype.multiplyMatrices &&
      this.watch(node.matrix, 'compose', branch, true) &&
      this.watch(node.matrixWorld, 'copy', branch, true) &&
      this.watch(node.matrixWorld, 'multiplyMatrices', branch, true)
    );
  }

  private watchSourceMatrix(matrix: Matrix4, changed: Notify, branch: Notify): boolean {
    const off = watchCollection(matrix.elements, changed);
    if (off) this.hold(off);
    else this.watchForeignInput(matrix, () => matrix.elements, changed);
    return this.watch(matrix, 'elements', branch);
  }

  /** Keep only paths reaching source objects that need ordinary per-view preparation. */
  index(
    node: Object3D,
    canSkip: AdmitNode,
    ancestry: ViewAncestry = 'ordinary',
    rebind = false,
  ): boolean {
    const entering = !this.members.has(node);
    if (entering) this.scope(node, () => this.registerNode(node));
    else if (rebind) this.releaseBinding(node);
    let retained: Object3D[] | undefined;
    const descendants = childViewAncestry(node, ancestry);
    for (const child of node.children) {
      if (!this.index(child, canSkip, descendants, rebind)) continue;
      retained ??= [];
      retained.push(child);
    }
    if (retained) this.children.set(node, retained);
    else this.children.delete(node);
    if (this.residualEdges.has(node)) this.dirtyResidualParents.add(node);
    const resident = this.admitBinding(node, canSkip, ancestry);
    if (entering) {
      compactFieldRow(node);
      const scope = this.scopes.get(node);
      if (scope) this.scopes.set(node, scope.slice());
      const binding = this.bindingScopes.get(node);
      if (binding) this.bindingScopes.set(node, binding.slice());
    }
    return !resident || retained !== undefined;
  }

  private admitBinding(node: Object3D, canSkip: AdmitNode, ancestry: ViewAncestry): boolean {
    const inherited = ancestry === 'ordinary';
    const safe = inherited && node.visible && node.renderOrder === 0;
    const orderedLeaf =
      inherited &&
      this.nativeTransparentOrder &&
      node.renderOrder !== 0 &&
      node.children.length === 0 &&
      localTransparentOrder(node);
    // Dormant draws still publish visibility transitions before promotion. LOD controls
    // its direct children during traversal, so those children retain the ordinary path.
    const dormant = inherited && !node.visible && node.renderOrder === 0;
    const resident =
      this.residents.has(node) ||
      ((safe || dormant || orderedLeaf || ancestry === 'hidden') &&
        !this.hasViewBinding(node) &&
        !this.dynamicMatrices.has(node) &&
        this.scope(
          node,
          () => {
            const start = this.cleanups.length;
            const kind = canSkip(node, ancestry === 'hidden');
            if (kind === 'view') return false;
            if (kind) return true;
            releaseFrom(this.cleanups, start);
            return false;
          },
          this.bindingScopes,
        ));
    if (resident) this.residents.add(node);
    if (this.bindingScopes.get(node)?.length === 0) this.bindingScopes.delete(node);
    this.setPerView(node, node !== this.root && !resident && !this.hasViewBinding(node));
    return resident;
  }

  private hasViewBinding(node: Object3D): boolean {
    return (
      this.viewDraws.has(node as Draw) || (node instanceof Sprite && this.retainedSprites.has(node))
    );
  }

  private inside(node: Object3D): boolean {
    for (let cursor: Object3D | null = node; cursor; cursor = cursor.parent)
      if (cursor === this.root) return true;
    return false;
  }

  private detach(node: Object3D): void {
    if (!this.members.delete(node)) return;
    for (const child of this.enrolledChildren.get(node) ?? []) this.detach(child);
    this.setPerView(node, false);
    this.enrolledChildren.delete(node);
    this.childOrder.delete(node);
    const old = this.parents.get(node);
    if (old) this.enrolledChildren.get(old)?.delete(node);
    this.parents.delete(node);
    this.children.delete(node);
    if (node instanceof SkinnedMesh) this.stockSkins.delete(node);
    this.dynamicMatrices.delete(node);
    this.unobservedNodeState.delete(node);
    this.resolvedLocal.delete(node);
    this.projectedPose.delete(node);
    this.pose.delete(node);
    this.poseTopology.delete(node);
    this.translations.delete(node);
    this.releaseBinding(node);
    this.residualPaths.delete(node);
    this.dirtyResidualParents.delete(node);
    this.viewChanged = true;
    this.retired.add(node);
    this.release(node);
  }

  private releaseBinding(node: Object3D): void {
    const scope = this.bindingScopes.get(node);
    this.bindingScopes.delete(node);
    if (scope) releaseFrom(scope);
    this.residents.delete(node);
    this.viewDraws.delete(node as Draw);
    if (node instanceof Sprite) {
      this.retainedSprites.delete(node);
      this.spritePoses.delete(node);
      this.spriteVisibility.delete(node);
    }
  }

  invalidateBinding(node: Object3D): void {
    this.dirtyBindings.add(node);
  }

  promoteBinding(node: Object3D): void {
    if (!this.admitted.has(node)) this.admitted.set(node, 'binding');
  }

  private childPositions(parent: Object3D): ReadonlyMap<Object3D, number> {
    const known = this.childOrder.get(parent);
    if (known !== undefined) return known;
    const order = new Map<Object3D, number>();
    this.rosterEntries += parent.children.length;
    parent.children.forEach((child, index) => {
      order.set(child, index);
    });
    this.childOrder.set(parent, order);
    return order;
  }

  private orderChildren(parent: Object3D, children: Object3D[]): void {
    const order = this.childPositions(parent);
    const position = (child: Object3D) => order.get(child) ?? Number.MAX_SAFE_INTEGER;
    children.sort((a, b) => position(a) - position(b));
  }

  private refreshChild(parent: Object3D, child: Object3D): void {
    if (!this.members.has(parent)) return;
    const before = this.children.get(parent);
    const include =
      child.parent === parent &&
      this.members.has(child) &&
      (!this.residents.has(child) || this.children.has(child));
    const index = before?.indexOf(child) ?? -1;
    if (include === index >= 0) return;
    if (this.residualEdges.has(parent)) this.dirtyResidualParents.add(parent);
    if (include && before) {
      // Appended source children follow every existing residual child.
      if (parent.children[parent.children.length - 1] === child) before.push(child);
      else {
        const order = this.childPositions(parent);
        const position = order.get(child);
        if (position === undefined) {
          this.invalid = true;
          return;
        }
        let low = 0;
        let high = before.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if ((order.get(before[middle] as Object3D) ?? Number.MAX_SAFE_INTEGER) < position)
            low = middle + 1;
          else high = middle;
        }
        before.splice(low, 0, child);
      }
      return;
    }
    if (include) this.children.set(parent, [child]);
    else if (before && before.length > 1) before.splice(index, 1);
    else this.children.delete(parent);
    if (
      Boolean(before) !== this.children.has(parent) &&
      this.residents.has(parent) &&
      parent.parent
    )
      this.refreshChild(parent.parent, parent);
  }

  reconcile(): void {
    this.checkedInputs += this.foreignInputs.size + this.probes.size;
    for (const input of this.foreignInputs.values()) input.sample();
    for (const check of this.probes) check();
    for (const parent of this.deletedTail.keys()) this.rosters.add(parent);
    this.deletedTail.clear();
    for (const [child, parent] of this.removed) {
      if (child.parent === parent) this.rosters.add(parent);
      else this.structural.add(child);
    }
    this.removed.clear();
    for (const [child, parent] of this.appended) {
      if (this.rosters.has(parent)) continue;
      if (child.parent !== parent || this.parents.get(child) === parent) this.rosters.add(parent);
      else this.structural.add(child);
    }
    this.appended.clear();
    for (const parent of this.rosters) {
      const old = this.enrolledChildren.get(parent);
      this.childOrder.delete(parent);
      this.rosterEntries += parent.children.length;
      const current = new Set(parent.children);
      if (
        current.size !== parent.children.length ||
        parent.children.some((child) => child.parent !== parent)
      ) {
        this.invalid = true;
        continue;
      }
      for (const node of old ?? [])
        if (!current.has(node)) {
          if (node.parent === parent) this.invalid = true;
          this.structural.add(node);
        }
      for (const node of current) if (!old?.has(node)) this.structural.add(node);
      // A direct reorder changes stable transparent/custom-comparator tie order.
      const children = this.children.get(parent);
      if (children) {
        if (children.length > 1) this.orderChildren(parent, children);
        this.viewChanged = true;
      }
      if (this.residualEdges.has(parent)) this.dirtyResidualParents.add(parent);
    }
    this.rosters.clear();
    for (const material of this.materials) this.reconcileMaterialDraws(material);
    for (const material of this.materialEdits.keys()) this.reconcileMaterialDraws(material);
    for (const geometry of this.changedGeometry.keys())
      for (const mesh of this.geometry.get(geometry) ?? []) {
        const draw = this.viewDraws.get(mesh);
        if (draw && !draw.republishPointContent) this.invalidateBinding(mesh);
      }
    if (this.layouts.size) {
      for (const source of this.layouts) {
        if (source instanceof Texture) {
          for (const material of this.textures.get(source) ?? []) this.layouts.add(material);
        } else if (source instanceof Material) {
          for (const use of this.uses.get(source)?.values() ?? [])
            for (const mesh of use.meshes) this.invalidateBinding(mesh);
        } else for (const mesh of this.geometry.get(source) ?? []) this.invalidateBinding(mesh);
      }
      this.layouts.clear();
    }
    if (!this.structural.size && !this.dirtyBindings.size && !this.visibilityBranches.size) return;
    this.viewChanged = true;
    if (this.structural.size) this.reconcileBranches();
    // A visibility change revises draw demand for the subtree. The source hierarchy,
    // field subscriptions and pending local poses remain live throughout that change.
    for (const node of this.visibilityBranches) {
      if (!this.members.has(node)) continue;
      let parent = node.parent;
      while (parent && !this.visibilityBranches.has(parent)) parent = parent.parent;
      if (parent) continue;
      this.index(node, () => false, 'ordinary', true);
      this.admitted.set(node, 'branch');
      if (node.parent) this.refreshChild(node.parent, node);
    }
    this.visibilityBranches.clear();
    this.reconcileBindings();
  }

  reconcileBindings(): void {
    if (this.dirtyBindings.size === 0) return;
    this.viewChanged = true;
    for (const node of this.dirtyBindings) {
      if (!this.members.has(node)) continue;
      this.releaseBinding(node);
      this.setPerView(node, true);
      this.promoteBinding(node);
      if (node.parent) this.refreshChild(node.parent, node);
    }
    this.dirtyBindings.clear();
  }

  private reconcileBranches(): void {
    const changed = new Set(this.structural);
    this.structural.clear();
    const previous = new Map<Object3D, Object3D>();
    for (const node of changed) {
      const old = this.parents.get(node);
      if (old) previous.set(node, old);
      this.detach(node);
    }
    for (const node of changed) {
      if (!this.inside(node) || this.members.has(node)) continue;
      let ancestor = node.parent;
      while (ancestor && !changed.has(ancestor)) ancestor = ancestor.parent;
      if (ancestor) continue;
      this.index(node, () => false);
      this.admitted.set(node, 'branch');
      this.pose.add(node);
    }
    for (const node of changed) {
      const old = previous.get(node);
      if (old && old !== node.parent) this.refreshChild(old, node);
      if (node.parent) this.refreshChild(node.parent, node);
    }
  }

  promote(canSkip: AdmitNode): void {
    for (const [node, kind] of this.admitted) {
      if (!this.members.has(node)) continue;
      let ancestry: ViewAncestry = 'ordinary';
      for (let p = node.parent; p && ancestry !== 'hidden'; p = p.parent)
        ancestry = childViewAncestry(p, ancestry);
      if (kind === 'branch') this.index(node, canSkip, ancestry);
      else this.admitBinding(node, canSkip, ancestry);
      if (node.parent) this.refreshChild(node.parent, node);
    }
    if (this.admitted.size) this.viewChanged = true;
    this.admitted.clear();
    this.retired.clear();
  }

  updateMatrices(camera: Camera): void {
    // Detached cameras have their own r187 view-cache update, including inverse scale stripping.
    if (this.root.matrixWorldAutoUpdate) {
      const roots = this.pose;
      this.pose = this.sparePose;
      this.sparePose = roots;
      for (const node of this.dynamicMatrices) roots.add(node);
      // An overridden matrix callback can read a sibling skin's bind state.
      // Delegate the full r187 skin update whenever such callbacks are active.
      if (this.dynamicMatrices.size) for (const mesh of this.stockSkins) roots.add(mesh);
      for (const root of roots) {
        let parent = root.parent;
        while (parent && !roots.has(parent)) parent = parent.parent;
        if (parent) continue;
        if (!this.translations.has(root) || !this.updateLeafTranslation(root))
          this.updateBranch(root, true);
      }
      roots.release();
      this.translations.clear();
      if (!this.dynamicMatrices.size)
        for (const mesh of this.stockSkins)
          mesh.bindMatrixInverse
            .copy(mesh.bindMode === AttachedBindMode ? mesh.matrixWorld : mesh.bindMatrix)
            .invert();
    }
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
  }

  /** All other local components and the parent's world basis are already current. */
  private updateLeafTranslation(node: Object3D): boolean {
    if (
      node.children.length ||
      (node instanceof SkinnedMesh && this.dynamicMatrices.size > 0) ||
      this.dynamicMatrices.has(node) ||
      !ownsCollection(node.matrix.elements) ||
      !ownsCollection(node.matrixWorld.elements) ||
      node.matrix.compose !== Matrix4.prototype.compose ||
      node.matrixWorld.multiplyMatrices !== Matrix4.prototype.multiplyMatrices ||
      node.matrixWorld.copy !== Matrix4.prototype.copy
    )
      return false;
    if (resolveSourceWorldPose(node)) return true;
    const local = sourceCollectionStorage(node.matrix.elements),
      world = sourceCollectionStorage(node.matrixWorld.elements);
    const { x, y, z } = node.position;
    local[12] = x;
    local[13] = y;
    local[14] = z;
    if (node.parent) {
      const p = sourceCollectionStorage(node.parent.matrixWorld.elements);
      world[12] = p[0] * x + p[4] * y + p[8] * z + p[12];
      world[13] = p[1] * x + p[5] * y + p[9] * z + p[13];
      world[14] = p[2] * x + p[6] * y + p[10] * z + p[14];
      world[15] = p[3] * x + p[7] * y + p[11] * z + p[15];
    } else {
      world[12] = x;
      world[13] = y;
      world[14] = z;
    }
    if (this.resolvedLocal.has(node)) this.resolvedLocal.set(node, ++localPoseVersion);
    publishWorldMatrix(node.matrixWorld.elements);
    node.matrixWorldNeedsUpdate = false;
    this.projectedPose.add(node);
    return true;
  }

  private updateBranch(node: Object3D, force: boolean): void {
    if (
      node.updateMatrixWorld !== Object3D.prototype.updateMatrixWorld &&
      !(node instanceof SkinnedMesh && this.stockSkins.has(node) && !this.dynamicMatrices.size)
    ) {
      node.updateMatrixWorld(force);
      node.traverse((child) => {
        this.resolvedLocal.delete(child);
        this.projectedPose.add(child);
      });
      return;
    }
    const descend = resolveSourceWorldPose(node) || this.updateSourceMatrix(node, force);
    for (const child of node.children) this.updateBranch(child, descend);
  }

  private updateSourceMatrix(node: Object3D, force: boolean): boolean {
    // r187 Object3D.updateMatrixWorld, with dirty publication in the same traversal.
    const stockLocal =
      !this.dynamicMatrices.has(node) &&
      node.matrixAutoUpdate &&
      node.matrix.compose === Matrix4.prototype.compose;
    const reuseLocal = stockLocal && this.resolvedLocal.has(node) && !this.sparePose.has(node);
    if (node.matrixAutoUpdate) {
      if (stockLocal) {
        if (!reuseLocal) {
          this.output.elements = sourceCollectionStorage(node.matrix.elements);
          this.output.compose(node.position, node.quaternion, node.scale);
          this.output.elements = this.scratchElements;
        }
        node.matrixWorldNeedsUpdate = true;
      } else node.updateMatrix();
    }
    if (node.matrixWorldNeedsUpdate || force) {
      if (node.matrixWorldAutoUpdate) {
        const world = node.matrixWorld;
        const stock =
          world.copy === Matrix4.prototype.copy &&
          world.multiplyMatrices === Matrix4.prototype.multiplyMatrices;
        if (stock) {
          this.output.elements = sourceCollectionStorage(world.elements);
          this.right.elements = sourceCollectionStorage(node.matrix.elements);
          if (node.parent) {
            this.left.elements = sourceCollectionStorage(node.parent.matrixWorld.elements);
            this.output.multiplyMatrices(this.left, this.right);
          } else this.output.copy(this.right);
          this.output.elements = this.scratchElements;
          publishWorldMatrix(world.elements);
          if (!stockLocal) this.resolvedLocal.delete(node);
          else if (!reuseLocal) this.resolvedLocal.set(node, ++localPoseVersion);
        } else {
          this.resolvedLocal.delete(node);
          if (node.parent) world.multiplyMatrices(node.parent.matrixWorld, node.matrix);
          else world.copy(node.matrix);
        }
      } else this.resolvedLocal.delete(node);
      node.matrixWorldNeedsUpdate = false;
      force = true;
    }
    this.projectedPose.add(node);
    return force;
  }

  private reconcileMaterialDraws(material: Material): void {
    for (const use of this.uses.get(material)?.values() ?? [])
      if (use.view && !use.direct) for (const mesh of use.meshes) this.invalidateBinding(mesh);
  }

  private watchColor(material: Material, key: string, parameter: Notify, layout: Notify): boolean {
    let release: Notify[] = [];
    const clear = () => {
      for (const off of release) off();
      release = [];
    };
    const bind = () => {
      clear();
      const color = ownSourceValue(material, key);
      if (!(color instanceof Color) || Object.getPrototypeOf(color) !== Color.prototype)
        return false;
      for (const channel of ['r', 'g', 'b']) {
        const off = subscribe(color, channel, parameter);
        if (!off) {
          clear();
          return false;
        }
        release.push(off);
      }
      return true;
    };
    this.hold(clear);
    return (
      bind() &&
      this.watch(material, key, () => {
        if (bind()) parameter();
        else layout();
      })
    );
  }

  private watchMaterial(material: Material): boolean {
    if (this.uses.has(material)) return true;
    const ok = this.scope(material, () => this.materialFields(material));
    if (!ok) this.release(material);
    return ok;
  }
  private observeMaterialHooks(
    material: Material,
    layout: Notify,
    edit: (parameter: number | StockMaterialEdit) => void,
    plainNode: boolean,
    cooked: boolean,
  ): boolean {
    if (
      !this.watch(material, 'onBeforeCompile', layout, true) ||
      !this.watch(material, 'onBeforeRender', layout, true)
    )
      return false;
    if (
      (plainNode || cooked) &&
      !watchNodeMaterialHooks(material, (key) => this.watch(material, key, layout, true))
    )
      return false;
    if (plainNode && !this.fields(material, layout, NODE_MATERIAL_INPUTS, true)) return false;
    if (cooked) {
      if (
        !watchThreeSurfaceInputs(
          material,
          (source, key, notify) => this.watch(source, key, notify),
          layout,
          edit,
          (texture) => this.watchTexture(texture, material),
        )
      )
        return false;
    }
    return true;
  }

  private materialFields(material: Material): boolean {
    const layout = () => this.layouts.add(material);
    const parameter = () => this.materials.add(material);
    const prototype = Object.getPrototypeOf(material);
    const sprite = prototype === SpriteMaterial.prototype;
    const cooked = hasSurfaceBinding(material);
    const plainNode = !cooked && plainNodeMaterial(material);
    const stock =
      !cooked &&
      (sprite ||
        plainNode ||
        prototype === MeshBasicMaterial.prototype ||
        prototype === MeshStandardMaterial.prototype);
    const edit = (parameter: number | StockMaterialEdit) => {
      let dirty = this.materialEdits.get(material);
      if (!dirty) {
        dirty = new Set();
        this.materialEdits.set(material, dirty);
      }
      dirty.add(parameter);
    };
    if (!this.observeMaterialHooks(material, layout, edit, plainNode, cooked)) return false;
    for (const key of Object.keys(material)) {
      if (['id', 'uuid', 'type', 'userData', 'name', '_listeners', 'defines'].includes(key))
        continue;
      if (plainNode && NODE_MATERIAL_INPUTS.some((field) => field === key)) continue;
      if (sprite && (key === 'rotation' || key === 'sizeAttenuation')) {
        if (
          !this.watch(material, key, () => {
            for (const use of this.uses.get(material)?.values() ?? [])
              for (const mesh of use.meshes) if (mesh instanceof Sprite) this.spritePoses.add(mesh);
          })
        )
          return false;
        continue;
      }
      const value = ownSourceValue(material, key);
      if (cooked && boundSurfaceRoot(material, key)) {
        if (!this.watch(material, key, layout)) return false;
        continue;
      }
      if (value instanceof Color) {
        if (!cooked && (key === 'color' || key === 'emissive')) {
          if (
            !this.watchColor(
              material,
              key,
              stock ? () => edit(key === 'color' ? 'baseColor' : 'emissive') : parameter,
              layout,
            )
          )
            return false;
          continue;
        }
        if (!this.fields(value, layout, ['r', 'g', 'b'])) return false;
      } else if (value instanceof Texture) {
        if (!this.watchTexture(value, material)) return false;
      } else if (value instanceof Euler) {
        if (!this.fields(value, layout, ['_x', '_y', '_z', '_order'])) return false;
      } else if (value instanceof Vector2 || value instanceof Vector3) {
        if (!this.fields(value, layout)) return false;
      } else if (key === 'iridescenceThicknessRange' && Array.isArray(value))
        this.watchSequence(value, layout);
      else if (typeof value === 'object' && value !== null) return false;
      const valueField =
        key === 'opacity'
          ? 'baseColor'
          : key === 'metalness'
            ? 'metallic'
            : key === 'roughness' || key === 'emissiveIntensity'
              ? key
              : undefined;
      const notify =
        !cooked && valueField !== undefined ? (stock ? () => edit(valueField) : parameter) : layout;
      if (!this.watch(material, key, notify)) return false;
    }
    material.addEventListener('dispose', layout);
    this.cleanups.push(() => material.removeEventListener('dispose', layout));
    this.uses.set(material, new Map());
    return true;
  }

  private watchTexture(texture: Texture, material: Material): boolean {
    const layout = () => this.layouts.add(texture);
    if (
      ![Texture.prototype, DataTexture.prototype, CanvasTexture.prototype].includes(
        Object.getPrototypeOf(texture),
      ) ||
      texture.isRenderTargetTexture ||
      !texture.matrixAutoUpdate ||
      texture.mipmaps.length ||
      texture.version === 0 ||
      !texture.source.dataReady ||
      texture.image == null ||
      (texture.image as { complete?: boolean }).complete === false
    )
      return false;
    let users = this.textures.get(texture);
    if (!users) {
      users = new Set();
      const consumers = users;
      const content = () => {
        for (const mat of consumers) this.materials.add(mat);
      };
      const ok = this.scope(texture, () => {
        for (const key of Object.keys(texture)) {
          if (
            [
              'id',
              'uuid',
              'name',
              'userData',
              '_listeners',
              'pmremVersion',
              'updateRanges',
            ].includes(key)
          )
            continue;
          if (!this.watch(texture, key, key === 'version' ? content : layout)) return false;
        }
        // The sampler contract consumes mip count even when the pixel version stays unchanged.
        if (!ownsCollection(texture.mipmaps))
          this.probe(() => {
            if (texture.mipmaps.length) layout();
          });
        else this.hold(watchCollection(texture.mipmaps, layout));
        for (const vector of [texture.center, texture.repeat, texture.offset])
          if (!this.fields(vector, layout, ['x', 'y'])) return false;
        if (!this.fields(texture.source, layout, ['data', 'dataReady'])) return false;
        texture.addEventListener('dispose', layout);
        this.cleanups.push(() => texture.removeEventListener('dispose', layout));
        return true;
      });
      if (!ok) {
        this.release(texture);
        return false;
      }
      this.textures.set(texture, users);
    }
    if (!users.has(material)) {
      users.add(material);
      this.hold(() => {
        users.delete(material);
        if (!users.size) {
          this.release(texture);
          this.textures.delete(texture);
        }
      });
    }
    return true;
  }

  private watchBounds(
    object: { boundingSphere: import('three/src/Three.Core.js').Sphere | null },
    notify: Notify,
  ): boolean {
    const sphere = object.boundingSphere;
    return (
      this.watch(object, 'boundingSphere', notify) &&
      (!sphere ||
        (this.fields(sphere, notify, ['radius', 'center']) &&
          this.fields(sphere.center, notify, ['x', 'y', 'z'])))
    );
  }

  reuseView(camera: Camera, pixelRatio: number, nativeOrder: boolean): boolean {
    const projection = camera.projectionMatrix.elements,
      view = camera.matrixWorldInverse.elements;
    const last = this.lastView;
    this.cameraBasisMoved = last.length !== 36;
    for (let i = 0; !this.cameraBasisMoved && i < 12; i++)
      this.cameraBasisMoved = !Object.is(view[i], last[16 + i]);
    this.cameraMoved = this.cameraBasisMoved;
    for (let i = 12; !this.cameraMoved && i < 16; i++)
      this.cameraMoved = !Object.is(view[i], last[16 + i]);
    let stable =
      (nativeOrder || !this.viewChanged) &&
      last.length === 36 &&
      last[32] === camera.layers.mask &&
      last[33] === pixelRatio &&
      last[34] === camera.coordinateSystem &&
      last[35] === Number(camera.reversedDepth);
    this.spriteViewChanged = this.cameraMoved || !stable;
    if (nativeOrder && this.retainedSprites.size !== 0)
      for (let i = 0; !this.spriteViewChanged && i < 16; i++)
        this.spriteViewChanged = !Object.is(projection[i], last[i]);
    if (nativeOrder)
      stable &&= Object.is(projection[5], last[5]) && Object.is(projection[11], last[11]);
    else {
      stable &&= !this.cameraMoved;
      for (let i = 0; stable && i < 16; i++) stable = Object.is(projection[i], last[i]);
    }
    if (!stable || this.spriteViewChanged) {
      for (let i = 0; i < 16; i++) {
        last[i] = projection[i];
        last[16 + i] = view[i];
      }
      last[32] = camera.layers.mask;
      last[33] = pixelRatio;
      last[34] = camera.coordinateSystem;
      last[35] = Number(camera.reversedDepth);
    }
    this.viewChanged = false;
    return stable && (nativeOrder || this.viewDraws.size !== 0);
  }

  private watchSequence(input: readonly unknown[], dirty: Notify): void {
    const off = watchCollection(input, dirty);
    if (off) this.hold(off);
    else this.watchForeignInput(input, () => input, dirty);
  }

  private watchForeignInput(source: object, read: () => readonly unknown[], dirty: Notify): void {
    let input = this.foreignInputs.get(source);
    if (input) {
      // Deliver an outstanding write to existing readers before accepting a new reader.
      input.sample();
    } else {
      input = new ForeignInput(read);
      this.foreignInputs.set(source, input);
    }
    const { readers } = input;
    readers.set(dirty, (readers.get(dirty) ?? 0) + 1);
    this.hold(() => {
      const count = readers.get(dirty);
      if (count === undefined) return;
      if (count > 1) readers.set(dirty, count - 1);
      else readers.delete(dirty);
      if (!readers.size) this.foreignInputs.delete(source);
    });
  }

  watchGeometry(geometry: BufferGeometry): boolean {
    if (this.geometry.has(geometry)) return true;
    const ok = this.scope(geometry, () => this.geometryFields(geometry));
    if (!ok) this.release(geometry);
    return ok;
  }
  private geometryFields(geometry: BufferGeometry): boolean {
    const layout = () => this.layouts.add(geometry);
    if (!Object.isExtensible(geometry)) return false;
    for (const method of ['getAttribute', 'hasAttribute'])
      if (!this.watch(geometry, method, layout, true)) return false;
    for (const key of [
      'index',
      'attributes',
      'groups',
      'drawRange',
      'morphAttributes',
      'morphTargetsRelative',
    ])
      if (!this.watch(geometry, key, layout)) return false;
    if (!this.fields(geometry.drawRange, layout) || !this.watchBounds(geometry, layout))
      return false;
    for (const group of geometry.groups) if (!this.fields(group, layout)) return false;
    for (const collection of [geometry.attributes, geometry.morphAttributes, geometry.groups]) {
      const off = watchCollection(collection, layout);
      if (off) this.hold(off);
      else {
        const entries = Object.entries(collection);
        this.probe(() => {
          if (
            Object.keys(collection).length !== entries.length ||
            entries.some(([key, value]) => Reflect.get(collection, key) !== value)
          )
            layout();
        });
      }
    }
    if (!ownsCollection(geometry.attributes) && !this.fields(geometry.attributes, layout))
      return false;
    const morphs = Object.values(geometry.morphAttributes).flatMap((list) => {
      if (!list) return [];
      this.watchSequence(list, layout);
      return list;
    });
    for (const attr of [geometry.index, ...Object.values(geometry.attributes), ...morphs]) {
      if (!attr) continue;
      const data = 'data' in attr ? attr.data : attr;
      const channel =
        attr === geometry.attributes.position
          ? attr === geometry.attributes.color
            ? PointContentChannels.All
            : PointContentChannels.Position
          : attr === geometry.attributes.color
            ? PointContentChannels.Color
            : PointContentChannels.All;
      const content = () =>
        this.changedGeometry.set(geometry, (this.changedGeometry.get(geometry) ?? 0) | channel);
      for (const key of [
        'version',
        'array',
        'count',
        'stride',
        'itemSize',
        'normalized',
        'offset',
        'data',
      ]) {
        if (
          Object.hasOwn(data, key) &&
          !this.watch(data, key, key === 'version' ? content : layout)
        )
          return false;
        if (data !== attr && Object.hasOwn(attr, key) && !this.watch(attr, key, layout))
          return false;
      }
    }
    geometry.addEventListener('dispose', layout);
    this.cleanups.push(() => geometry.removeEventListener('dispose', layout));
    this.geometry.set(geometry, new Set());
    return true;
  }

  watchDormant(mesh: Draw): boolean {
    const refresh = () => this.invalidateBinding(mesh);
    if (Array.isArray(mesh.material)) this.watchSequence(mesh.material, refresh);
    return this.fields(mesh, refresh, drawFields);
  }

  watchDeferredSprite(sprite: Sprite): boolean {
    return this.watch(sprite, 'frustumCulled', () => this.spriteVisibility.add(sprite));
  }

  private watchDrawPose(node: Object3D): void {
    this.hold(
      watchPublishedWorldMatrix(node.matrixWorld.elements, () => this.projectedPose.add(node)),
    );
  }

  watchDraw(mesh: Draw, viewDependent: boolean): boolean {
    const refresh = () => this.invalidateBinding(mesh);
    if (!this.fields(mesh, refresh, drawFields)) return false;
    if (!this.fields(mesh, refresh, drawHooks, true)) return false;
    if (mesh instanceof Sprite) {
      const pose = () => this.spritePoses.add(mesh);
      if (!this.watch(mesh, 'center', refresh) || !this.fields(mesh.center, pose, ['x', 'y']))
        return false;
    }
    if (Array.isArray(mesh.material)) this.watchSequence(mesh.material, refresh);
    if ('morphTargetInfluences' in mesh && mesh.morphTargetInfluences)
      this.watchSequence(mesh.morphTargetInfluences, refresh);
    if (mesh instanceof InstancedMesh) {
      if (!this.watchBounds(mesh, refresh)) return false;
      if (
        (mesh.morphTexture && !this.watch(mesh.morphTexture, 'version', refresh)) ||
        (mesh.instanceColor &&
          !this.fields(mesh.instanceColor, refresh, [
            'version',
            'array',
            'count',
            'itemSize',
            'normalized',
          ])) ||
        !this.fields(mesh, refresh, ['count', 'instanceMatrix', 'instanceColor', 'morphTexture']) ||
        !this.fields(mesh.instanceMatrix, refresh, [
          'version',
          'array',
          'count',
          'itemSize',
          'normalized',
        ])
      )
        return false;
    }
    const geometry = mesh.geometry;
    if (!this.watchGeometry(geometry)) return false;
    const owners = this.geometry.get(geometry);
    if (!owners) return false;
    if (this.ecsPoses && viewDependent && !this.nativeTransparentOrder && !(mesh instanceof Sprite))
      this.watchDrawPose(mesh);
    owners.add(mesh);
    this.hold(() => {
      owners.delete(mesh);
      if (!owners.size) {
        this.release(geometry);
        this.geometry.delete(geometry);
        this.changedGeometry.delete(geometry);
      }
    });
    return true;
  }

  /** The render binding depends on joint identity, not the animated joint matrices. */
  watchNativeSkin(mesh: SkinnedMesh, lit: boolean): boolean {
    const refresh = () => this.invalidateBinding(mesh);
    const { skeleton, bindMatrix, bindMatrixInverse } = mesh;
    if (
      bindMatrixInverse.copy !== Matrix4.prototype.copy ||
      bindMatrixInverse.invert !== Matrix4.prototype.invert ||
      !this.fields(mesh, refresh, ['skeleton', 'bindMode', 'bindMatrix', 'bindMatrixInverse']) ||
      !this.watch(mesh, 'applyBoneTransform', refresh, true) ||
      !this.fields(bindMatrixInverse, refresh, ['copy', 'invert', 'elements'], true) ||
      !this.watchSourceMatrix(bindMatrix, refresh, refresh) ||
      !this.fields(skeleton, refresh, ['bones', 'boneInverses'])
    )
      return false;
    this.watchSequence(skeleton.bones, refresh);
    this.watchSequence(skeleton.boneInverses, refresh);
    for (const inverse of skeleton.boneInverses)
      if (!this.watchSourceMatrix(inverse, refresh, refresh)) return false;

    const dependencies = new Set<Object3D>([this.root]);
    for (const bone of skeleton.bones) {
      for (let node: Object3D | null = bone; node && !dependencies.has(node); node = node.parent) {
        if (!this.watch(node, 'parent', refresh)) return false;
        dependencies.add(node);
      }
    }
    if (lit)
      for (let node: Object3D | null = mesh; node; node = node.parent) {
        const stop = observeScale(node.scale, refresh);
        if (!stop) return false;
        this.hold(stop);
        if (!this.fields(node, refresh, branchFields)) return false;
      }

    this.hold(
      watchPublishedWorldMatrix(mesh.matrixWorld.elements, () => {
        const determinant = mesh.matrixWorld.determinant();
        if (lit ? !(determinant > 0) : determinant === 0) refresh();
      }),
    );
    return true;
  }

  watchUse(
    mesh: Draw,
    material: Material,
    variant: string,
    shading: 0 | 1,
    view: boolean,
    direct: boolean,
    coordinates?: ReadonlyMap<Texture, ResolvedMaterialTextureCoordinates>,
    skinProgram?: SavedUse['skinProgram'],
  ): boolean {
    if (!this.watchMaterial(material)) return false;
    const uses = this.uses.get(material);
    if (!uses) return false;
    const key = `${view}:${direct}:${shading}:${variant}`;
    let use = uses.get(key);
    if (!use) {
      use = {
        view,
        direct,
        meshes: new Set(),
        variant,
        shading,
        skinProgram,
        ...(coordinates?.size ? { coordinates } : {}),
      };
      uses.set(key, use);
    }
    use.meshes.add(mesh);
    this.hold(() => {
      use.meshes.delete(mesh);
      if (!use.meshes.size) uses.delete(key);
      if (!uses.size) {
        this.release(material);
        this.uses.delete(material);
        this.materials.delete(material);
        this.materialEdits.delete(material);
      }
    });
    return true;
  }

  watchLight(light: SourceLight, shadows: boolean): boolean {
    if (!passiveParent(light)) return false;
    const layout = () => this.invalidateBinding(light);
    const dirty = () => {
      this.dirtyLights.add(light);
      if (light instanceof AmbientLight) this.ambientSum = undefined;
    };
    if (
      !this.fields(light, layout, ['color', 'castShadow']) ||
      !this.fields(light, dirty, ['intensity', 'type']) ||
      Object.getPrototypeOf(light.color) !== Color.prototype ||
      !this.fields(light.color, dirty, ['r', 'g', 'b'])
    )
      return false;
    if (
      (light instanceof PointLight || light instanceof SpotLight) &&
      !this.fields(light, dirty, ['distance', 'decay'])
    )
      return false;
    if (light instanceof RectAreaLight && !this.fields(light, dirty, ['width', 'height']))
      return false;
    if (light instanceof SpotLight && !this.fields(light, dirty, ['map', 'angle', 'penumbra']))
      return false;
    if (
      shadows &&
      (light instanceof DirectionalLight ||
        light instanceof PointLight ||
        light instanceof SpotLight) &&
      light.castShadow &&
      !this.watchShadow(light, layout, dirty)
    )
      return false;
    if (light instanceof DirectionalLight || light instanceof SpotLight) {
      const target = light.target;
      if (
        !this.watch(light, 'target', layout) ||
        !this.watch(target, 'matrixWorld', layout) ||
        !this.watch(target.matrixWorld, 'elements', layout)
      )
        return false;
      if (this.ecsPoses) this.hold(watchPublishedWorldMatrix(light.matrixWorld.elements, dirty));
      const elements = target.matrixWorld.elements;
      // Stock tracked matrix updates write the backing array directly. A target
      // can belong to another scene or renderer, with an independent dirty queue.
      const stop = watchTargetMatrix(elements, dirty);
      if (stop) {
        this.hold(stop);
      } else {
        let x = elements[12],
          y = elements[13],
          z = elements[14];
        const read = () => {
          if (x === elements[12] && y === elements[13] && z === elements[14]) return;
          x = elements[12];
          y = elements[13];
          z = elements[14];
          dirty();
        };
        this.probe(read);
        if (this.ecsPoses) {
          this.hold(watchPublishedWorldMatrix(elements, read));
        } else {
          let uses = this.targets.get(target);
          if (!uses) {
            uses = new Set();
            this.targets.set(target, uses);
          }
          uses.add(light);
          this.hold(() => {
            uses.delete(light);
            if (!uses.size) this.targets.delete(target);
          });
        }
      }
    }
    if (light instanceof AmbientLight) {
      this.ambient.add(light);
      this.ambientSum = undefined;
    }
    this.lights.add(light);
    this.hold(() => {
      this.lights.delete(light);
      this.dirtyLights.delete(light);
      if (light instanceof AmbientLight) {
        this.ambient.delete(light);
        this.ambientSum = undefined;
      }
    });
    return true;
  }

  private watchShadow(light: ShadowLight, layout: Notify, dirty: Notify): boolean {
    const { shadow } = light;
    const { camera } = shadow;
    // These inputs are mutated by LightShadow.updateMatrices. Sharing them
    // between lights requires preserving ordinary traversal order.
    const reference = new WeakRef(light);
    let shared = false;
    for (const input of [
      shadow,
      camera,
      shadow.matrix.elements,
      camera.projectionMatrix.elements,
    ]) {
      const owner = this.shadowInputs.get(input);
      if (owner === null) {
        shared = true;
        continue;
      }
      const previous = owner?.deref();
      if (previous && previous !== light) {
        this.shadowInputs.set(input, null);
        this.invalidateBinding(previous);
        shared = true;
      } else if (previous === undefined) this.shadowInputs.set(input, reference);
    }
    if (shared) return false;
    const shadowType =
      light instanceof DirectionalLight
        ? DirectionalLightShadow
        : light instanceof SpotLight
          ? SpotLightShadow
          : PointLightShadow;
    const cameraType = light instanceof DirectionalLight ? OrthographicCamera : PerspectiveCamera;
    if (
      Object.getPrototypeOf(shadow) !== shadowType.prototype ||
      shadow.updateMatrices !== shadowType.prototype.updateMatrices ||
      Object.getPrototypeOf(camera) !== cameraType.prototype ||
      camera.updateProjectionMatrix !== cameraType.prototype.updateProjectionMatrix ||
      camera.parent !== null ||
      !camera.matrixAutoUpdate ||
      !camera.matrixWorldAutoUpdate ||
      camera.pivot !== null ||
      camera.lookAt !== Object3D.prototype.lookAt ||
      camera.updateMatrix !== Object3D.prototype.updateMatrix ||
      camera.updateMatrixWorld !== Camera.prototype.updateMatrixWorld ||
      camera.updateWorldMatrix !== Camera.prototype.updateWorldMatrix
    )
      return false;
    const changed = () => {
      if (this.projectingShadow !== light) dirty();
    };
    const requested = () => {
      if (shadow.needsUpdate) dirty();
    };
    if (
      !this.watch(light, 'shadow', layout) ||
      !this.fields(shadow, layout, ['camera', 'mapSize', 'matrix']) ||
      !this.watch(shadow, 'updateMatrices', layout, true) ||
      !this.fields(shadow, changed, [
        'autoUpdate',
        'bias',
        'normalBias',
        'radius',
        'intensity',
        'blurSamples',
      ]) ||
      !this.watch(shadow, 'needsUpdate', requested) ||
      !this.fields(shadow.mapSize, changed, ['x', 'y']) ||
      !this.watch(camera, 'parent', layout) ||
      !this.fields(camera, layout, [
        'matrixAutoUpdate',
        'matrixWorldAutoUpdate',
        'pivot',
        'layers',
        'projectionMatrix',
        'up',
      ]) ||
      !this.fields(
        camera,
        layout,
        [
          'lookAt',
          'updateMatrix',
          'updateMatrixWorld',
          'updateWorldMatrix',
          'updateProjectionMatrix',
        ],
        true,
      ) ||
      !this.fields(camera, changed, ['near', 'far', 'coordinateSystem', '_reversedDepth']) ||
      !this.watch(camera.layers, 'mask', () => {
        this.shadowCasters = undefined;
        changed();
      }) ||
      (light instanceof SpotLight && !this.fields(shadow, changed, ['focus', 'aspect']))
    )
      return false;
    for (const matrix of [shadow.matrix, camera.projectionMatrix]) {
      const off = watchCollection(matrix.elements, changed);
      if (!off) return false;
      this.hold(off);
      if (!this.watch(matrix, 'elements', layout)) return false;
    }
    if (
      !this.fields(camera.up, changed, ['x', 'y', 'z']) ||
      !observePose(camera.position, camera.scale, camera.quaternion, changed, changed, (off) =>
        this.hold(off),
      )
    )
      return false;
    if (light instanceof PointLight && this.ecsPoses) {
      this.hold(watchPublishedWorldMatrix(light.matrixWorld.elements, dirty));
      this.hold(watchCollection(light.matrixWorld.elements, dirty));
    }
    this.shadowLights.add(light);
    this.shadowCasters = undefined;
    this.hold(() => {
      this.shadowLights.delete(light);
      this.shadowCasters = undefined;
    });
    return true;
  }

  shadowCasterMask(mask: number): number {
    const previous = this.shadowCasters;
    if (previous?.view === mask) return previous.channels;
    let casters = 0;
    for (const light of this.shadowLights)
      if (light.layers.mask & mask) casters |= shadowCasterChannels(light, mask);
    this.shadowCasters = { view: mask, channels: casters };
    return casters;
  }

  consumeLights(
    mask: number,
    shadowViewChannels: number,
    pendingShadows: ReadonlySet<ShadowLight>,
    poses: ReadonlySet<Object3D>,
    visit: (light: SourceLight) => void,
  ): void {
    const dirty = this.dirtyLights;
    if (this.lightMask !== mask) {
      if (this.lightMask !== undefined) for (const light of this.lights) dirty.add(light);
      this.lightMask = mask;
      this.ambientSum = undefined;
    }
    if (this.shadowViewChannels !== shadowViewChannels) {
      for (const light of this.shadowLights) dirty.add(light);
      this.shadowViewChannels = shadowViewChannels;
    }
    for (const light of pendingShadows) if (this.shadowLights.has(light)) dirty.add(light);
    if (!this.ecsPoses) {
      for (const node of poses) {
        if (
          (node instanceof DirectionalLight ||
            node instanceof SpotLight ||
            (node instanceof PointLight && this.shadowLights.has(node))) &&
          this.lights.has(node)
        )
          dirty.add(node);
        const lights = this.targets.get(node);
        if (lights) for (const light of lights) dirty.add(light);
      }
    }
    if (dirty.size) {
      this.dirtyLights = new Set();
      for (const light of dirty) visit(light);
    }
  }

  ambientIrradiance(mask: number): [number, number, number] {
    if (!this.ambientSum) {
      const sum: [number, number, number] = [0, 0, 0];
      for (const light of this.ambient)
        if (mask & light.layers.mask) {
          sum[0] += light.color.r * light.intensity;
          sum[1] += light.color.g * light.intensity;
          sum[2] += light.color.b * light.intensity;
        }
      this.ambientSum = sum;
    }
    return this.ambientSum;
  }

  ordinaryGroup(node: Object3D): boolean {
    return (
      [Object3D.prototype, Group.prototype, Bone.prototype].includes(Object.getPrototypeOf(node)) &&
      !this.unobservedNodeState.has(node)
    );
  }

  dispose(): void {
    for (const scope of this.bindingScopes.values()) releaseFrom(scope);
    this.bindingScopes.clear();
    for (const owner of this.scopes.keys()) this.release(owner);
  }
}
