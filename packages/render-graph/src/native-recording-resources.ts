import type { RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { BoundGraphResources } from './bound-resources.js';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import {
  type CompiledView,
  handleData,
  LINEAR_PASS_ACCESS_LIMIT,
  type PhysicalGraphSlots,
} from './kernel-internal.js';
import type {
  GraphPass,
  GraphPassPreparation,
  GraphPreparationResources,
  GraphPreparationStep,
  GraphTextureView,
  RenderGraphFrame,
} from './types.js';

export interface PassResourcePreparation {
  readonly name: string;
  readonly kind: GraphPass<RenderGraphFrame>['kind'];
  readonly accessStart: number;
  readonly accessEnd: number;
  readonly prepareResources: GraphPassPreparation['prepareResources'];
  readonly preparedResourcesCurrent: GraphPassPreparation['preparedResourcesCurrent'];
}

/** Fixed physical operands and the original native preparation recipes. */
export interface BoundRenderGraphResources extends GraphPreparationResources {
  isRetired(): boolean;
  preparedResourcesCurrent(): boolean;
  prepareResources(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>>;
}

export function passGrantsAccess(
  accessIds: Uint32Array,
  pass: { readonly accessStart: number; readonly accessEnd: number },
  id: number,
): boolean {
  let lo = pass.accessStart;
  let hi = pass.accessEnd;
  if (hi - lo <= LINEAR_PASS_ACCESS_LIMIT) {
    for (; lo < hi; lo++) if (accessIds[lo] === id) return true;
    return false;
  }
  while (lo < hi) {
    const middle = lo + Math.floor((hi - lo) / 2);
    const value = accessIds[middle] as number;
    if (value === id) return true;
    if (value < id) lo = middle + 1;
    else hi = middle;
  }
  return false;
}

export function resolutionError(label: string, cause?: unknown): RenderGraphError {
  return new RenderGraphError(
    {
      code: 'resource-resolution-failed',
      expected: `resource '${label}' resolves to a live RHI handle for this frame`,
      hint: `repair the imported owner for '${label}' before executing the graph`,
      detail: {
        resourceLabel: label,
        ...(cause === undefined ? {} : { accesses: [String(cause)] }),
      },
    },
    cause === undefined ? undefined : { cause },
  );
}

/** One admission covers a synchronous prepare, resolve or encode step. */
export class NativeRecordingResources<Frame extends RenderGraphFrame>
  implements BoundRenderGraphResources
{
  private retired = false;
  private busy = false;

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly physical: PhysicalGraphSlots<Frame>,
    private readonly nativeInputs: BoundGraphResources<Frame>['nativeInputs'],
    private readonly accessIds: Uint32Array,
    private readonly preparations: readonly PassResourcePreparation[],
  ) {}

  isRetired(): boolean {
    return this.retired;
  }

  isBusy(): boolean {
    return this.busy;
  }

  enter(): boolean {
    if (this.retired || this.busy) return false;
    this.busy = true;
    return true;
  }

  leave(): void {
    this.busy = false;
  }

  revoke(): void {
    this.retired = true;
  }

  preparedResourcesCurrent(): boolean {
    if (this.retired || !this.nativeImportsCurrent()) return false;
    for (const pass of this.preparations) {
      if (pass.preparedResourcesCurrent?.() === false || this.retired) return false;
    }
    return !this.retired;
  }

  prepareResources(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    let closed = false;
    let advancing = false;
    let finished = false;
    let closingValue: Result<void, RenderGraphError> | undefined;
    const work = this.prepareResourceSteps(() => !closed && current() && !closed);
    const next = work.next.bind(work);
    const finish = work.return.bind(work);
    const close = (value: Result<void, RenderGraphError>) => {
      closed = true;
      closingValue = value;
      if (!advancing && !finished) {
        finished = true;
        finish(value);
      }
      return { done: true as const, value };
    };
    return Object.freeze(
      Object.assign(work, {
        return: close,
        throw: (cause?: unknown) => {
          close(err(this.preparationInvalid()));
          throw cause;
        },
        next: (value?: unknown) => {
          if (closed || !this.enter()) return close(err(this.preparationInvalid()));
          // Admission covers one synchronous resume, never an ordinary frame between yields.
          advancing = true;
          try {
            const result = next(value);
            if (result.done) {
              closed = true;
              finished = true;
            }
            return closed && !result.done && closingValue !== undefined
              ? { done: true as const, value: closingValue }
              : result;
          } finally {
            advancing = false;
            this.leave();
            if (closed && !finished && closingValue !== undefined) close(closingValue);
          }
        },
      }),
    );
  }

  private preparationInvalid(): RenderGraphError {
    return new RenderGraphError({
      code: 'graph-preparation-invalid',
      expected: 'the original idle live graph and current native preparation inputs',
      hint: 'reprepare from the original owners outside encoding and import resolution',
      detail: { generation: this.generation },
    });
  }

  private *prepareResourceSteps(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    const live = () => !this.retired && current() && !this.retired;
    const imports = yield* this.prepareNativeImports(live);
    if (!imports.ok) return imports;
    for (const pass of this.preparations) {
      try {
        if (!live()) return err(this.preparationInvalid());
        const prepare = pass.prepareResources;
        if (prepare === undefined) continue;
        const resources = Object.freeze({
          createdTextureView: (resource: GraphTextureView): TextureView | undefined => {
            if (this.retired) return undefined;
            const data = handleData(resource);
            if (data?.kind !== 'texture-view' || !passGrantsAccess(this.accessIds, pass, data.id))
              return undefined;
            return this.createdTextureView(resource);
          },
        });
        const recipe = prepare(resources, live);
        let step = recipe.next();
        try {
          while (!step.done) {
            const value = yield step.value;
            // An ordinary frame may replace the View while its native recipe is suspended.
            if (!live()) return err(this.preparationInvalid());
            step = recipe.next(value);
          }
        } finally {
          if (!step.done) recipe.return(undefined);
        }
        if (!live()) return err(this.preparationInvalid());
      } catch (cause) {
        return err(
          new RenderGraphError({
            code: 'pass-preparation-failed',
            expected: `pass '${pass.name}' prepares native resources without encoding`,
            hint: 'inspect the original native owner failure in detail.cause',
            detail: { passName: pass.name, passKind: pass.kind, cause },
          }),
        );
      }
    }
    return live() ? ok(undefined) : err(this.preparationInvalid());
  }

  /** Fixed native ownership only: this never resolves a frame, allocates or grants execution. */
  createdTextureView(resource: GraphTextureView): TextureView | undefined {
    const data = handleData(resource);
    if (this.retired || data?.owner !== this.owner || data.kind !== 'texture-view')
      return undefined;
    const texture = this.physical.resource(data.textureId);
    const view = this.physical.view(data.id);
    return texture?.kind === 'texture' &&
      texture.origin === 'created' &&
      view?.resolve === undefined
      ? view?.handle
      : undefined;
  }

  importedTextureView(
    compiled: CompiledView<Frame>,
    texture: Texture,
    current?: () => boolean,
  ): Result<TextureView, RenderGraphError> {
    if (current?.() === false) return err(this.preparationInvalid());
    const previous = compiled.preparedImport;
    if (previous?.texture === texture) return previous.view;
    const created = this.device.createTextureView(texture, compiled.descriptor);
    if (!created.ok) return err(resolutionError(compiled.label, created.error));
    if (current?.() === false || this.retired) return err(this.preparationInvalid());
    if (previous === undefined) compiled.preparedImport = { texture, view: created };
    else {
      previous.texture = texture;
      previous.view = created;
    }
    return created;
  }

  private *prepareNativeImports(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    for (const record of this.nativeInputs) {
      const { native: owner, nativeViews } = record;
      if (owner === undefined || nativeViews === undefined) continue;
      try {
        if (!current()) return err(this.preparationInvalid());
        const texture = yield* owner.prepare(current);
        const live = () => current() && owner.current() === texture && !this.retired;
        if (!live()) return err(this.preparationInvalid());
        for (const view of nativeViews) {
          const prepared = this.importedTextureView(view, texture, live);
          if (!prepared.ok) return prepared;
          yield;
          if (!live()) return err(this.preparationInvalid());
        }
        record.preparedNativeTexture = texture;
      } catch (cause) {
        if (cause instanceof RhiError && cause.code === 'rhi-descriptor-invalid' && !current())
          return err(this.preparationInvalid());
        return err(resolutionError(record.label, cause));
      }
    }
    return ok(undefined);
  }

  private nativeImportsCurrent(): boolean {
    if (this.retired) return false;
    for (const record of this.nativeInputs) {
      const actual = record.native?.current();
      const { nativeViews } = record;
      if (
        actual === undefined ||
        nativeViews === undefined ||
        record.preparedNativeTexture !== actual ||
        this.retired
      )
        return false;
      for (const view of nativeViews) if (view.preparedImport?.texture !== actual) return false;
    }
    return !this.retired;
  }
}
