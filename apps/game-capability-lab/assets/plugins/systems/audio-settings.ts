import { defineSystem } from "@forgeax/engine-ecs";
import { Update, type World } from '@forgeax/engine-ecs';
import type { GameSettingsState } from '../settings';
import type { GameplayAudio } from '../gameplay-audio';

export function installAudioSettingsSystem(world: World, settings: GameSettingsState, gameplayAudio: GameplayAudio | undefined): void {
  let appliedVolume = -1;
  let appliedMuted = false;
  const systemToken1 = defineSystem({
    name: 'game-music-settings',
    queries: [],
    fn: () => {
      const volume = settings.music / 100;
      if (volume === appliedVolume && settings.musicMuted === appliedMuted) return;
      appliedVolume = volume;
      appliedMuted = settings.musicMuted;
      gameplayAudio?.setMusicSettings(volume, settings.musicMuted);
    },
  });
world.addSystem(Update, systemToken1).unwrap();
}
