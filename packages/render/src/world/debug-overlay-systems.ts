import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Mat4 } from '@forgeax/engine-math';
import type { BindGroup, RhiRenderPassEncoder, TextureFormat } from '@forgeax/engine-rhi';
import { DebugOverlayFailedError } from '../errors/render';
import type { GpuBuffer } from '../gpu-resource';
import type { RenderSystemInternals } from '../record/render-context';
import type {
  DebugOverlayFailureCode,
  DebugOverlayInspection,
  DebugOverlayOutcome,
  RenderDebugOverlay,
} from '../render-contract';
import { type DebugOverlayHost, DebugOverlayResidency } from './debug-overlay-residency';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderPrepare, renderSubmission } from './render-world';
import { readViewField, requireViewField } from './view-field';
import { RENDER_VIEW_FRAME_SYSTEM, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf } from './view-settlement';

export const RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM = 'render-debug-overlay-prepare';
export const RENDER_DEBUG_OVERLAY_DISCARD_SYSTEM = 'render-debug-overlay-discard';

export const DebugOverlayHolder = Object.freeze({ name: 'DebugOverlayHolder' });

/** The Renderer's overlay state: its GPU residency and latest frame outcome. The source is `internals.debugOverlay`. */
export interface DebugOverlayHolderState {
  readonly residency: DebugOverlayResidency;
  /** The frame-level outcome of the latest prepare; `undefined` before the first overlay frame. */
  outcome: DebugOverlayOutcome | undefined;
  /** Codes reported and not yet cleared by a frame without them. */
  readonly reported: Set<DebugOverlayFailureCode>;
  readonly failing: Set<DebugOverlayFailureCode>;
}

interface ViewDebugOverlayState {
  frame: number;
  outcome: DebugOverlayOutcome;
  binding: { readonly uniform: GpuBuffer; readonly bindGroup: BindGroup } | undefined;
}

/** A recording view's prepared overlay outcome; written only by `render-debug-overlay-prepare`. */
export const ViewDebugOverlay = defineComponent('ViewDebugOverlay', {
  state: 'unique<ViewDebugOverlay>',
});

export function debugOverlayHolderOf(
  world: World | undefined,
): DebugOverlayHolderState | undefined {
  return world?.hasResource(DebugOverlayHolder) === true
    ? world.getResource<DebugOverlayHolderState>(DebugOverlayHolder)
    : undefined;
}

function hostOf(internals: RenderSystemInternals): DebugOverlayHost {
  return {
    device: internals.device,
    scope: recordContext(internals).deviceScope,
    shaderModules: internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory,
  };
}

function reportFailure(
  holder: DebugOverlayHolderState,
  internals: RenderSystemInternals,
  code: DebugOverlayFailureCode,
  cause: unknown,
): void {
  holder.failing.add(code);
  if (holder.reported.has(code)) return;
  holder.reported.add(code);
  internals.errorRegistry.fire(new DebugOverlayFailedError(code, cause));
}

function viewStateOf(world: World, entity: EntityHandle): ViewDebugOverlayState | undefined {
  if (!world.hasComponent(entity, ViewDebugOverlay)) return undefined;
  return world
    .resolveUniqueRef<ViewDebugOverlayState>(
      requireViewField(world, entity, ViewDebugOverlay, 'state'),
    )
    .unwrap();
}

/** The view's overlay outcome prepared this Renderer frame; undefined when the prepare system did not run for it. */
export function viewDebugOverlayOf(
  world: World,
  entity: EntityHandle | undefined,
): DebugOverlayOutcome | undefined {
  if (entity === undefined) return undefined;
  const state = viewStateOf(world, entity);
  return state?.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** Detached projection for `Renderer.inspect().debugOverlay`. */
export function inspectDebugOverlay(world: World | undefined): DebugOverlayInspection | undefined {
  const outcome = debugOverlayHolderOf(world)?.outcome;
  if (outcome === undefined) return undefined;
  switch (outcome.kind) {
    case 'none':
      return { frame: outcome.frame, kind: 'none' };
    case 'staged':
      return {
        frame: outcome.frame,
        kind: 'staged',
        vertexCount: outcome.vertexCount,
        truncated: outcome.truncated,
      };
    case 'failed':
      return { frame: outcome.frame, kind: 'failed', code: outcome.code };
  }
}

/** The one frame-level prepare: take the source once, upload once, report failures. */
function prepareFrame(
  holder: DebugOverlayHolderState,
  internals: RenderSystemInternals | undefined,
  frame: number,
): DebugOverlayOutcome {
  const source = internals?.debugOverlay;
  if (internals === undefined || source === undefined) return { kind: 'none', frame };
  let batch: ReturnType<RenderDebugOverlay['take']>;
  try {
    batch = source.take();
  } catch (cause) {
    return { kind: 'failed', frame, code: 'overlay-source-failed', cause };
  }
  if (batch === null || batch.vertexCount === 0) return { kind: 'none', frame };
  const uploaded = holder.residency.upload(hostOf(internals), batch);
  if (!uploaded.ok) return { kind: 'failed', frame, code: uploaded.code, cause: uploaded.cause };
  return { kind: 'staged', frame, vertexCount: batch.vertexCount, truncated: batch.truncated };
}

/**
 * Register `render-debug-overlay-prepare` (RenderPrepare) and
 * `render-debug-overlay-discard` (RenderCleanup). The source is taken exactly
 * once per Renderer frame, so a frame that never draws still consumes its
 * geometry. A failure skips the overlay and is reported once per code; the
 * scene frame continues.
 */
export function registerDebugOverlaySystems(world: World): void {
  if (world.hasResource(DebugOverlayHolder)) return;
  const holder: DebugOverlayHolderState = {
    residency: new DebugOverlayResidency(),
    outcome: undefined,
    reported: new Set(),
    failing: new Set(),
  };
  world.insertResource(DebugOverlayHolder, holder);
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewDebugOverlay] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        holder.failing.clear();
        const staged: {
          entity: EntityHandle;
          internals: RenderSystemInternals;
          existing: ViewDebugOverlayState | undefined;
        }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const view = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (view.frame !== frame || view.result?.ok !== true || view.mode !== true) return;
          staged.push({
            entity: entity,
            internals: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'))
              .internals,
            existing: viewStateOf(world, entity),
          });
        });
        const outcome = prepareFrame(holder, staged[0]?.internals, frame);
        if (
          staged.length > 0 &&
          (staged[0]?.internals.debugOverlay !== undefined || holder.outcome !== undefined)
        )
          holder.outcome = outcome;
        const first: { entity: EntityHandle; state: ViewDebugOverlayState }[] = [];
        for (const { entity, internals, existing } of staged) {
          let viewOutcome = outcome;
          let binding: ViewDebugOverlayState['binding'];
          if (outcome.kind === 'staged') {
            binding = existing?.binding;
            if (binding === undefined) {
              const created = holder.residency.viewBinding(
                hostOf(internals),
                internals.debugOverlay?.shader as NonNullable<
                  typeof internals.debugOverlay
                >['shader'],
                recordContext(internals).deviceScope,
              );
              if (created.ok) binding = created.value;
              else
                viewOutcome = { kind: 'failed', frame, code: created.code, cause: created.cause };
            }
          }
          if (viewOutcome.kind === 'failed')
            reportFailure(holder, internals, viewOutcome.code, viewOutcome.cause);
          if (existing === undefined) {
            first.push({ entity, state: { frame, outcome: viewOutcome, binding } });
            continue;
          }
          existing.frame = frame;
          existing.outcome = viewOutcome;
          existing.binding = binding;
        }
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewDebugOverlay,
              data: { state: world.allocUniqueRef('ViewDebugOverlay', state) },
            })
            .unwrap();
        // A failure code stops being reported only after a frame without it.
        for (const code of [...holder.reported])
          if (!holder.failing.has(code)) holder.reported.delete(code);
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_DEBUG_OVERLAY_DISCARD_SYSTEM,
      queries: [{ read: [ViewDebugOverlay], optional: [ViewSubmission] }],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (
            readViewField(world, entity, ViewSubmission, 'accepted') === true &&
            requireViewField(world, entity, ViewSubmission, 'attempt') === frame
          )
            return;
          // A view that did not draw this frame leaves no staged outcome behind.
          const state = world
            .resolveUniqueRef<ViewDebugOverlayState>(
              requireViewField(world, entity, ViewDebugOverlay, 'state'),
            )
            .unwrap();
          if (state.outcome.kind === 'staged') state.outcome = { kind: 'none', frame };
        });
        if (!renderSubmission(world).accepted && holder.outcome?.kind === 'staged')
          holder.outcome = { kind: 'none', frame };
      },
    })
    .unwrap();
}

/**
 * The `debug-overlay` pass: the prepared outcome of the view. Throws when
 * `render-debug-overlay-prepare` did not run; a failed outcome draws nothing.
 */
export function consumeDebugOverlay(runtime: {
  readonly renderWorld?: World | undefined;
  readonly viewEntity?: EntityHandle | undefined;
}): DebugOverlayOutcome {
  const outcome =
    runtime.renderWorld === undefined
      ? undefined
      : viewDebugOverlayOf(runtime.renderWorld, runtime.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM} did not prepare this view's overlay`);
  return outcome;
}

/** Draw the staged batch into `pass`; any failure skips the overlay and is reported. */
export function encodeDebugOverlay(
  runtime: RenderSystemInternals,
  pass: RhiRenderPassEncoder,
  viewProj: Mat4,
  format: TextureFormat,
): void {
  const world = runtime.renderWorld;
  const holder = debugOverlayHolderOf(world);
  const source = runtime.debugOverlay;
  const entity = runtime.viewEntity;
  if (world === undefined || holder === undefined || source === undefined || entity === undefined)
    throw new Error(`${RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM} did not prepare this view's overlay`);
  const state = viewStateOf(world, entity);
  const outcome = consumeDebugOverlay(runtime);
  if (outcome.kind !== 'staged' || state?.binding === undefined) return;
  const skip = (code: DebugOverlayFailureCode, cause: unknown): void => {
    state.outcome = { kind: 'failed', frame: outcome.frame, code, cause };
    holder.outcome = state.outcome;
    reportFailure(holder, runtime, code, cause);
  };
  const host = hostOf(runtime);
  const pipeline = holder.residency.pipelineFor(host, source.shader, format);
  if (!pipeline.ok) {
    skip(pipeline.code, pipeline.cause);
    return;
  }
  const vertexBuffer = holder.residency.vertexBuffer;
  if (vertexBuffer === undefined) {
    skip('overlay-upload-failed', new Error('no vertex buffer'));
    return;
  }
  const written = runtime.device.queue.writeBuffer(
    state.binding.uniform.handle,
    0,
    new Float32Array(viewProj),
    0,
    64,
  );
  if (!written.ok) {
    skip('overlay-upload-failed', written.error);
    return;
  }
  pass.setPipeline(pipeline.value);
  pass.setBindGroup(0, state.binding.bindGroup);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(outcome.vertexCount);
}

/** The `debugOverlay` field of `Renderer.inspect()`; empty until an overlay frame ran. */
export function debugOverlayInspectionField(world: World | undefined): {
  readonly debugOverlay?: DebugOverlayInspection;
} {
  const debugOverlay = inspectDebugOverlay(world);
  return { ...(debugOverlay === undefined ? {} : { debugOverlay }) };
}
