import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Collider } from '@forgeax/engine-physics';
import type { RapierPhysicsWorld3D, StaticPhysicsGroup } from '@forgeax/engine-physics-rapier3d';
import type { SourceViewPreparation } from '@forgeax/engine-render/internal';
import { RhiError } from '@forgeax/engine-rhi';
import type { SceneRosterParticipation } from '@forgeax/engine-scene/internal';
import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  CandidateRenderHost,
  CandidateRenderSource,
  LevelRenderSelection,
} from './candidate-render-source';

/** One candidate's actual domain owners. App alone admits participation at a legal boundary. */
export class CandidateDomains {
  private physics: StaticPhysicsGroup | undefined;
  private native: SourceViewPreparation | undefined;
  private wait: Promise<void> | undefined;
  private waitFailure: { readonly cause: unknown } | undefined;
  private closing = false;
  private refreshViews = false;
  constructor(
    private readonly options: {
      readonly world: World;
      readonly members: readonly EntityHandle[];
      readonly effectiveMembers: readonly EntityHandle[];
      readonly source: SceneRosterParticipation;
      readonly render: CandidateRenderSource;
      readonly host: CandidateRenderHost;
      readonly prepareViews: (current: () => boolean) => SourceViewPreparation;
      readonly physics: RapierPhysicsWorld3D | undefined;
      readonly current: () => boolean;
      readonly stopped: (() => boolean) | undefined;
    },
  ) {}
  get pending(): Promise<void> | undefined {
    return this.wait;
  }
  private awaitWork(work: Promise<unknown>): void {
    const wait = work
      .then(
        () => {},
        (cause) => {
          this.waitFailure = { cause };
        },
      )
      .finally(() => {
        if (this.wait === wait) this.wait = undefined;
      });
    this.wait = wait;
  }
  private checkWait(): void {
    if (this.waitFailure !== undefined) throw this.waitFailure.cause;
  }
  *prepare(): Generator<void> {
    const { world, members, effectiveMembers, source, host, physics, current } = this.options;
    const effective = new Set(effectiveMembers);
    const colliders = members.filter((entity) => world.hasComponent(entity, Collider));
    if (colliders.length > 0) {
      if (physics === undefined)
        throw Error('a prepared static Level requires its actual Rapier3D owner');
      this.physics = physics
        ._beginStaticResidency(
          world,
          colliders.map((entity) => ({ entity, participates: effective.has(entity) })),
          () =>
            current() && host.current()
              ? source.capture().ok
                ? ok(undefined)
                : sourceFailure()
              : sourceFailure(),
          effectiveMembers.length,
        )
        .unwrap();
      while (this.physics.prepareStep().unwrap().phase !== 'prepared') yield;
    }
    yield* this.prepareNative();
  }
  private *prepareNative(): Generator<void> {
    const { render, current, prepareViews } = this.options;
    if (!render.hasRasterRows) return;
    for (;;) {
      const native = prepareViews(() => !this.closing && current() && render.isCurrent());
      this.native = native;
      try {
        for (;;) {
          this.checkWait();
          if (this.wait !== undefined) {
            yield;
            continue;
          }
          const next = native.next();
          if (next.done) break;
          if (next.value instanceof Promise) this.awaitWork(next.value);
          yield;
        }
        if (!this.isCurrent()) throw Error('the complete prepared Level demand changed');
        return;
      } catch (cause) {
        if (
          !(cause instanceof RhiError) ||
          cause.code !== 'rhi-descriptor-invalid' ||
          !native.isObsolete()
        )
          throw cause;
        yield* this.retireNative();
      }
    }
  }
  private *retireNative(): Generator<void> {
    const native = this.native;
    if (native === undefined) return;
    this.waitFailure = undefined;
    this.awaitWork(native.retire().then((result) => result.unwrap()));
    while (this.wait !== undefined) yield;
    this.checkWait();
    this.native = undefined;
  }
  invalidateViews(): void {
    this.refreshViews = true;
  }
  *reprepare(): Generator<void> {
    if (
      this.closing ||
      !this.options.current() ||
      !this.options.source.capture().ok ||
      !this.options.render.isCurrent() ||
      (this.physics !== undefined && !this.physics.isCurrent())
    )
      throw Error('a changed Level source requires a new candidate');
    yield* this.retireNative();
    this.refreshViews = false;
    yield* this.prepareNative();
  }
  viewsCurrent(): boolean {
    return (
      !this.refreshViews &&
      (!this.options.render.hasRasterRows || this.native?.isCurrent() === true)
    );
  }
  isCurrent(): boolean {
    return (
      !this.closing &&
      this.options.current() &&
      this.options.host.current() &&
      this.options.source.capture().ok &&
      this.options.render.isCurrent() &&
      this.viewsCurrent() &&
      (this.physics === undefined || this.physics.isCurrent())
    );
  }
  /** Only the App fixed-boundary or stopped-owner path calls this synchronous operation. */
  accept(active: boolean, publishSelection: boolean): void | Promise<LevelRenderSelection> {
    const { source, render, host, current } = this.options;
    this.checkWait();
    if (this.closing || !current() || !host.current() || (active && !this.isCurrent()))
      throw Error('Level participation requires current complete domain owners');
    const previous = source.capture().unwrap();
    const acceptSource = () => {
      const next = source.setActive(active, previous);
      if (!next.ok) return next;
      return render.acceptSource(next.value);
    };
    if (this.physics === undefined) acceptSource().unwrap();
    else this.physics.accept(active, acceptSource).unwrap();
    // The native/source callback may have partial effects on failure. Its owner retains them.
    if (publishSelection) return render.setActive(active).unwrap();
  }
  get canRetireStopped(): boolean {
    return (
      this.options.stopped?.() === true &&
      (this.physics === undefined || this.physics.inspect().phase === 'closed')
    );
  }
  get needsStop(): boolean {
    return (
      this.options.source.inspect().participation !== 'inactive' ||
      (this.physics !== undefined && this.physics.inspect().participation !== 'inactive')
    );
  }
  *retire(): Generator<void> {
    this.closing = true;
    const failures: unknown[] = [];
    while (this.wait !== undefined) yield;
    if (this.native !== undefined) {
      this.waitFailure = undefined;
      this.awaitWork(this.native.retire().then((result) => result.unwrap()));
      while (this.wait !== undefined) yield;
      try {
        this.checkWait();
        this.native = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (this.physics !== undefined) {
      try {
        while (
          this.physics.inspect().phase !== 'closed' &&
          this.physics.retireStep().unwrap().phase !== 'retired'
        )
          yield;
        this.physics = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Level domain retirement remains unconfirmed');
  }
}

function sourceFailure(): Result<void, Error> {
  return err(Error('fixed Level source changed'));
}
