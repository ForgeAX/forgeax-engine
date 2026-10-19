import { ENTITY_NULL_RAW, type EntityHandle, type Query, type World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { AnimationBindingError, type AnimationError } from './solver-errors';

interface TransformRow {
  readonly position: ArrayLike<number>;
  readonly rotation: ArrayLike<number>;
  readonly scale: ArrayLike<number>;
  readonly row: number;
}

/** A shared read view over live Transform columns; World remains the authority. */
export class SkeletonTransformReader {
  private readonly query: Query<readonly [typeof Transform]>;
  private readonly entries = new Map<
    EntityHandle,
    {
      references: number;
      row: TransformRow | undefined;
    }
  >();
  private structureEpoch = -1;

  constructor(private readonly world: World) {
    this.query = world.query({ read: [Transform] }).unwrap();
  }

  register(entities: readonly EntityHandle[]): void {
    for (const entity of entities) {
      const entry = this.entries.get(entity);
      if (entry === undefined) {
        this.entries.set(entity, { references: 1, row: undefined });
        this.structureEpoch = -1;
      } else entry.references += 1;
    }
  }

  unregister(entities: readonly EntityHandle[]): void {
    for (const entity of entities) {
      const entry = this.entries.get(entity);
      if (entry === undefined) continue;
      if (--entry.references === 0) this.entries.delete(entity);
    }
  }

  refresh(): void {
    const structureEpoch = this.world.getStructureEpoch();
    if (structureEpoch === this.structureEpoch) return;

    for (const entry of this.entries.values()) entry.row = undefined;
    if (this.entries.size === 0) {
      this.structureEpoch = structureEpoch;
      return;
    }
    for (const span of this.query.spans().unwrap()) {
      const columns = span.get(Transform);
      for (let row = 0; row < span.length; row++) {
        const entity = span.entities[row] as EntityHandle;
        const entry = this.entries.get(entity);
        if (entry === undefined) continue;
        entry.row = {
          position: columns.pos,
          rotation: columns.quat,
          scale: columns.scale,
          row,
        };
      }
    }
    this.structureEpoch = structureEpoch;
  }

  isCurrent(): boolean {
    return this.structureEpoch === this.world.getStructureEpoch();
  }

  read(entity: EntityHandle, position: Vec3, rotation: Quat, scale: Vec3): boolean {
    const row = this.entries.get(entity)?.row;
    if (row === undefined) return false;
    const positionOffset = row.row * 3;
    const rotationOffset = row.row * 4;
    for (let axis = 0; axis < 3; axis++) {
      position[axis] = row.position[positionOffset + axis] ?? Number.NaN;
      scale[axis] = row.scale[positionOffset + axis] ?? Number.NaN;
    }
    for (let axis = 0; axis < 4; axis++)
      rotation[axis] = row.rotation[rotationOffset + axis] ?? Number.NaN;
    return true;
  }
}

/** Cached explicit topology and scratch pose; no World or renderer owns a second pose. */
export class SkeletonPose {
  readonly entities: EntityHandle[] = [];
  readonly parents: number[] = [];
  readonly positions: Vec3[] = [];
  readonly rotations: Quat[] = [];
  readonly scales: Vec3[] = [];
  readonly matrices: Mat4[] = [];
  readonly globalRotations: Quat[] = [];
  readonly indices = new Map<EntityHandle, number>();
  private readonly parentEntities: (EntityHandle | null)[] = [];
  private readonly local = mat4.create();

  constructor(
    readonly world: World,
    joints: readonly EntityHandle[],
    readonly stopAt: EntityHandle | null = null,
    private readonly transformReader?: SkeletonTransformReader,
  ) {
    const visiting = new Set<EntityHandle>();
    const visit = (entity: EntityHandle): number => {
      const existing = this.indices.get(entity);
      if (existing !== undefined) return existing;
      if (visiting.has(entity) || !world.hasComponent(entity, Transform))
        throw new AnimationBindingError('animation-skeleton-invalid', {
          entity,
          reason: 'cycle or missing Transform',
        });
      visiting.add(entity);
      const relation = world.get(entity, ChildOf);
      const parent = relation.ok ? relation.value.parent : null;
      const parentIndex = parent === null || parent === stopAt ? -1 : visit(parent);
      const index = this.entities.length;
      this.entities.push(entity);
      this.parents.push(parentIndex);
      this.parentEntities.push(parent);
      this.positions.push(vec3.create());
      this.rotations.push(quat.create());
      this.scales.push(vec3.create());
      this.matrices.push(mat4.create());
      this.globalRotations.push(quat.create());
      this.indices.set(entity, index);
      visiting.delete(entity);
      return index;
    };
    for (const joint of joints) visit(joint);
    this.readInputsFromWorld(false);
    this.update(0);
    this.validate();
  }

  read(): void {
    this.transformReader?.refresh();
    this.readInputs();
    this.update(0);
    this.validate();
  }

  /** Read and validate inputs; the owning motion batch refreshes its shared view first. */
  readInputs(): void {
    this.readInputsFromWorld(true);
  }

  private readInputsFromWorld(useCachedTransforms: boolean): void {
    const reader = this.world[worldRead];
    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i] as EntityHandle;
      const parent = reader.getFieldValue(entity, ChildOf, 'parent') ?? ENTITY_NULL_RAW;
      if (parent !== (this.parentEntities[i] ?? ENTITY_NULL_RAW))
        throw new AnimationBindingError('animation-skeleton-stale', {
          entity,
          reason: 'hierarchy changed',
        });
      const position = this.positions[i] as (typeof this.positions)[number];
      const rotation = this.rotations[i] as (typeof this.rotations)[number];
      const scale = this.scales[i] as (typeof this.scales)[number];
      if (!useCachedTransforms || !this.transformReader?.read(entity, position, rotation, scale)) {
        this.readVector(entity, 'pos', position);
        this.readVector(entity, 'quat', rotation);
        this.readVector(entity, 'scale', scale);
      }
      if (
        Math.abs(quat.length(rotation) - 1) > 1e-3 ||
        (scale[0] as number) <= 0 ||
        Math.abs((scale[0] as number) - (scale[1] as number)) > 1e-4 ||
        Math.abs((scale[0] as number) - (scale[2] as number)) > 1e-4
      )
        throw new AnimationBindingError('animation-skeleton-invalid', {
          entity,
          reason: 'requires unit quaternion and positive uniform scale',
        });
    }
  }

  /** Check derived Float32 output as well as authored input before publishing any writes. */
  validate(): void {
    for (let i = 0; i < this.entities.length; i++) {
      if (
        !finiteValues(this.positions[i] as Float32Array) ||
        !finiteValues(this.rotations[i] as Float32Array) ||
        !finiteValues(this.scales[i] as Float32Array) ||
        !finiteValues(this.matrices[i] as Float32Array)
      )
        throw new AnimationBindingError('animation-skeleton-invalid', {
          entity: this.entities[i] as EntityHandle,
          reason: 'nonfinite derived pose',
        });
    }
  }

  private readVector(entity: EntityHandle, field: string, array: Float32Array): void {
    for (let j = 0; j < array.length; j++) {
      const value = this.world[worldRead].getArrayElement(entity, Transform, field, j);
      if (value === undefined || !Number.isFinite(value))
        throw new AnimationBindingError('animation-skeleton-stale', { entity, field });
      array[j] = value;
    }
  }

  update(start: number, end = this.entities.length, translationOrigin?: Vec3): void {
    for (let i = start; i < end; i++) {
      const matrix = this.matrices[i] as (typeof this.matrices)[number];
      const globalRotation = this.globalRotations[i] as (typeof this.globalRotations)[number];
      mat4.compose(
        this.local,
        this.positions[i] as (typeof this.positions)[number],
        this.rotations[i] as (typeof this.rotations)[number],
        this.scales[i] as (typeof this.scales)[number],
      );
      const parent = this.parents[i] as number;
      if (parent >= 0) {
        mat4.multiply(matrix, this.matrices[parent] as (typeof this.matrices)[number], this.local);
        quat.multiply(
          globalRotation,
          this.globalRotations[parent] as (typeof this.globalRotations)[number],
          this.rotations[i] as (typeof this.rotations)[number],
        );
      } else {
        matrix.set(this.local);
        if (translationOrigin !== undefined) {
          for (let axis = 0; axis < 3; axis++)
            matrix[12 + axis] =
              ((this.positions[i] as (typeof this.positions)[number])[axis] as number) -
              (translationOrigin[axis] as number);
        }
        globalRotation.set(this.rotations[i] as (typeof this.rotations)[number]);
      }
    }
  }

  write(indices: readonly number[], translation = false): void {
    this.validate();
    for (const index of indices) {
      const entity = this.entities[index] as EntityHandle;
      const reader = this.world[worldRead];
      let rotationChanged = false;
      for (let i = 0; i < 4; i++)
        if (
          reader.getArrayElement(entity, Transform, 'quat', i) !==
          (this.rotations[index] as (typeof this.rotations)[number])[i]
        )
          rotationChanged = true;
      let positionChanged = false;
      if (translation)
        for (let i = 0; i < 3; i++)
          if (
            reader.getArrayElement(entity, Transform, 'pos', i) !==
            (this.positions[index] as (typeof this.positions)[number])[i]
          )
            positionChanged = true;
      if (rotationChanged) this.writeVector(entity, 'quat', this.rotations[index] as Float32Array);
      if (positionChanged) this.writeVector(entity, 'pos', this.positions[index] as Float32Array);
    }
  }

  private writeVector(entity: EntityHandle, field: 'pos' | 'quat', values: Float32Array): void {
    const result = this.world.setArrayRange(entity, Transform, field, 0, values);
    if (!result.ok)
      throw new AnimationBindingError('animation-solver-write-failed', {
        entity,
        cause: result.error.code,
      });
  }
}

export function solverFailure(error: unknown): AnimationError {
  if (error instanceof AnimationBindingError) return error as AnimationError;
  throw error;
}

function finiteValues(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}
