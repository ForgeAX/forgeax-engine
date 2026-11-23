import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphNativeCommands,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type {
  RenderPassDescriptor,
  RhiCommandEncoder,
  RhiRenderPassEncoder,
  Texture,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { PMREM_FACES_PER_STEP, pmremExtent, pmremViewport } from '../ibl/pmrem';
import { copyPmremLayers, pmremMigrationName } from '../reflection/pmrem-array';
import type { RenderPipelineFrame } from '../render-pipeline';
import type {
  ReflectionProbeFilterGraphWork,
  ReflectionProbeGraphState,
  ReflectionProbeGraphWork,
} from './frame-graph-history';
import type { _InternalRenderPipelineContext } from './render-context';

export const REFLECTION_PROBE_FILTER_PHASES = {
  migrate: { kind: 'copy', name: 'reflection-pmrem-migrate' },
  filter: { kind: 'raster', name: 'reflection-probe-filter' },
  copy: { kind: 'copy', name: 'reflection-probe-filter-copy' },
} as const;

function filterName(index: number, step: ReflectionProbeFilterGraphWork, copy: boolean): string {
  return `reflection-probe.${index}.${copy ? 'pmrem-copy' : 'pmrem'}.${step.mipLevel}.${step.faceIndex}`;
}

function drawProbeTiles(
  pass: RhiRenderPassEncoder,
  work: ReflectionProbeGraphWork,
  step: ReflectionProbeFilterGraphWork,
): void {
  if (work.filterGroup0 === undefined) return;
  pass.setPipeline(work.filterPipeline);
  pass.setBindGroup(1, work.filterGroup1);
  for (let offset = 0; offset < PMREM_FACES_PER_STEP; offset++) {
    const group = work.filterGroup0[offset];
    if (group === undefined) continue;
    const viewport = pmremViewport(work.filteredSize, step.mipLevel, step.faceIndex + offset);
    pass.setBindGroup(0, group);
    pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    pass.setScissorRect(viewport.x, viewport.y, viewport.width, viewport.height);
    pass.draw(3);
  }
}

function copyProbeTiles(
  encoder: RhiCommandEncoder,
  source: Texture,
  scratch: Texture,
  work: ReflectionProbeGraphWork,
  step: ReflectionProbeFilterGraphWork,
): void {
  for (let offset = 0; offset < PMREM_FACES_PER_STEP; offset++) {
    const tile = pmremViewport(work.filteredSize, step.mipLevel, step.faceIndex + offset);
    encoder.copyTextureToTexture(
      { texture: source, origin: [tile.x, tile.y, work.filteredLayer ?? 0] },
      { texture: scratch, origin: [tile.x, tile.y, 0] },
      { width: tile.width, height: tile.height, depthOrArrayLayers: 1 },
    );
  }
}

/** Capture faces have already recorded. Filtering writes the reflection owner's candidate
 * layer and private scratch. Receivers keep their submitted layer until the owning fence. */
function probeFilterCommands(): RenderGraphNativeCommands<RenderPipelineFrame> {
  let migration: NonNullable<ReflectionProbeGraphState['migrations']>[number] | undefined;
  let work: ReflectionProbeGraphWork | undefined;
  let step: ReflectionProbeFilterGraphWork | undefined;
  let name = '';
  function current<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Probe filter work requires its current recording');
    return value;
  }
  const migrate: RenderGraphNativePass = {
    kind: 'copy',
    get name() {
      return name;
    },
    profileName: REFLECTION_PROBE_FILTER_PHASES.migrate.name,
    encode(encoder) {
      const move = current(migration);
      copyPmremLayers(encoder, move, move.source.texture, move.target.texture);
    },
  };
  function filterAttachment(loadOp: 'clear' | 'load'): RenderPassDescriptor {
    return {
      get label() {
        return name;
      },
      colorAttachments: [
        {
          get view() {
            return current(work).filteredView;
          },
          loadOp,
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    };
  }
  const startAtlas = filterAttachment('clear');
  const continueAtlas = filterAttachment('load');
  const filter: RenderGraphNativePass = {
    kind: 'raster',
    get name() {
      return name;
    },
    profileName: REFLECTION_PROBE_FILTER_PHASES.filter.name,
    get descriptor() {
      const tile = current(step);
      return tile.mipLevel === 0 && tile.faceIndex === 0 ? startAtlas : continueAtlas;
    },
    encode(pass) {
      drawProbeTiles(pass, current(work), current(step));
    },
  };
  const copy: RenderGraphNativePass = {
    kind: 'copy',
    get name() {
      return name;
    },
    profileName: REFLECTION_PROBE_FILTER_PHASES.copy.name,
    encode(encoder) {
      const source = current(work);
      copyProbeTiles(
        encoder,
        source.filteredTexture,
        source.filterScratchTexture,
        source,
        current(step),
      );
    },
  };
  return (frame, _resources, issue, recording) => {
    const state = (frame as _InternalRenderPipelineContext).probeFilterWork;
    if (state === undefined) return;
    try {
      if (state.migrations !== undefined)
        for (const move of state.migrations) {
          if (move.source.texture === move.target.texture)
            throw new Error('PMREM migration requires distinct array generations');
          migration = move;
          name = pmremMigrationName(move);
          issue(recording, migrate);
        }
      for (const job of state.work) {
        if (job.step === undefined) continue;
        if (
          job.filteredTexture === job.rawTexture ||
          job.filteredTexture === job.filterScratchTexture
        )
          throw new Error(
            'PMREM filtering requires separate source, destination and scratch textures',
          );
        work = job;
        step = job.step;
        name = filterName(job.probeIndex, step, false);
        issue(recording, filter);
        name = filterName(job.probeIndex, step, true);
        issue(recording, copy);
      }
    } finally {
      work = step = migration = undefined;
      name = '';
    }
  };
}

export function appendReflectionProbeFilterNames(
  state: ReflectionProbeGraphState | undefined,
  out: string[],
): void {
  if (state === undefined) return;
  for (const migration of state.migrations ?? []) out.push(pmremMigrationName(migration));
  for (const work of state.work) {
    if (work.step !== undefined)
      out.push(
        filterName(work.probeIndex, work.step, false),
        filterName(work.probeIndex, work.step, true),
      );
  }
}

/** The native stage owns its candidate atlas ports. Exact graph-target capture
 * still declares these resources in the inspection graph. */
export function addCurrentReflectionProbeFilters(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
): Result<void, RenderGraphError> {
  const stateOf = (frame: RenderPipelineFrame) =>
    (frame as _InternalRenderPipelineContext).probeFilterWork;
  return builder.addSubgraphPass('reflection-probe-filters', {
    accesses: [],
    executeIf(frame) {
      const state = stateOf(frame);
      return state !== undefined && (state.work.length > 0 || (state.migrations?.length ?? 0) > 0);
    },
    commandsDirect: probeFilterCommands(),
    appendPassNames: (frame, output) => appendReflectionProbeFilterNames(stateOf(frame), output),
  });
}

/** One scheduled probe filter step writes its atlas tiles, then seeds the next step. */
export function addReflectionProbePmremPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  work: ReflectionProbeGraphWork,
  rawCube: GraphTextureView,
  filtered: GraphTexture,
  filteredAtlas: GraphTextureView,
): Result<void, RenderGraphError> {
  const step = work.step;
  if (step === undefined) return ok(undefined);
  const scratch = builder.importTexture(
    `reflection-probe.${work.probeIndex}.filter-scratch`,
    {
      format: work.outputFormat,
      size: pmremExtent(work.filteredSize),
      usage: 0x17,
    },
    () => work.filterScratchTexture,
  );
  if (!scratch.ok) return scratch;
  const scratchView = builder.importView(
    scratch.value,
    { dimension: '2d' },
    () => work.filterScratchView,
  );
  if (!scratchView.ok) return scratchView;
  const added = builder.addRasterPass(filterName(work.probeIndex, step, false), {
    accesses: [
      { resource: rawCube, usage: 'sampled-read' },
      { resource: scratchView.value, usage: 'sampled-read' },
      { resource: filteredAtlas, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: filteredAtlas,
        loadOp: step.mipLevel === 0 && step.faceIndex === 0 ? 'clear' : 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encodeDirect: (pass) => drawProbeTiles(pass, work, step),
  });
  if (!added.ok) return added;
  const copied = builder.addCopyPass(filterName(work.probeIndex, step, true), {
    accesses: [
      { resource: filteredAtlas, usage: 'copy-src' },
      { resource: scratchView.value, usage: 'copy-dst' },
    ],
    encodeDirect: (encoder, _frame, resources) =>
      copyProbeTiles(
        encoder,
        resources.texture(filtered).unwrap(),
        resources.texture(scratch.value).unwrap(),
        work,
        step,
      ),
  });
  if (!copied.ok) return copied;
  return ok(undefined);
}
