import type { App } from '@forgeax/engine-app';
import { AudioSource } from '@forgeax/engine-audio';
import type { WebAudioEngine } from '@forgeax/engine-audio-webaudio';
import { Update } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export function installAudioControls(
  app: App,
  engine: WebAudioEngine,
  clip: Handle<'AudioClipAsset', 'shared'>,
): void {
  const world = app.world;
  const entity = world
    .spawn({ component: AudioSource, data: { clip, loop: true, volume: 0.2, bus: 'music' } })
    .unwrap();
  const panel = document.createElement('section');
  panel.id = 'audio-controls';
  panel.innerHTML = `<h2>Audio controls</h2><p>Looping clip · Host Web Audio</p>
    <div><button id="controls-play">Play</button><button id="controls-pause">Pause</button><button id="controls-resume">Resume</button><button id="controls-stop">Stop</button></div>
    <label>Speed <input id="controls-rate" type="range" min="0.25" max="3" step="0.25" value="1"><output id="controls-rate-value">1×</output></label>
    <label>Filter <select id="controls-filter"><option value="dry">Dry</option><option value="lowpass">Lowpass 1 kHz + gain</option><option value="highpass">Highpass 2 kHz + gain</option></select></label>
    <canvas id="controls-spectrum" width="400" height="120"></canvas><p id="controls-position">Stopped</p>`;
  document.body.append(panel);
  const plot = panel.querySelector<HTMLCanvasElement>('#controls-spectrum')!.getContext('2d')!;
  const status = panel.querySelector<HTMLParagraphElement>('#controls-position')!;
  const bars = Array.from({ length: 24 }, (_, i) =>
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [-2.3 + i * 0.2, 0.8, -0.5], scale: [0.12, 0.02, 0.12] },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap(),
  );
  let analyser: AnalyserNode | undefined;
  let spectrum = new Float32Array(2048);
  let filter = 'dry';
  let error = '';
  let frame = 0;
  let frozen = false;
  let peakHz = 0;
  const setFilter = (value: string) => {
    filter = value;
    if (engine.getPlaybackPosition(Number(entity)) === undefined) return;
    const result = engine.setFilters(Number(entity), (context) => {
      if (value === 'dry') return [];
      const biquad = context.createBiquadFilter();
      biquad.type = value === 'lowpass' ? 'lowpass' : 'highpass';
      biquad.frequency.value = value === 'lowpass' ? 1000 : 2000;
      biquad.Q.value = 20 * Math.log10(Math.SQRT1_2);
      const gain = context.createGain();
      gain.gain.value = 0.8;
      return [biquad, gain];
    });
    error = result.ok ? '' : result.error.hint;
  };
  const controller = {
    play() {
      analyser = undefined;
      world.set(entity, AudioSource, { playing: true, paused: false }).unwrap();
    },
    pause() {
      world.set(entity, AudioSource, { paused: true }).unwrap();
    },
    resume() {
      world.set(entity, AudioSource, { paused: false }).unwrap();
    },
    stop() {
      analyser = undefined;
      world.set(entity, AudioSource, { playing: false }).unwrap();
    },
    rate(value: number) {
      world.set(entity, AudioSource, { playbackRate: value }).unwrap();
    },
    filter: setFilter,
    freeze(value: boolean) {
      frozen = value;
    },
    snapshot() {
      const source = world.get(entity, AudioSource).unwrap();
      return {
        playbackRate: source.playbackRate,
        paused: source.paused,
        playing: source.playing,
        entityId: Number(entity),
        position: engine.getPlaybackPosition(Number(entity)),
        active: engine.getActiveSourceCount(),
        peakHz,
        filter,
        fftSize: analyser?.fftSize ?? 0,
        error,
        frames: frame,
      };
    },
    async capture() {
      return app.rhiCapture?.captureFrame();
    },
  };
  Object.assign(globalThis, { __forgeaxAudioControls: controller });
  for (const action of ['play', 'pause', 'resume', 'stop'] as const)
    panel.querySelector(`#controls-${action}`)!.addEventListener('click', controller[action]);
  panel.querySelector<HTMLInputElement>('#controls-rate')!.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    controller.rate(value);
    panel.querySelector('#controls-rate-value')!.textContent = `${value}×`;
  });
  panel
    .querySelector<HTMLSelectElement>('#controls-filter')!
    .addEventListener('change', (event) => setFilter((event.target as HTMLSelectElement).value));
  world
    .addSystem(Update, {
      name: 'hello-audio-spectrum',
      queries: [],
      fn: () => {
        frame++;
        const position = engine.getPlaybackPosition(Number(entity));
        if (!analyser && position !== undefined) {
          const created = engine.createAnalyser(Number(entity), 4096);
          if (created.ok) {
            analyser = created.value;
            analyser.smoothingTimeConstant = 0.4;
            spectrum = new Float32Array(analyser.frequencyBinCount);
            setFilter(filter);
          } else error = created.error.hint;
        }
        if (frozen || frame % 2 !== 0) return;
        plot.fillStyle = '#101827';
        plot.fillRect(0, 0, 400, 120);
        let peak = 0;
        if (analyser && position !== undefined)
          engine.readFrequencyData(Number(entity), spectrum).unwrap();
        else spectrum.fill(-Infinity);
        for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peak]!) peak = i;
        peakHz = analyser ? (peak * analyser.context.sampleRate) / analyser.fftSize : 0;
        for (let i = 0; i < bars.length; i++) {
          const start = Math.floor(2 ** ((i * Math.log2(spectrum.length)) / bars.length));
          const end = Math.max(
            start + 1,
            Math.floor(2 ** (((i + 1) * Math.log2(spectrum.length)) / bars.length)),
          );
          let db = -100;
          for (let bin = start; bin < end; bin++) db = Math.max(db, spectrum[bin] ?? -100);
          const height = Math.max(0, Math.min(1, (db + 100) / 100));
          plot.fillStyle = '#6de3be';
          plot.fillRect(i * 16 + 2, 110 - height * 100, 12, height * 100);
          world
            .set(bars[i]!, Transform, {
              pos: [-2.3 + i * 0.2, 0.8 + height * 0.6, -0.5],
              scale: [0.12, Math.max(0.02, height * 1.2), 0.12],
            })
            .unwrap();
        }
        const source = world.get(entity, AudioSource).unwrap();
        status.textContent =
          error ||
          `${source.paused ? 'Paused' : position === undefined ? 'Stopped' : 'Playing'} · ${(position ?? 0).toFixed(3)} s · ${source.playbackRate}× · peak ${Math.round(peakHz)} Hz`;
      },
    })
    .unwrap();
}
