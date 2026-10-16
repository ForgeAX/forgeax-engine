import type { AudioIntent } from '@forgeax/engine/audio';
import { audioBackendPlugin, audioPlugin, createAudioIntentBackend } from '@forgeax/engine/audio';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { scenePlugin } from '@forgeax/engine/scene';

export async function createIntentWorld() {
  const world = new World();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  const ctx = await createWorldContext(world, [
    scenePlugin(),
    audioBackendPlugin(backend),
    audioPlugin(),
  ]);
  const drain = (): AudioIntent[] => intents.splice(0, intents.length);
  const step = (): AudioIntent[] => {
    world.update(1 / 60);
    return drain();
  };
  return { world, backend, step, drain, dispose: () => ctx.fiber.dispose() };
}

export const kinds = (intents: readonly AudioIntent[]): string[] =>
  intents.map((intent) => intent.kind);
