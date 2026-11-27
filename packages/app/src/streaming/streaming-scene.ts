import { prepareRuntimePackContent, type RuntimePackProducer } from '@forgeax/engine-import';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import {
  type StreamingBounds,
  type StreamingCell,
  type StreamingGrid,
  WorldStreamingError,
} from './world-index';

type PackOptions = NonNullable<Parameters<typeof prepareRuntimePackContent>[2]>;

export interface StreamingScenePlacement {
  readonly key: string;
  readonly bounds: StreamingBounds;
  readonly role: StreamingCell['role'];
  readonly layer?: string;
  readonly replacement?: StreamingCell['replacement'];
  /** Additional local hard references supplied by the owner of the Scene vocabulary. */
  readonly together?: readonly string[];
}

/** Input stays immutable for a source revision and may come from a generated Scene. */
export interface StreamingSceneSource {
  readonly namespace: string;
  readonly revision: string;
  readonly scene: SceneAsset;
  readonly placements: Iterable<StreamingScenePlacement>;
  readonly producer: Pick<RuntimePackProducer, 'admit' | 'withdraw'>;
  readonly packOptions?: PackOptions;
}

interface Member {
  readonly placement: StreamingScenePlacement;
  readonly entity: SceneEntity;
  parent?: Member;
}

interface DerivedCell {
  readonly packageId: string;
  readonly members: Member[];
  readonly placement: StreamingScenePlacement;
  bounds: StreamingBounds;
}

function invalid(subject: string, reason: string): WorldStreamingError {
  return new WorldStreamingError('invalid-index', { subject, reason });
}

function parsePackageId(value: string) {
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw invalid(value, 'expected a Pack namespace UUID');
  return parsed.value;
}

function derivedKey(...parts: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  return `cell/${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function representative(member: Member): Member {
  let root = member;
  while (root.parent !== undefined) root = root.parent;
  let visit = member;
  while (visit.parent !== undefined && visit.parent !== root) {
    const next = visit.parent;
    visit.parent = root;
    visit = next;
  }
  return root;
}

function compatible(a: StreamingScenePlacement, b: StreamingScenePlacement): boolean {
  return (
    a.layer === b.layer &&
    a.role === b.role &&
    a.replacement?.group === b.replacement?.group &&
    a.replacement?.role === b.replacement?.role
  );
}

function connect(a: Member, b: Member): void {
  const left = representative(a);
  const right = representative(b);
  if (left === right) return;
  if (!compatible(left.placement, right.placement))
    throw invalid(
      a.placement.key,
      `hard reference to ${b.placement.key} crosses participation policies`,
    );
  if (left.placement.key < right.placement.key) right.parent = left;
  else left.parent = right;
}

function boundsUnion(a: StreamingBounds, b: StreamingBounds): StreamingBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function* readMembers(source: StreamingSceneSource): Generator<undefined, Map<string, Member>> {
  const members = new Map<string, Member>();
  for (const placement of source.placements) {
    const key = placement.key;
    if (members.has(key) || !Object.hasOwn(source.scene.entities, key))
      throw invalid(key, 'expected one bounds record per Scene entity');
    const entity = source.scene.entities[key];
    if (entity === undefined) throw invalid(key, 'missing Scene entity');
    members.set(key, { placement, entity });
    yield;
  }
  for (const key in source.scene.entities) {
    if (!members.has(key)) throw invalid(key, 'missing bounds record');
    yield;
  }
  return members;
}

function* connectMembers(members: Map<string, Member>): Generator<undefined> {
  for (const member of members.values()) {
    const parent: unknown = member.entity.components.ChildOf?.parent;
    if (parent !== undefined && parent !== 0) {
      if (typeof parent !== 'string')
        throw invalid(member.placement.key, 'expected a source-key parent');
      const related = members.get(parent);
      if (related === undefined)
        throw invalid(member.placement.key, `missing hard reference ${parent}`);
      connect(member, related);
    }
    for (const key of member.placement.together ?? []) {
      const related = members.get(key);
      if (related === undefined)
        throw invalid(member.placement.key, `missing hard reference ${key}`);
      connect(member, related);
      yield;
    }
    yield;
  }
}

function cellKey(member: Member, grid: StreamingGrid): string {
  const { bounds, role, layer, replacement } = member.placement;
  const x = Math.floor((bounds.minX - (grid.originX ?? 0)) / grid.cellSize);
  const z = Math.floor((bounds.minZ - (grid.originZ ?? 0)) / grid.cellSize);
  return JSON.stringify([x, z, role, layer, replacement?.group, replacement?.role]);
}

/** The directory carries Scene recipes. The normal Runtime Pack producer publishes a recipe on demand. */
export class RuntimeStreamingScene {
  private readonly declarations = new Map<string, DerivedCell>();

  constructor(private readonly source: StreamingSceneSource) {}

  *cells(grid: StreamingGrid): Generator<StreamingCell | undefined> {
    if (this.source.scene.skinGuids?.length)
      throw invalid(
        this.source.namespace,
        'static Scene subset does not support skin dependencies',
      );
    if (this.source.revision.length === 0)
      throw invalid(this.source.namespace, 'empty source revision');
    const namespace = parsePackageId(this.source.namespace);
    const members = yield* readMembers(this.source);
    yield* connectMembers(members);
    const cells = new Map<string, DerivedCell>();
    for (const member of members.values()) {
      const root = representative(member);
      const key = cellKey(root, grid);
      let cell = cells.get(key);
      if (cell === undefined) {
        const packageId = AssetGuid.format(
          AssetGuid.derive(
            namespace,
            derivedKey(
              this.source.revision,
              grid.cellSize,
              grid.originX ?? 0,
              grid.originZ ?? 0,
              key,
            ),
          ),
        );
        cell = {
          packageId,
          members: [],
          placement: root.placement,
          bounds: member.placement.bounds,
        };
        cells.set(key, cell);
      }
      cell.members.push(member);
      cell.bounds = boundsUnion(cell.bounds, member.placement.bounds);
      yield;
    }
    for (const cell of cells.values()) {
      const scene = AssetGuid.format(AssetGuid.derive(parsePackageId(cell.packageId), 'scene'));
      this.declarations.set(scene, cell);
      const { role, layer, replacement } = cell.placement;
      yield {
        key: scene,
        scene,
        bounds: cell.bounds,
        role,
        ...(layer === undefined ? {} : { layer }),
        ...(replacement === undefined ? {} : { replacement }),
      };
    }
  }

  has(scene: string): boolean {
    return this.declarations.has(scene);
  }

  async publish(scene: string, signal: AbortSignal): Promise<void> {
    const cell = this.declarations.get(scene);
    if (cell === undefined) throw invalid(scene, 'missing derived Scene recipe');
    const entities = Object.fromEntries(
      cell.members.map(({ placement, entity }) => [placement.key, entity]),
    );
    const content = (
      await prepareRuntimePackContent(
        cell.packageId,
        { scene: { kind: 'scene', entities } },
        this.source.packOptions,
      )
    ).unwrap();
    if (signal.aborted) return;
    (await this.source.producer.admit(content, signal)).unwrap();
  }

  withdraw(scene: string): void {
    const cell = this.declarations.get(scene);
    if (cell !== undefined) this.source.producer.withdraw(cell.packageId);
  }
}
