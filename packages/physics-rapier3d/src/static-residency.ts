import { type AssetObserver, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Component, Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { readComponentMutationEpoch } from '@forgeax/engine-ecs/projection';
import {
  ColliderShapeValue,
  finitePhysicsVector,
  RigidBodyTypeValue,
  unitPhysicsQuaternion,
  validateAdditionalSolverIterations,
} from '@forgeax/engine-physics';
import { captureSceneSourceGuard, type SceneSourceGuard } from '@forgeax/engine-scene/internal';
import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { validAuthoredColliderDimensions } from './authored-collider-description.js';
import {
  type PhysicsSyncDescriptor,
  readResidentPhysicsDescriptor,
  samePhysicsValue,
} from './physics-sync-descriptor.js';

export type StaticResidencyErrorCode =
  | 'static-residency-invalid'
  | 'static-residency-stale'
  | 'static-residency-closed'
  | 'static-residency-fault';
export class StaticResidencyError extends Error {
  override readonly name = 'StaticResidencyError';
  readonly expected = 'one guarded static roster and the same native bodies until retirement';
  readonly hint = 'retire the candidate; rebuild physics after a native acceptance fault';
  constructor(
    readonly code: StaticResidencyErrorCode,
    readonly detail: {
      readonly reason: string;
      readonly entity?: number;
    },
    cause?: unknown,
  ) {
    super(`[${code}] ${detail.reason}`, { cause });
  }
}
export interface StaticResidentMember {
  readonly entity: EntityHandle;
  /** Effective authored participation; temporary preparation Disabled is independent. */
  readonly participates: boolean;
}
export interface StaticResidencyStatus {
  readonly phase:
    | 'preparing'
    | 'prepared'
    | 'active'
    | 'retiring'
    | 'retired'
    | 'closed'
    | 'failed';
  readonly participation: 'inactive' | 'active' | 'unconfirmed';
  readonly prepared: number;
  readonly remaining: number;
}
export interface StaticPhysicsGroup {
  isCurrent(): boolean;
  prepareStep(): Result<StaticResidencyStatus, StaticResidencyError>;
  /** Caller owns the exclusive legal fixed boundary and preflights every source write.
   * A successful source callback accepts the complete effective roster synchronously.
   * A callback error must leave that roster unchanged; side effects are never rolled back. */
  accept(
    active: boolean,
    acceptSource: () => Result<void, unknown>,
  ): Result<void, StaticResidencyError>;
  retireStep(): Result<StaticResidencyStatus, StaticResidencyError>;
  inspect(): StaticResidencyStatus;
}
interface StaticResidencyHost {
  check(): void;
  exclusive<T>(run: () => T): T;
  create(entity: EntityHandle, descriptor: PhysicsSyncDescriptor): number;
  body(entity: number): { readonly handle: number } | undefined;
  participate(handles: Float64Array, enabled: Uint8Array): boolean;
  preflight(handles: Float64Array, enabled: Uint8Array): boolean;
  meshVersion(handle: number): number | undefined;
  prepareMeshService(): void;
  remove(entity: number, expectedBody: number): void;
  stopContacts(entity: number): void;
}
interface Member extends StaticResidentMember {
  readonly descriptor: PhysicsSyncDescriptor;
  handle?: number;
}
interface Group {
  readonly world: World;
  readonly members: readonly Member[];
  readonly guard: () => Result<void, unknown>;
  readonly sourceComponents: readonly Component[];
  readonly meshVersions: ReadonlyMap<number, number>;
  readonly meshChanges: AssetObserver | undefined;
  readonly handles: Float64Array;
  readonly enabled: Uint8Array;
  readonly disabled: Uint8Array;
  readonly source: SceneSourceGuard;
  readonly sourceParticipants: number;
  active: boolean;
  phase: StaticResidencyStatus['phase'];
  prepared: number;
  retired: number;
  failure?: StaticResidencyError;
  requiresDisposal?: boolean;
}
function failure(code: StaticResidencyErrorCode, reason: string, entity?: number, cause?: unknown) {
  return new StaticResidencyError(
    code,
    { reason, ...(entity === undefined ? {} : { entity }) },
    cause,
  );
}

function staticMemberRejection(
  world: World,
  descriptor: PhysicsSyncDescriptor,
): string | undefined {
  const collider = descriptor.collider;
  const p = descriptor.transform.position,
    q = descriptor.transform.rotation;
  if (!finitePhysicsVector([p.x, p.y, p.z], 3) || !unitPhysicsQuaternion([q.x, q.y, q.z, q.w]))
    return 'finite position and unit rotation are required';
  if (
    descriptor.rigidBody.type !== RigidBodyTypeValue.static ||
    descriptor.hasCharacterController ||
    collider === undefined ||
    collider.isSensor ||
    ![
      ColliderShapeValue.cuboid,
      ColliderShapeValue.sphere,
      ColliderShapeValue.capsule,
      ColliderShapeValue.trimesh,
    ].some((shape) => shape === collider.shape) ||
    !validAuthoredColliderDimensions(descriptor.transform, collider)
  )
    return 'unsupported or invalid static solid';
  try {
    validateAdditionalSolverIterations(descriptor.rigidBody.additionalSolverIterations ?? 0);
    if (collider.shape === ColliderShapeValue.trimesh) {
      const mesh = runtimeAssets(world.assets).borrow<MeshAsset>(Number(collider.mesh));
      if (!mesh.ok || mesh.value.kind !== 'mesh' || mesh.value.collision === undefined)
        return 'missing produced Mesh collision';
    }
  } catch {
    return 'missing geometry owner or invalid native options';
  }
  return undefined;
}

/** Membership belongs to this native owner; actual body/geometry ownership stays in its existing maps. */
export class StaticPhysicsResidency {
  private readonly groups = new Set<Group>();
  private readonly members = new Map<number, { readonly group: Group; readonly member: Member }>();
  private closed = false;
  private nativeFault = false;
  get faulted(): boolean {
    return this.nativeFault;
  }
  constructor(private readonly host: StaticResidencyHost) {}

  begin(
    world: World,
    roster: readonly StaticResidentMember[],
    guard: () => Result<void, unknown>,
    sourceParticipants?: number,
  ): Result<StaticPhysicsGroup, StaticResidencyError> {
    this.host.check();
    if (this.closed) return err(failure('static-residency-closed', 'native owner is closed'));
    if (world.execution.health !== 'healthy')
      return err(failure('static-residency-invalid', 'World must be healthy'));
    const preparedRoster = this.captureRoster(world, roster);
    if (!preparedRoster.ok) return preparedRoster;
    const members = preparedRoster.value;
    const physicalParticipants = members.reduce(
      (count, member) => count + Number(member.participates),
      0,
    );
    const expectedParticipants = sourceParticipants ?? physicalParticipants;
    if (!Number.isSafeInteger(expectedParticipants) || expectedParticipants < physicalParticipants)
      return err(failure('static-residency-invalid', 'invalid full Scene participation count'));

    const current = guard();
    if (!current.ok)
      return err(failure('static-residency-stale', 'source guard rejected the initial roster'));
    const sourceComponents = [
      'Transform',
      'GlobalTransform',
      'Collider',
      'RigidBody',
      'CharacterController',
      'ChildOf',
    ]
      .map((name) => world.components.resolve(name))
      .filter((component): component is Component => component !== undefined);
    const source = captureSceneSourceGuard(
      world,
      members.map((member) => member.entity),
      sourceComponents,
    );
    if (!source.ok) return err(failure('static-residency-stale', 'cannot guard static members'));
    const meshVersions = new Map<number, number>();
    for (const member of members) {
      if (member.descriptor.collider?.shape !== ColliderShapeValue.trimesh) continue;
      const asset = Number(member.descriptor.collider.mesh);
      meshVersions.set(asset, runtimeAssets(world.assets).version(asset).unwrap());
    }
    if (meshVersions.size > 0) {
      try {
        this.host.prepareMeshService();
      } catch {
        source.value.dispose();
        return err(
          failure('static-residency-invalid', 'native Mesh observation capacity is unavailable'),
        );
      }
    }
    const observed = meshVersions.size === 0 ? undefined : runtimeAssets(world.assets).observe();
    if (observed !== undefined && !observed.ok) {
      source.value.dispose();
      return err(failure('static-residency-invalid', 'cannot observe captured Mesh identities'));
    }
    const group: Group = {
      world,
      members,
      guard,
      sourceComponents,
      meshVersions,
      meshChanges: observed?.value,
      handles: new Float64Array(members.length),
      enabled: Uint8Array.from(members, (member) => Number(member.participates)),
      disabled: new Uint8Array(members.length),
      source: source.value,
      sourceParticipants: expectedParticipants,
      active: false,
      phase: 'preparing',
      prepared: 0,
      retired: 0,
    };
    for (const member of members) this.members.set(member.entity, { group, member });
    this.groups.add(group);
    return ok({
      isCurrent: () => this.current(group),
      prepareStep: () => this.prepareStep(group),
      accept: (active, source) => this.accept(group, active, source),
      retireStep: () => this.retireStep(group),
      inspect: () => this.status(group),
    });
  }

  private captureRoster(
    world: World,
    roster: readonly StaticResidentMember[],
  ): Result<Member[], StaticResidencyError> {
    const members: Member[] = [];
    const identities = new Set<number>();
    for (const input of roster) {
      const descriptor = readResidentPhysicsDescriptor(world, input.entity);
      if (
        identities.has(input.entity) ||
        this.members.has(input.entity) ||
        this.host.body(input.entity) ||
        !world.hasComponent(input.entity, Disabled) ||
        descriptor === undefined ||
        staticMemberRejection(world, descriptor) !== undefined
      )
        return err(
          failure(
            'static-residency-invalid',
            'member must be a fresh valid Disabled static solid',
            input.entity,
          ),
        );
      identities.add(input.entity);
      members.push({ entity: input.entity, participates: input.participates, descriptor });
    }
    return ok(members);
  }

  private current(group: Group): boolean {
    try {
      this.host.check();
      return (
        (group.phase === 'prepared' || group.phase === 'active') &&
        this.validate(group).ok &&
        this.resourcesReady(group) &&
        this.host.preflight(group.handles, group.active ? group.enabled : group.disabled)
      );
    } catch {
      return false;
    }
  }
  private status(group: Group): StaticResidencyStatus {
    return {
      phase: group.phase,
      participation:
        group.phase === 'closed' || group.phase === 'retired'
          ? 'inactive'
          : group.requiresDisposal
            ? 'unconfirmed'
            : group.active
              ? 'active'
              : 'inactive',
      prepared: group.prepared,
      remaining:
        group.phase === 'retiring'
          ? group.members.length - group.retired
          : group.members.length - group.prepared,
    };
  }
  private fail(group: Group, reason: StaticResidencyError): Result<never, StaticResidencyError> {
    if (group.active) this.nativeFault = true;
    group.failure ??= reason;
    group.phase = 'failed';
    return err(group.failure);
  }
  private meshInputsCurrent(group: Group): boolean {
    if (group.meshChanges === undefined) return true;
    const batch = group.meshChanges.read();
    if (!batch.ok) return false;
    for (const change of batch.value.changes)
      if (group.meshVersions.has(change.handle)) return false;
    batch.value.accept();
    return true;
  }
  private resourcesReady(group: Group): boolean {
    for (const [asset, revision] of group.meshVersions)
      if (this.host.meshVersion(asset) !== revision) return false;
    return true;
  }
  private validate(group: Group, roster = group.members): Result<void, StaticResidencyError> {
    if (this.closed || group.phase === 'closed' || group.phase === 'retired')
      return err(failure('static-residency-closed', 'group is retired or native owner is closed'));
    if (group.failure !== undefined) return err(group.failure);
    if (
      group.world.execution.health !== 'healthy' ||
      !group.guard().ok ||
      !group.source.isCurrent() ||
      !this.meshInputsCurrent(group)
    )
      return this.fail(group, failure('static-residency-stale', 'World or fixed source changed'));
    for (const member of roster) {
      const disabled = group.world.hasComponent(member.entity, Disabled);
      const expectedDisabled = !group.active || !member.participates;
      if (
        disabled !== expectedDisabled ||
        (member.handle !== undefined && this.host.body(member.entity)?.handle !== member.handle)
      )
        return this.fail(
          group,
          failure('static-residency-stale', 'member or native identity changed', member.entity),
        );
    }
    return ok(undefined);
  }
  private prepareStep(group: Group): Result<StaticResidencyStatus, StaticResidencyError> {
    if (this.closed || group.phase === 'closed')
      return err(failure('static-residency-closed', 'native owner is closed'));
    this.host.check();
    const member = group.members[group.prepared];
    const current = this.validate(
      group,
      group.phase === 'preparing' ? (member === undefined ? [] : [member]) : group.members,
    );
    if (!current.ok) return current;
    if (group.phase !== 'preparing') return ok(this.status(group));
    if (member?.descriptor.collider?.shape === ColliderShapeValue.trimesh) {
      const asset = Number(member.descriptor.collider.mesh);
      const native = this.host.meshVersion(asset);
      if (native !== undefined && native !== group.meshVersions.get(asset))
        return ok(this.status(group));
    }
    if (member !== undefined) {
      try {
        member.handle = this.host.create(member.entity, member.descriptor);
        group.handles[group.prepared] = member.handle;
        group.prepared++;
      } catch (cause) {
        this.nativeFault = true;
        group.requiresDisposal = true;
        return this.fail(group, failure('static-residency-fault', String(cause), member.entity));
      }
    }
    if (
      member !== undefined &&
      !this.host.preflight(
        group.handles.subarray(group.prepared - 1, group.prepared),
        group.enabled.subarray(group.prepared - 1, group.prepared),
      )
    )
      return this.fail(
        group,
        failure(
          'static-residency-invalid',
          'native bounds or static binding cannot participate',
          member.entity,
        ),
      );
    const after = this.validate(group, member === undefined ? [] : [member]);
    if (!after.ok) return after;
    if (group.prepared === group.members.length && this.resourcesReady(group)) {
      if (!this.host.preflight(group.handles, group.enabled))
        return this.fail(
          group,
          failure('static-residency-invalid', 'complete native resource bounds cannot participate'),
        );
      group.phase = 'prepared';
    }
    return ok(this.status(group));
  }
  private accept(
    group: Group,
    active: boolean,
    acceptSource: () => Result<void, unknown>,
  ): Result<void, StaticResidencyError> {
    if (this.closed || group.phase === 'closed')
      return err(failure('static-residency-closed', 'native owner is closed'));
    this.host.check();
    if (group.requiresDisposal)
      return err(
        failure(
          'static-residency-fault',
          'native creation could not confirm ownership; dispose the native owner',
        ),
      );
    const current = this.validate(group);
    if (!current.ok) return current;
    if (group.phase !== 'prepared' && group.phase !== 'active')
      return err(
        failure('static-residency-invalid', 'prepare the complete roster before acceptance'),
      );
    if (
      !this.resourcesReady(group) ||
      !this.host.preflight(group.handles, active ? group.enabled : group.disabled)
    )
      return this.fail(
        group,
        failure('static-residency-stale', 'prepared native roster is no longer ready'),
      );
    try {
      return this.host.exclusive(() => {
        const epochs = group.sourceComponents.map((component) =>
          readComponentMutationEpoch(group.world, component),
        );
        const beforeStructure = group.world.getStructureEpoch();
        const expectedStructure =
          beforeStructure + (active === group.active ? 0 : group.sourceParticipants);
        const accepted = acceptSource();
        if (!accepted.ok) {
          if (group.world.getStructureEpoch() !== beforeStructure || !this.validate(group).ok)
            throw new AggregateError(
              [accepted.error],
              'rejected source acceptance changed the roster',
            );
          return err(
            failure('static-residency-invalid', 'source acceptance rejected without mutation'),
          );
        }
        if (
          !group.guard().ok ||
          !this.meshInputsCurrent(group) ||
          !this.resourcesReady(group) ||
          group.sourceComponents.some(
            (component, index) =>
              readComponentMutationEpoch(group.world, component) !== epochs[index],
          )
        )
          throw new Error('fixed source changed during acceptance');
        for (const member of group.members) {
          if (group.world.hasComponent(member.entity, Disabled) === (active && member.participates))
            throw new Error('source acceptance did not switch the complete effective roster');
          if (
            !samePhysicsValue(
              readResidentPhysicsDescriptor(group.world, member.entity),
              member.descriptor,
            ) ||
            this.host.body(member.entity)?.handle !== member.handle
          )
            throw new Error('source acceptance changed a prepared member or native body');
        }
        // Reuse the initial ECS observation. The callback changed only the
        // known Disabled membership; numerical/structural evidence stays live.
        if (!group.source.acceptDisabledTransition(expectedStructure))
          throw new Error('source acceptance changed structure outside the prepared transition');
        if (!this.host.participate(group.handles, active ? group.enabled : group.disabled))
          throw new Error('native participation roster changed after preflight');
        if (!active) for (const member of group.members) this.host.stopContacts(member.entity);
        group.active = active;
        group.phase = active ? 'active' : 'prepared';
        return ok(undefined);
      });
    } catch (cause) {
      this.nativeFault = true;
      group.requiresDisposal = true;
      return this.fail(
        group,
        failure(
          'static-residency-fault',
          `acceptance requires rebuild: ${String(cause)}`,
          undefined,
          cause,
        ),
      );
    }
  }
  private retireStep(group: Group): Result<StaticResidencyStatus, StaticResidencyError> {
    if (this.closed || group.phase === 'closed' || group.phase === 'retired')
      return ok(this.status(group));
    this.host.check();
    if (group.requiresDisposal)
      return err(
        failure('static-residency-fault', 'dispose native owner after unconfirmed creation'),
      );
    // Actual participation survives a failed phase; active invalidation must stop/rebuild first.
    if (group.active)
      return err(failure('static-residency-invalid', 'stop participation before retirement'));
    group.phase = 'retiring';
    const member = group.members[group.retired];
    if (member !== undefined) {
      try {
        if (member.handle !== undefined) this.host.remove(member.entity, member.handle);
      } catch (cause) {
        this.nativeFault = true;
        group.requiresDisposal = true;
        return this.fail(
          group,
          failure(
            'static-residency-fault',
            `native retirement requires owner disposal: ${String(cause)}`,
            member.entity,
          ),
        );
      }
      this.members.delete(member.entity);
      group.retired++;
    }
    if (group.retired === group.members.length) {
      this.groups.delete(group);
      group.source.dispose();
      group.meshChanges?.dispose();
      group.phase = 'retired';
    }
    return ok(this.status(group));
  }
  /** Query absence is not native retirement for a registered resident member. */
  reconcile(world: World, entity: number): PhysicsSyncDescriptor | undefined {
    const entry = this.members.get(entity);
    if (entry === undefined) return;
    if (entry.group.world !== world)
      throw failure('static-residency-stale', 'resident World changed', entity);
    const { group, member } = entry;
    if (group.phase === 'retiring' || (!group.active && group.failure !== undefined))
      return member.descriptor;
    if (group.failure !== undefined) throw group.failure;
    if (
      !group.source.isCurrent() ||
      (member.handle !== undefined && this.host.body(entity)?.handle !== member.handle)
    ) {
      const reason = failure('static-residency-stale', 'resident member changed', entity);
      this.fail(group, reason);
      throw reason;
    }
    return entry.member.descriptor;
  }
  /** One source guard per group before shared native asset adoption, without rescanning inactive ECS rows. */
  validateSources(world: World): void {
    for (const group of this.groups) {
      if (group.phase === 'retiring' || group.phase === 'failed') continue;
      if (group.world !== world) throw failure('static-residency-stale', 'resident World changed');
      if (!group.guard().ok || !group.source.isCurrent() || !this.meshInputsCurrent(group)) {
        const reason = failure('static-residency-stale', 'resident source or World changed');
        this.fail(group, reason);
        if (group.active) throw reason;
      }
    }
  }
  owns(entity: number): boolean {
    return this.members.has(entity);
  }
  detach(world: World): void {
    this.host.check();
    for (const group of this.groups) {
      if (group.world !== world) continue;
      if (group.requiresDisposal)
        throw failure('static-residency-fault', 'owner disposal is required');
      for (const member of group.members) {
        try {
          if (member.handle !== undefined) this.host.remove(member.entity, member.handle);
        } catch (cause) {
          this.nativeFault = true;
          group.requiresDisposal = true;
          const reason = failure(
            'static-residency-fault',
            `native detach requires owner disposal: ${String(cause)}`,
            member.entity,
          );
          this.fail(group, reason);
          throw reason;
        }
        this.members.delete(member.entity);
      }
      group.source.dispose();
      group.meshChanges?.dispose();
      group.phase = 'closed';
      this.groups.delete(group);
    }
  }
  inspect() {
    return { groups: this.groups.size, residents: this.members.size, faulted: this.faulted };
  }
  close(): void {
    this.closed = true;
    for (const group of this.groups) {
      group.source.dispose();
      group.meshChanges?.dispose();
      group.phase = 'closed';
    }
    this.groups.clear();
    this.members.clear();
  }
}
