import { audioPlugin, loadMusicScore, type MusicCommand } from '@forgeax/engine/audio';
import { Update } from '@forgeax/engine/ecs';
import { defineSharedKernel } from '@forgeax/engine/ecs/shared';
import { Camera, perspective } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { ExecutionBootstrapEntry } from '@forgeax/engine/app';
import { AudioCounter, run } from '../stream/app-kernel';
import { savedScore } from './saved-score';

const entry: ExecutionBootstrapEntry = data => ({ features: [], plugins: [audioPlugin(), {
  name: 'quantized-music-project', inject: ['world', 'assets', 'audio', 'executionBootstrapHost'],
  async apply(ctx) {
    const audio = ctx.audio;
    if (!audio) throw new Error('music requires the existing audio service');
    const { count, shared, falsifier } = data as { count: number; shared: boolean; falsifier?: boolean };
    const port = ctx.executionBootstrapHost.port;
    port?.postMessage({ startup: 'bootstrap-apply' });
    const componentIdentity = { transform: ctx.world.components.resolve('Transform') === Transform };
    if (!componentIdentity.transform) throw new Error('project Transform must equal the native App Scene token');
    port?.postMessage({ componentIdentity });
    // The Host factory loads ordinary GUID clips and prepares epoch 1. Only controls
    // and bounded receipts traverse the Engine Worker frame protocol.
    ctx.world.spawn({ component: Transform, data: { pos: [0, 0, 8] } }, { component: Camera,
      data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }) }).unwrap();
    port?.postMessage({ startup: 'camera-authored' });
    if (shared) {
      for (let row = 0; row < 8192; row++) ctx.world.spawn({ component: AudioCounter, data: { value: 0 } }).unwrap();
      ctx.world.addSystem(Update, defineSharedKernel(new URL('/assets/music-kernel.js', globalThis.location.href).href,
        { name: 'audio-counter', queries: [{ write: [AudioCounter] }], minimumRows: 1, run })).unwrap();
      port?.postMessage({ startup: 'shared-kernel-authored' });
    }
    // Negative control: ordinary immediate source plays issued by real Update work.
    // This uses the existing SFX publication path, deliberately omitting musical targets.
    if (falsifier && !ctx.assets) throw new Error('ordinary falsifier clips require the asset service');
    const immediate = falsifier ? await loadMusicScore(savedScore(count), ctx.assets!) : undefined;
    if (immediate && !immediate.ok) throw immediate.error;
    let immediateFrame = 0, immediateStem = 0;
    let sequence = 1, started = false, frame = 0;
    const incoming: { command: Omit<MusicCommand, 'requestId' | 'epoch'>; delayFrames: number }[] = [];
    const receive = (event: MessageEvent) => {
      if (event.data.poison) {
        ctx.world.addSystem(Update, { name: 'music-rebuild-falsifier', queries: [], fn() { throw new Error('music rebuild falsifier'); } }).unwrap();
      } else {incoming.push(event.data);port?.postMessage({commandTrace:{stage:'receive',frame,delayFrames:event.data.delayFrames,command:event.data.command}});}
    };
    port?.addEventListener('message', receive); port?.start();
    ctx.world.addSystem(Update, { name: 'musical-project-consumer', queries: [], fn() {
      const state = audio.getState().music;
      if (!state) return;
      if (immediate?.ok) {
        if (immediateFrame++ % 3 === 0 && immediateStem < count) {
          const stem = immediateStem++;
          audio.play(50000 + stem, immediate.value.assets, immediate.value.stems[stem]!.clip,
            { loop: true, volume: 0.1, spatialBlend: 0, bus: 'music' });
          port?.postMessage({ immediateStem: stem, submittedFrame: immediateFrame });
        }
        port?.postMessage({ music: state, frame: ++frame });
        return;
      }
      if (!started && state.phase === 'ready') {
        started = true;
        audio.music({ kind: 'mix', requestId: ++sequence, epoch: state.epoch,
          boundary: 'beat', late: 'next-boundary', gains: Array.from({ length: count }, () => 0.1) });
      }
      const next = incoming[0];
      if (next && --next.delayFrames < 0) {
        incoming.shift();
        const requestId=++sequence;
        port?.postMessage({commandTrace:{stage:'issue',frame,requestId,beat:state.beat,command:next.command}});
        audio.music({ ...next.command, requestId, epoch: state.epoch } as MusicCommand);
      }
      port?.postMessage({ music: state, frame: ++frame });
    } }).unwrap();
    port?.postMessage({ startup: 'bootstrap-ready' });
    return () => port?.removeEventListener('message', receive);
  },
}] });
export default entry;
