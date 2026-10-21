import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { PMREM_FACES_PER_STEP, pmremExtent, pmremViewport } from '../ibl/pmrem';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { ReflectionProbeGraphWork } from './typed-frame-graph';

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
  const added = builder.addRasterPass(
    `reflection-probe.${work.probeIndex}.pmrem.${step.mipLevel}.${step.faceIndex}`,
    {
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
      encode: ({ pass }) => {
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
      },
    },
  );
  if (!added.ok) return added;
  const copied = builder.addCopyPass(
    `reflection-probe.${work.probeIndex}.pmrem-copy.${step.mipLevel}.${step.faceIndex}`,
    {
      accesses: [
        { resource: filteredAtlas, usage: 'copy-src' },
        { resource: scratchView.value, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        for (let offset = 0; offset < PMREM_FACES_PER_STEP; offset++) {
          const viewport = pmremViewport(work.filteredSize, step.mipLevel, step.faceIndex + offset);
          encoder.copyTextureToTexture(
            {
              texture: resources.texture(filtered).unwrap(),
              origin: [viewport.x, viewport.y, 0],
            },
            {
              texture: resources.texture(scratch.value).unwrap(),
              origin: [viewport.x, viewport.y, 0],
            },
            { width: viewport.width, height: viewport.height, depthOrArrayLayers: 1 },
          );
        }
      },
    },
  );
  if (!copied.ok) return copied;
  return ok(undefined);
}
