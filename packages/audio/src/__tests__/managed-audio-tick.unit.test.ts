import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, World } from '@forgeax/engine-ecs';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { audioContribution } from '../assets/audio-decoder';
import { type AudioIntent, AudioSource, audioTickSystem, createAudioIntentBackend } from '../index';

function fixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const clip = assets
    .create({ kind: 'audio', sourceKey: 'tick', mediaType: 'audio/wav', bytes: Uint8Array.of(1) })
    .unwrap();
  const entity = world.spawn({ component: AudioSource, data: { clip } }).unwrap();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({
    emit: (intent) => {
      intents.push(intent);
    },
  });
  return {
    assets,
    world,
    clip,
    entity,
    intents,
    backend,
    dispose() {
      world.despawn(entity).unwrap();
      backend.destroy();
      assets.dispose();
    },
  };
}

it('uses asset handles on real playing edges and applies stop/replay with the default bus', () => {
  const f = fixture();
  try {
    audioTickSystem(f.world, f.backend);
    expect(f.intents).toHaveLength(0);
    f.world.set(f.entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(f.world, f.backend);
    audioTickSystem(f.world, f.backend);
    expect(f.intents).toMatchObject([
      {
        kind: 'play',
        asset: { handle: f.clip, owner: f.assets.identity },
        options: { bus: 'sfx' },
      },
    ]);
    f.world.set(f.entity, AudioSource, { playing: false }).unwrap();
    audioTickSystem(f.world, f.backend);
    f.world.set(f.entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(f.world, f.backend);
    expect(f.intents.map((intent) => intent.kind)).toEqual(['play', 'stop', 'play']);
  } finally {
    f.dispose();
  }
});

it('keeps first observations and replacement backend state independent across Worlds', () => {
  const a = fixture(),
    b = fixture();
  try {
    a.world.set(a.entity, AudioSource, { playing: true }).unwrap();
    b.world.set(b.entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(a.world, a.backend);
    audioTickSystem(b.world, b.backend);
    expect(a.intents).toHaveLength(1);
    expect(b.intents).toHaveLength(1);
    b.world.despawn(b.entity).unwrap();
    audioTickSystem(b.world, b.backend);
    audioTickSystem(a.world, a.backend);
    expect(b.intents.at(-1)?.kind).toBe('stop');
    expect(a.intents).toHaveLength(1);
    a.backend.destroy();
    const replay: AudioIntent[] = [];
    const replacement = createAudioIntentBackend({
      emit: (intent) => {
        replay.push(intent);
      },
    });
    audioTickSystem(a.world, replacement);
    expect(replay).toMatchObject([{ kind: 'play', asset: { handle: a.clip } }]);
    replacement.destroy();
  } finally {
    a.dispose();
    b.backend.destroy();
    b.assets.dispose();
  }
});

it('rejects dangling or foreign assets before an ECS source can bind them', () => {
  const a = fixture(),
    b = fixture();
  try {
    expect(
      a.world.spawn({ component: AudioSource, data: { clip: b.clip, playing: true } }).ok,
    ).toBe(false);
    expect(
      a.world.spawn({
        component: AudioSource,
        data: { clip: 0xffff_fffe as AssetHandle<'audio'>, playing: true },
      }).ok,
    ).toBe(false);
    expect(a.intents).toHaveLength(0);
  } finally {
    a.dispose();
    b.dispose();
  }
});

it('does no source lookup for idle ticks or asset edits among 1000 bound instances', () => {
  const f = fixture();
  const entities = Array.from({ length: 1000 }, () =>
    f.world.spawn({ component: AudioSource, data: { clip: f.clip } }).unwrap(),
  );
  const selected = entities[500];
  if (selected === undefined) throw new Error('missing selected source');
  const query = vi.spyOn(f.world, 'query');
  try {
    audioTickSystem(f.world, f.backend);
    const at = vi.spyOn(query.mock.results[0]?.value.unwrap(), 'at');
    query.mockClear();
    f.assets.update(f.clip, { bytes: Uint8Array.of(2) }).unwrap();
    for (let frame = 0; frame < 60; frame++) audioTickSystem(f.world, f.backend);
    expect(query).not.toHaveBeenCalled();
    expect(at).not.toHaveBeenCalled();
    expect(f.intents).toEqual([]);
    f.world.set(selected, AudioSource, { playing: true }).unwrap();
    audioTickSystem(f.world, f.backend);
    expect(at).toHaveBeenCalledTimes(1);
    expect(f.intents).toMatchObject([{ kind: 'play', bytes: Uint8Array.of(2) }]);
    at.mockClear();
    f.assets.update(f.clip, { bytes: Uint8Array.of(3) }).unwrap();
    audioTickSystem(f.world, f.backend);
    expect(at).not.toHaveBeenCalled();
    expect(f.intents).toHaveLength(1);
  } finally {
    query.mockRestore();
    for (const entity of entities) f.world.despawn(entity).unwrap();
    f.dispose();
  }
});

it('stops disabled and replaced generations without replaying unchanged peers', () => {
  const f = fixture();
  try {
    f.world.set(f.entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(f.world, f.backend);
    f.world.addComponent(f.entity, { component: Disabled, data: {} }).unwrap();
    audioTickSystem(f.world, f.backend);
    f.world.removeComponent(f.entity, Disabled).unwrap();
    audioTickSystem(f.world, f.backend);
    f.world.despawn(f.entity).unwrap();
    const replacement = f.world
      .spawn({ component: AudioSource, data: { clip: f.clip, playing: true } })
      .unwrap();
    audioTickSystem(f.world, f.backend);
    expect(
      f.intents.map((intent) => [intent.kind, 'entityId' in intent ? intent.entityId : undefined]),
    ).toEqual([
      ['play', f.entity],
      ['stop', f.entity],
      ['play', f.entity],
      ['stop', f.entity],
      ['play', replacement],
    ]);
    f.world.despawn(replacement).unwrap();
  } finally {
    f.backend.destroy();
    f.assets.dispose();
  }
});
