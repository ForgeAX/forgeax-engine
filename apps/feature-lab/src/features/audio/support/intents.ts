import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { AudioIntent } from '@forgeax/engine/audio';
import {
  audioBackendPlugin,
  audioContribution,
  audioPlugin,
  createAudioIntentBackend,
} from '@forgeax/engine/audio';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { scenePlugin } from '@forgeax/engine/scene';

export async function createIntentWorld() {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({
    emit: (intent) => {
      intents.push(intent);
    },
  });
  const ctx = await createWorldContext(world, [
    scenePlugin(),
    audioBackendPlugin(backend),
    audioPlugin(),
  ]);
  const drain = (): AudioIntent[] => intents.splice(0, intents.length);
  const step = (): AudioIntent[] => {
    world.update(1 / 60).unwrap();
    return drain();
  };
  return {
    world,
    backend,
    step,
    drain,
    async dispose() {
      await ctx.fiber.dispose();
      world.despawnAll().unwrap();
      assets.dispose();
    },
  };
}

export const kinds = (intents: readonly AudioIntent[]): string[] =>
  intents.map((intent) => intent.kind);
