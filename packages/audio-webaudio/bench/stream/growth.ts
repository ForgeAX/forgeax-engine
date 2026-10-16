import { WebAudioEngine } from '../../src/web-audio-engine';
import { pcmWav, rms, toneBuffer } from '../../src/__tests__/support-tone';

(globalThis as any).__busGrowth = async (voices: number, destinations: number) => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const definitions = [
    { id: 'master', parent: null },
    ...Array.from({ length: destinations }, (_, i) => ({ id: `room-${i}`, parent: 'master' })),
    ...Array.from({ length: voices }, (_, i) => ({ id: `voice-${i}`, parent: 'master', volume: 0.25,
      sends: Array.from({ length: destinations }, (_, d) => ({ bus: `room-${d}`, gain: 0.5 / destinations, tap: 'pre-fader' as const })) })),
  ];
  const configured = engine.configureBuses(definitions); if (!configured.ok) throw configured.error;
  let builds = 0;
  for (let i = 0; i < destinations; i++) {
    const result = engine.setBusEffects(`room-${i}`, ctx => {
      builds++; const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1000; return [filter];
    });
    if (!result.ok) throw result.error;
  }
  const beforePlay = builds;
  const buffer = toneBuffer(context, [440, 8000], 1);
  engine.play(0, buffer, { loop: false, volume: 1 / voices, spatialBlend: 0, bus: 'voice-0' });
  const afterFirstPlay = builds;
  for (let id = 1; id < voices; id++) engine.play(id, buffer, { loop: false, volume: 1 / voices, spatialBlend: 0, bus: `voice-${id}` });
  if (builds !== afterFirstPlay || afterFirstPlay !== destinations) throw new Error('voice count created per-source bus effects');
  const updates = [];
  for (let update = 0; update < 30; update++) {
    const candidate = definitions.map(bus => bus.id === 'voice-0' ? { ...bus, volume: update % 2 ? 0.25 : 0.5 } : bus);
    const start = performance.now(), result = engine.configureBuses(candidate);
    updates.push(performance.now() - start); if (!result.ok) throw result.error;
  }
  const samples = (await context.startRendering()).getChannelData(0);
  const outputRms = rms(samples, 9600, 38400);
  if (Math.abs(outputRms - 0.1461317165) > 1e-5) throw new Error(`graph growth changed routing: ${outputRms}`);
  const result = { voices, destinations, buses: definitions.length, sends: voices * destinations,
    sharedChains: destinations, buildsBeforePlay: beforePlay, buildsAfterFirstPlay: afterFirstPlay, buildsAfterUpdates: builds,
    updatesMs: updates, outputRms, wav: [...pcmWav(samples)] };
  engine.destroy(); return result;
};
