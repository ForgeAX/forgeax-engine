import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { Update } from '@forgeax/engine-ecs';
import { defineSharedKernel } from '@forgeax/engine-ecs/shared';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import { AudioCounter, run } from './app-kernel';
const entry: ExecutionBootstrapEntry = data => ({ features: [], plugins: [audioPlugin(), {
  name: 'audio-stream-evidence', inject: ['world', 'assets', 'audio', 'executionBootstrapHost'],
  async apply(ctx) {
    const { guid, count, shared, shortGuid } = data as { guid: string; count: number; shared: boolean; shortGuid?: string };
    const loaded = await ctx.assets!.loadByGuid(ctx.assets!.parseGuid(guid));
    if (!loaded.ok || loaded.value.kind !== 'audio') throw loaded.ok ? new Error('not audio') : loaded.error;
    ctx.audio!.configureBuses([{ id: 'master', parent: null }, { id: 'music', parent: 'master', volume: 0.5,
      sends: [{ bus: 'room', gain: 0.25, tap: 'pre-fader' }] }, { id: 'room', parent: 'master' }]);
    const clips = [loaded.value];
    if (shortGuid) {
      const short = await ctx.assets!.loadByGuid(ctx.assets!.parseGuid(shortGuid));
      if (!short.ok || short.value.kind !== 'audio' || short.value.stream)
        throw new Error('mixed App requires the ordinary buffered short audio GUID');
      clips.push(short.value);
    }
    const entities = clips.flatMap(value => {
      const clip = ctx.world.allocSharedRef('AudioClipAsset', value);
      return Array.from({ length: count }, () => ctx.world.spawn({ component: AudioSource,
        data: { clip, playing: true, loop: true, volume: 0.25 / (count * clips.length), spatialBlend: 1, bus: 'music' } }).unwrap());
    });
    ctx.world.spawn({ component: Transform, data: { pos: [0, 0, 8] } }, { component: Camera,
      data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }) }).unwrap();
    if (shared) {
      for (let i = 0; i < 8192; i++) ctx.world.spawn({ component: AudioCounter, data: { value: 0 } }).unwrap();
      ctx.world.addSystem(Update, defineSharedKernel(new URL('./app-kernel.ts', import.meta.url).href,
        { name: 'audio-counter', queries: [{ write: [AudioCounter] }], minimumRows: 1, run })).unwrap();
    }
    const port = ctx.executionBootstrapHost.port;
    const receive = (event: MessageEvent) => {
      if (event.data.poison) {
        ctx.world.addSystem(Update, { name: 'native-audio-rebuild-fault', queries: [], fn: () => { throw new Error('native audio rebuild falsifier'); } }).unwrap();
        return;
      }
      for (const entity of entities) ctx.world.set(entity, AudioSource, event.data).unwrap();
    };
    port?.addEventListener('message', receive); port?.start();
    return () => { port?.removeEventListener('message', receive); for (const entity of entities) ctx.world.despawn(entity).unwrap(); };
  },
}] });
export default entry;
