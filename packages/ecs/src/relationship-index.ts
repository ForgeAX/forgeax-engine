import {
  type Component,
  type ComponentSchema,
  defineComponent,
  type FieldsInput,
  componentRelationshipRoles as roles,
} from './component';
import { ENTITY_NULL_RAW, type EntityHandle } from './entity-handle';

declare const relationshipTargetBrand: unique symbol;

/** A relationship target is a read projection, never a structural-write token. */
export type RelationshipTargetComponent<C extends Component = Component> = C & {
  readonly [relationshipTargetBrand]: true;
};

/** Command-owned changes to source edges over the committed World graph. */
export type RelationshipOverlay = ReadonlyMap<number, ReadonlyMap<number, EntityHandle | null>>;

export interface RelationshipOptions {
  readonly sourceName: string;
  readonly sourceField: string;
  readonly targetName: string;
  readonly targetField: string;
  /**
   * Components materialized with the writable source side.  This is the
   * relationship equivalent of `defineComponent(..., { requires })`: the
   * dependency is resolved once at the structural boundary, never by a frame
   * system.  It applies only to the source; the reverse target remains an
   * engine-owned projection.
   */
  readonly sourceRequires?: readonly Component[];
  readonly exclusive?: boolean;
  readonly linkedSpawn?: boolean;
  /** Allow a source to point at its own holder (e.g. self-animated entities). */
  readonly allowSelf?: boolean;
}

export type RelationshipRole =
  | {
      readonly kind: 'source';
      readonly target: Component<string, ComponentSchema>;
      readonly sourceField: string;
      readonly targetField: string;
      readonly exclusive: boolean;
      readonly linkedSpawn: boolean;
      readonly allowSelf: boolean;
    }
  | {
      readonly kind: 'target';
      readonly source: Component<string, ComponentSchema>;
      readonly sourceField: string;
      readonly targetField: string;
    };

/**
 * Declare both sides of a relationship in one closed operation. The source is
 * the only writable relationship component; its target is a materialized,
 * engine-maintained reverse list.
 */
export function defineRelationship<
  const S extends string,
  const SF extends string,
  const T extends string,
  const TF extends string,
>(
  options: RelationshipOptions & {
    readonly sourceName: S;
    readonly sourceField: SF;
    readonly targetName: T;
    readonly targetField: TF;
  },
): {
  readonly source: Component<S, { [K in SF]: 'entity' }>;
  readonly target: RelationshipTargetComponent<Component<T, { [K in TF]: 'array<entity>' }>>;
} {
  const targetFields: FieldsInput = {
    [options.targetField]: { type: 'array<entity>', transient: true },
  };
  const target = defineComponent(options.targetName, targetFields);
  const sourceFields: FieldsInput = { [options.sourceField]: { type: 'entity' } };
  const source = defineComponent(
    options.sourceName,
    sourceFields,
    options.sourceRequires === undefined ? undefined : { requires: options.sourceRequires },
  );

  roles.set(source, {
    kind: 'source',
    target,
    sourceField: options.sourceField,
    targetField: options.targetField,
    exclusive: options.exclusive ?? true,
    linkedSpawn: options.linkedSpawn ?? false,
    allowSelf: options.allowSelf ?? false,
  });
  roles.set(target, {
    kind: 'target',
    source,
    sourceField: options.sourceField,
    targetField: options.targetField,
  });
  return { source: source as never, target: target as never };
}

export function relationshipRole(component: Component): RelationshipRole | undefined {
  return roles.get(component);
}

/** Return the source token owned by a materialized relationship target. */
export function relationshipSource(component: Component): Component | undefined {
  const role = roles.get(component);
  return role?.kind === 'target' ? role.source : undefined;
}

export function isExclusiveRelationshipSource(component: Component): boolean {
  const role = roles.get(component);
  return role?.kind === 'source' && role.exclusive;
}

export function isRelationshipTarget(component: Component): boolean {
  return roles.get(component)?.kind === 'target';
}

/**
 * Backpointer index for the materialized reverse lists stored by World.
 * The target component array is the one authoritative read list; this index
 * stores only source-to-target locations for O(1) swap-remove bookkeeping.
 */
export class RelationshipIndex {
  private readonly slots = new Map<number, { target: number; slot: number }>();
  private epochValue = 0;

  get epoch(): number {
    return this.epochValue;
  }

  attach(source: EntityHandle, target: EntityHandle, slot: number): number {
    this.slots.set(source as number, { target: target as number, slot });
    this.epochValue++;
    return slot;
  }

  detach(source: EntityHandle): boolean {
    if (!this.slots.delete(source as number)) return false;
    this.epochValue++;
    return true;
  }

  slotForTarget(source: EntityHandle, target: EntityHandle): number | undefined {
    const location = this.slots.get(source as number);
    return location?.target === (target as number) ? location?.slot : undefined;
  }

  /** Bind the source that swap-remove moved into `slot`. */
  updateSlot(source: EntityHandle, target: EntityHandle, slot: number): void {
    const location = this.slots.get(source as number);
    if (location === undefined) return;
    location.target = target as number;
    location.slot = slot;
    this.epochValue++;
  }
}

/** The declared source field is the relationship edge, including its null sentinel. */
export function relationshipTarget(
  component: Component,
  data: Readonly<Record<string, unknown>>,
): EntityHandle | null {
  const role = relationshipRole(component);
  if (role?.kind !== 'source') return null;
  return decodeRelationshipTarget(data[role.sourceField]);
}

/** Normalize the stored null sentinel and explicit nullish input to the same empty edge. */
export function decodeRelationshipTarget(raw: unknown): EntityHandle | null {
  return raw === null || raw === undefined || raw === ENTITY_NULL_RAW
    ? null
    : (raw as EntityHandle);
}
