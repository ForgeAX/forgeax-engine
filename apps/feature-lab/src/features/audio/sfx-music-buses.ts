import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine/audio-webaudio';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import {
  busOfSource,
  busTopology,
  makeWav,
  sleep,
  traceAudioGraph,
  waitFor,
} from './support/webaudio';

export default defineFeature({
  title: 'SFX/Music buses',
  catalog: 'Configurable audio buses',
  kind: 'probe',
  summary:
    'This probe checks the configurable Host graph defaults: each source gain feeds the sfx or music bus gain, both buses feed one master gain. Bus volume and mute schedule a 10 ms ramp; unmute restores the previous bus volume.',
  expect:
    'All checks pass: sfx and music sources land on different bus gains, setBusVolume(music, 0.3) ramps only the music bus, mute ramps sfx to 0 and unmute back to 1, and negative volume is ignored.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    try {
      const bytes = makeWav(440, 0.5);
      consumer.consume({
        kind: 'play',
        entityId: 1,
        sourceKey: 'bus',
        bytes,
        options: { loop: true, volume: 0.02, spatialBlend: 0, bus: 'sfx' },
      });
      consumer.consume({
        kind: 'play',
        entityId: 2,
        sourceKey: 'bus',
        options: { loop: true, volume: 0.02, spatialBlend: 0, bus: 'music' },
      });
      checks.ok('both sources start', await waitFor(() => trace.started.length === 2));
      const topology = busTopology(trace);
      const sfxNode = trace.started[0];
      const musicNode = trace.started[1];
      if (topology === undefined || sfxNode === undefined || musicNode === undefined) {
        checks.ok('topology discovered', false);
        return { checks: () => checks.items };
      }
      checks.equal('exactly two bus gains feed master', topology.buses.length, 2);
      const sfx = busOfSource(trace, topology, sfxNode).bus;
      const music = busOfSource(trace, topology, musicNode).bus;
      checks.ok(
        'sfx and music route to different buses',
        sfx !== undefined && music !== undefined && sfx !== music,
      );
      if (sfx === undefined || music === undefined) return { checks: () => checks.items };
      consumer.consume({ kind: 'set-bus-volume', bus: 'music', volume: 0.3 });
      checks.near('music bus ramps to 0.3', trace.ramps.get(music.gain) ?? -1, 0.3);
      checks.ok('sfx bus untouched by music volume', !trace.ramps.has(sfx.gain));
      consumer.consume({ kind: 'set-bus-mute', bus: 'sfx', muted: true });
      checks.near('mute ramps sfx to 0', trace.ramps.get(sfx.gain) ?? -1, 0);
      consumer.consume({ kind: 'set-bus-mute', bus: 'sfx', muted: false });
      checks.near('unmute restores previous sfx volume', trace.ramps.get(sfx.gain) ?? -1, 1);
      consumer.consume({ kind: 'set-bus-volume', bus: 'music', volume: -1 });
      checks.near('negative bus volume is ignored', trace.ramps.get(music.gain) ?? -1, 0.3);
      const state = consumer.state().contextState;
      if (state === 'running') {
        await sleep(80);
        checks.near('running context applies the music gain', music.gain.value, 0.3, 0.01);
      } else {
        checks.ok('context suspended: gain values checked via scheduled ramps only', true, state);
      }
    } finally {
      consumer.dispose();
      trace.restore();
    }
    return { checks: () => checks.items };
  },
});
