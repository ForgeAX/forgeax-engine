import type { FrameModel } from './frame-model';
import { summarizePasses, workPipelineLabel } from './pass-summary';

/**
 * A bounded per-pass and per-work inventory with pipeline and target labels.
 * Shader source and descriptors stay in inspect.
 */
export function summarizeFrame(model: FrameModel) {
  return {
    commandCount: model.commands.length,
    passCount: model.passes.length,
    resourceCount: model.resources.length,
    passes: summarizePasses(model),
    unseededResources: model.unseededResources,
    works: model.works.map((work) => {
      const command = model.commands[work.commandIndex];
      return {
        workIndex: work.workIndex,
        eventIndex: work.eventIndex,
        passIndex: work.passIndex,
        kind: work.kind,
        group: command?.group ?? [],
        pipelineId: work.pipeline.pipelineHandleId ?? null,
        pipelineLabel: workPipelineLabel(work),
        entryPoints: work.pipeline.shaders.map(({ stage, entryPoint }) => ({ stage, entryPoint })),
        attachments: work.attachments,
      };
    }),
  };
}

export type FrameSummary = ReturnType<typeof summarizeFrame>;
