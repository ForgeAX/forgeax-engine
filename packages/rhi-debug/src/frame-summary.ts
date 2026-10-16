import type { FrameModel } from './frame-model';

/** A bounded per-work inventory. Shader source and descriptors stay in inspect. */
export function summarizeFrame(model: FrameModel) {
  return {
    commandCount: model.commands.length,
    passCount: model.passes.length,
    resourceCount: model.resources.length,
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
        entryPoints: work.pipeline.shaders.map(({ stage, entryPoint }) => ({ stage, entryPoint })),
        attachments: work.attachments,
      };
    }),
  };
}

export type FrameSummary = ReturnType<typeof summarizeFrame>;
