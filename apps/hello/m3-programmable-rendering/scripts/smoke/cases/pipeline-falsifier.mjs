import {
  runComposedInheritancePipelineFalsifierRepeatability,
  runComposedInheritancePostRepeatability,
  runComposedInheritanceStartRepeatability,
} from './inheritance-executor.mjs';

// One declarative matrix owns all composed inheritance legs. The executor
// functions are scenario consumers; adding a case never duplicates the child
// command, artifact path, or oracle wiring.
const variantMatrix = [false, true].flatMap((msaa) =>
  [false, true].map((startVariant) => ({ msaa, startVariant: String(startVariant) })),
);
const scenarioMatrix = (post, falsifierKind) =>
  variantMatrix.map(({ msaa, startVariant }) => ({
    ...(post === undefined ? {} : { post }),
    msaa,
    startVariant,
    ...(falsifierKind === undefined ? {} : { falsifierKind }),
  }));
const inheritanceCases = [
  ...variantMatrix.map((scenario) => ({ kind: 'start', ...scenario })),
  ...variantMatrix.map((scenario) => ({ kind: 'pipeline', ...scenario })),
  ...variantMatrix.map((scenario) => ({ kind: 'post', ...scenario })),
  ...['pipeline', 'reverse-pipeline', 'reverse-pipeline-texture', 'pipeline-texture'].flatMap((kind) =>
    scenarioMatrix(undefined, kind).map((scenario) => ({ kind: 'post', ...scenario })),
  ),
  ...['reverse-pipeline', 'reverse-pipeline-texture', 'pipeline'].flatMap((kind) =>
    scenarioMatrix('inversion', kind).map((scenario) => ({ kind: 'post', ...scenario })),
  ),
  ...['pipeline', 'reverse-pipeline', 'reverse-pipeline-texture', 'texture', 'pipeline-texture'].flatMap((kind) =>
    scenarioMatrix('passthrough', kind).map((scenario) => ({ kind: 'post', ...scenario })),
  ),
  ...['texture', 'pipeline-texture'].flatMap((kind) =>
    scenarioMatrix('inversion', kind).map((scenario) => ({ kind: 'post', ...scenario })),
  ),
  ...scenarioMatrix('inversion', 'param').map((scenario) => ({ kind: 'post', ...scenario })),
  ...scenarioMatrix('passthrough', 'param').map((scenario) => ({ kind: 'post', ...scenario })),
  ...scenarioMatrix('depth', 'param').map((scenario) => ({ kind: 'post', ...scenario })),
];

export function runPipelineFalsifierCases() {
  for (const scenario of inheritanceCases) {
    switch (scenario.kind) {
      case 'start':
        runComposedInheritanceStartRepeatability(scenario);
        break;
      case 'pipeline':
        runComposedInheritancePipelineFalsifierRepeatability(scenario);
        break;
      case 'post':
        runComposedInheritancePostRepeatability(scenario);
        break;
    }
  }
}
