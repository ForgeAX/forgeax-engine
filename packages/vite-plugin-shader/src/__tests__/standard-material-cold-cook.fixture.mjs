import { parentPort } from 'node:worker_threads';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';

const cooker = createMaterialPackCooker();
parentPort.on('message', async (input) => {
  try {
    const draft = await cooker.cook(input);
    const record = validateCookedMaterialRecord(draft.payload.cooked).unwrap();
    parentPort.postMessage({
      artifacts: Object.keys(draft.artifacts).length,
      selections: record.programs.flatMap((program) =>
        program.selections.map(({ address, context, entry, pass, abi }) => ({
          address,
          context,
          entry,
          pass,
          vertexColor: abi?.vertexInputs.some((input) => input.semantic === 'color'),
        })),
      ),
    });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});
