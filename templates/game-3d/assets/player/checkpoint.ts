import type { GameHost, GameSave } from '@forgeax/engine/app';
import { AUDIO_ENGINE_RESOURCE_KEY } from '@forgeax/engine/audio';
import { FixedTime, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import { CHECKPOINT_CHANNEL, type Game3dPlayerService } from '../shared/player-protocol.ts';

const slot = 'checkpoint';

type Checkpoint = {
  position: readonly [number, number, number];
  view: { yaw: number; pitch: number };
};

function readCheckpoint(save: GameSave): Checkpoint | undefined {
  const data = save.data;
  if (save.version !== 1 || data === null || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const { x, y, z, yaw, pitch } = data;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
      typeof yaw !== 'number' || typeof pitch !== 'number') return undefined;
  if (![x, y, z, yaw, pitch].every(Number.isFinite)) return undefined;
  return { position: [x, y, z], view: { yaw, pitch } };
}

/** The game owns checkpoint semantics, including when a live physics body can be moved. */
export async function* installCheckpoint(
  world: World,
  host: GameHost,
  player: Game3dPlayerService,
  musicGuid: string,
  chimeGuid: string,
): AsyncGenerator<() => void, () => void, void> {
  const { port, assets, saves } = host;
  const audio = world.hasResource(AUDIO_ENGINE_RESOURCE_KEY) ? world.getResource(AUDIO_ENGINE_RESOURCE_KEY) : undefined;
  let chime: (() => void) | undefined;
  if (audio !== undefined) {
    const [music, feedback] = (await assets.loadMany([musicGuid, chimeGuid], 'audio')).unwrap();
    yield () => {
      const feedbackRelease = assets.release(feedback);
      const musicRelease = assets.release(music);
      feedbackRelease.unwrap();
      musicRelease.unwrap();
    };
    let musicVoice: EntityHandle | undefined;
    yield () => {
      if (musicVoice !== undefined) {
        audio.stop(musicVoice);
        world.despawn(musicVoice).unwrap();
      }
      audio.stop(player.entity);
    };
    musicVoice = world.spawn().unwrap();
    audio.play(musicVoice, assets, music, { loop: true, volume: 0.16, spatialBlend: 0, bus: 'music' });
    chime = () => audio.play(player.entity, assets, feedback, {
      loop: false, volume: 0.55, spatialBlend: 0, bus: 'sfx',
    });
  }
  const report = (message: string) => port?.postMessage({ channel: CHECKPOINT_CHANNEL, status: message });
  const saved = await saves?.read(slot);
  let checkpoint = saved?.ok && saved.value !== null ? readCheckpoint(saved.value) : undefined;
  const initialStatus = saves === undefined ? 'Saving unavailable' :
    saved?.ok === false ? 'Could not read checkpoint' :
    saved?.ok && saved.value && !checkpoint ? 'Unsupported checkpoint' : 'No checkpoint';
  if (checkpoint === undefined) report(initialStatus);
  let active = true;
  let saving = false;
  const save = async () => {
    if (saves === undefined || saving) return;
    saving = true;
    const [x, y, z] = world.get(player.entity, Transform).unwrap().pos;
    const { yaw, pitch } = player.readLook();
    const result = await saves.write(slot, { version: 1, data: { x: x!, y: y!, z: z!, yaw, pitch } });
    saving = false;
    if (!active) return;
    report(result.ok ? 'Checkpoint saved' : 'Could not save checkpoint');
    if (result.ok) chime?.();
  };
  const receive = (event: MessageEvent) => {
    if (event.data?.channel === CHECKPOINT_CHANNEL && event.data.command === 'save') void save();
  };
  port?.addEventListener('message', receive);
  yield () => {
    active = false;
    port?.removeEventListener('message', receive);
  };
  return () => {
    if (checkpoint === undefined || world.getResource(FixedTime).tick === 0) return;
    const resume = checkpoint;
    checkpoint = undefined;
    player.teleport(resume.position);
    player.setLook(resume.view);
    report('Checkpoint restored');
  };
}
