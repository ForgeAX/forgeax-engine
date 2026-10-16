import { runInheritanceCases } from './smoke/cases/inheritance.mjs';
import { runPipelineFalsifierCases } from './smoke/cases/pipeline-falsifier.mjs';
import { runPostFalsifierCases } from './smoke/cases/post-falsifier.mjs';
import { runResizeCases } from './smoke/cases/resize.mjs';

// The smoke entry is a single executor over independently scoped scenario
// families. Each case module declares its facts and assertions; ordering is
// explicit here so adding a family cannot depend on VM/global lexical state.
const scenarioFamilies = [
  ['inheritance', runInheritanceCases],
  ['pipeline-falsifier', runPipelineFalsifierCases],
  ['resize', runResizeCases],
  ['post-falsifier', runPostFalsifierCases],
];

for (const [name, execute] of scenarioFamilies) {
  console.log(`[m3-programmable] scenario family: ${name}`);
  await execute();
}
