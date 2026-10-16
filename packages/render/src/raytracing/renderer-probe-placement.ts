import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardProbeGlobal, StandardProbePlacementSeed } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import { CARD_LOOKUP_STRIDE } from './card-lookup';
import { GLOBAL_CARD_CANDIDATE_STRIDE } from './global-card-lookup';
import { packGlobalSdfQuerySettings } from './global-sdf-query';
import { PROBE_CARD_SUPPORT_STRIDE } from './probe-card-support';
import { PROBE_ORIGIN_SUPPORT_STRIDE } from './probe-origin-support';
import { createRasterProbePlacement } from './probe-placement';
import {
  type PreparedProbeGlobal,
  type ProbeGlobalRegion,
  type ProbeGlobalSource,
  prepareProbeGlobalRegion,
  probeGlobalAttemptCurrent,
  probeGlobalRegionCurrent,
  probeGlobalSourceReferences,
} from './renderer-probe-global';

type Kernel = Extract<ReturnType<typeof createRasterProbePlacement>, { ok: true }>['value'];
interface Pair {
  readonly states: readonly [Buffer, Buffer];
  readonly diagnostics: readonly [Buffer, Buffer];
  readonly probes: Buffer;
  readonly lifetime: ResidencyLifetime;
  accepted: 0 | 1;
  readonly global?: {
    readonly rays: readonly [Buffer, Buffer];
    readonly cards?: {
      readonly candidates: readonly [Buffer, Buffer];
      readonly samples: readonly [Buffer, Buffer];
      readonly diagnostics: readonly [Buffer, Buffer];
    };
    readonly hits: readonly [Buffer, Buffer];
    readonly emission: readonly [Buffer, Buffer];
    readonly diagnostics: readonly [Buffer, Buffer];
    readonly raySettings: Buffer;
    readonly querySettings: Buffer;
  };
}
export interface PreparedProbePlacement {
  readonly global?: PreparedProbeGlobal;
  readonly generation: number;
  readonly count: number;
  readonly recordBytes: number;
  readonly record: Kernel['record'];
  readonly probes: Buffer;
  readonly accepted: Buffer;
  readonly candidate: Buffer;
  readonly diagnostics: Buffer;
  readonly records: Buffer;
  readonly viewRect: Buffer;
  readonly fence: RendererGenerationFence;
  track(completed: Promise<unknown>): void;
  commit(): void;
  abort(): void;
}
export interface ProbePlacementInspection {
  readonly state: 'preparing' | 'ready' | 'failed' | 'disabled';
  readonly global?: {
    readonly sourceRevision: number;
    readonly sourceCount: number;
    readonly voxelCount: number;
    readonly compositionBuilds: number;
    readonly composed: boolean;
    readonly cards?: { readonly captured: boolean; readonly count: number; readonly bytes: number };
  };
  readonly generation: number;
  readonly submittedFrames: number;
  readonly seedCount: number;
  readonly error?: Pick<RhiError, 'code' | 'expected' | 'hint' | 'detail'>;
}

/** One RenderSystem's bounded placement history. Profiles only declare seed inputs. */
export class RendererProbePlacement {
  #generation = 0;
  #attempt = 0;
  #key = '';
  #world: unknown;
  #pair: Pair | undefined;
  #published: Pair | undefined;
  #publishedGeneration = 0;
  #device: import('@forgeax/engine-rhi').RhiDevice | undefined;
  #kernel: Kernel | undefined;
  #pending = false;
  #error: RhiError | undefined;
  #submitted = 0;
  #count = 0;
  #disposed = false;
  #region: ProbeGlobalRegion | undefined;
  #publishedRegion: ProbeGlobalRegion | undefined;
  #regionKey = '';
  #regionPending: object | undefined;
  #regionSource: readonly unknown[] = [];
  #compositionBuilds = 0;
  get generation(): number {
    return this.#generation;
  }
  inspect(): ProbePlacementInspection {
    return {
      state:
        this.#key === ''
          ? 'disabled'
          : this.#error !== undefined
            ? 'failed'
            : this.#published === undefined ||
                this.#published !== this.#pair ||
                (this.#regionKey !== '' && this.#publishedRegion !== this.#region)
              ? 'preparing'
              : 'ready',
      ...(this.#region === undefined
        ? {}
        : {
            global: {
              sourceRevision: this.#region.retained.revision,
              sourceCount: this.#region.sources.length,
              voxelCount: this.#region.voxelCount,
              compositionBuilds: this.#compositionBuilds,
              composed: this.#region.composed,
              ...(this.#region.cards === undefined
                ? {}
                : {
                    cards: {
                      captured: this.#region.cards.schedule.done,
                      count: this.#region.cards.capture.entries.reduce(
                        (sum, entry) => sum + entry.projections.length,
                        0,
                      ),
                      bytes: this.#region.cards.capture.bytes,
                    },
                  }),
            },
          }),
      generation: this.#publishedGeneration,
      submittedFrames: this.#submitted,
      seedCount: this.#count,
      ...(this.#error === undefined
        ? {}
        : {
            error: {
              code: this.#error.code,
              expected: this.#error.expected,
              hint: this.#error.hint,
              detail: this.#error.detail,
            },
          }),
    };
  }
  disable(): void {
    if (this.#key === '') return;
    this.#generation++;
    this.#key = '';
    this.#pair?.lifetime.retire();
    if (this.#published !== this.#pair) this.#published?.lifetime.retire();
    this.#pair = undefined;
    this.#published = undefined;
    this.#publishedGeneration = 0;
    this.#submitted = 0;
    this.#count = 0;
    this.#error = undefined;
    this.#region?.lifetime.retire();
    if (this.#publishedRegion !== this.#region) this.#publishedRegion?.lifetime.retire();
    this.#region = undefined;
    this.#publishedRegion = undefined;
    this.#regionPending = undefined;
    this.#regionKey = '';
  }
  dispose(): void {
    this.disable();
    this.#disposed = true;
  }

  #prepareRegion(
    runtime: RenderSystemInternals,
    source: ProbeGlobalSource,
    profile: StandardProbeGlobal,
  ): ProbeGlobalRegion | undefined {
    const retained = source.scene.retained;
    if (retained === undefined)
      throw new Error('Global probe queries require retained scene provenance');
    const key = JSON.stringify([
      profile.grid,
      profile.maxInstances,
      profile.maxFieldBytes,
      profile.cards,
    ]);
    const refs = probeGlobalSourceReferences(source, runtime);
    if (
      key !== this.#regionKey ||
      (this.#region !== undefined && !probeGlobalRegionCurrent(this.#region, source, runtime)) ||
      refs.length !== this.#regionSource.length ||
      refs.some((value, index) => value !== this.#regionSource[index])
    ) {
      if (this.#region !== this.#publishedRegion) this.#region?.lifetime.retire();
      this.#region = undefined;
      this.#regionPending = undefined;
      this.#regionKey = key;
      this.#regionSource = refs;
      this.#error = undefined;
    }
    if (
      this.#region === undefined &&
      this.#regionPending === undefined &&
      this.#error === undefined
    ) {
      const token = {};
      this.#regionPending = token;
      this.#compositionBuilds++;
      void prepareProbeGlobalRegion(runtime, source, profile)
        .then((region) => {
          if (this.#disposed || this.#regionPending !== token) region.lifetime.retire();
          else this.#region = region;
        })
        .catch((cause: unknown) => {
          if (this.#disposed || this.#regionPending !== token) return;
          this.#error =
            cause instanceof RhiError
              ? cause
              : new RhiError({
                  code: 'rhi-not-available',
                  expected: 'a complete admitted retained field source for Global probe queries',
                  hint: 'repair the named field/material source and retry its owned publication',
                  detail: {
                    error: {
                      code: 'probe-global-preparation',
                      message: cause instanceof Error ? cause.message : JSON.stringify(cause),
                      ...(typeof cause === 'object' && cause !== null ? { detail: cause } : {}),
                    },
                  },
                });
          runtime.errorRegistry.fire(this.#error);
        })
        .finally(() => {
          if (this.#regionPending === token) this.#regionPending = undefined;
        });
    }
    return this.#region;
  }

  prepare(input: {
    readonly runtime: RenderSystemInternals;
    readonly seeds: readonly StandardProbePlacementSeed[];
    readonly camera: number;
    readonly world: unknown;
    readonly records: Uint32Array;
    readonly width: number;
    readonly height: number;
    readonly globalSource?: ProbeGlobalSource;
  }): PreparedProbePlacement | undefined {
    if (this.#disposed) return undefined;
    const { runtime, seeds, records, width, height } = input;
    const device = runtime.device;
    const globalProfile = runtime.standardProfile?.probePlacement?.global;
    const key = JSON.stringify([
      runtime.deviceScope.generation,
      input.camera,
      seeds,
      globalProfile,
    ]);
    if (this.#device !== undefined && this.#device !== device)
      throw new Error('placement recovery requires a new RenderSystem owner');
    this.#device = device;
    if (key !== this.#key || input.world !== this.#world) {
      // Retain the last accepted allocation until a replacement physically
      // submits and passes publication. Repeated rejected resets retire only
      // their own unaccepted pair.
      if (this.#pair !== this.#published) this.#pair?.lifetime.retire();
      this.#pair = undefined;
      this.#error = undefined;
      this.#generation++;
      this.#key = key;
      this.#world = input.world;
      this.#count = seeds.length;
    }
    let region: ProbeGlobalRegion | undefined;
    if (globalProfile !== undefined) {
      if (input.globalSource === undefined)
        throw new Error('Global probe queries require retained source and attachment evidence');
      // A feature may mutate a source after extraction. Skip this attempt;
      // the reusable pending/ready region is not a frame-version cache.
      if (input.globalSource.scene.retained?.isSourceCurrent() !== true) return undefined;
      region = this.#prepareRegion(runtime, input.globalSource, globalProfile);
    } else if (this.#regionKey !== '') {
      this.#region?.lifetime.retire();
      if (this.#publishedRegion !== this.#region) this.#publishedRegion?.lifetime.retire();
      this.#region = undefined;
      this.#publishedRegion = undefined;
      this.#regionPending = undefined;
      this.#regionKey = '';
    }
    const sourceCurrent =
      region === undefined || input.globalSource === undefined
        ? undefined
        : probeGlobalAttemptCurrent(input.globalSource);
    const generation = this.#generation;
    const attempt = ++this.#attempt;
    const profile = runtime.standardProfile;
    const canvasWidth = runtime.canvas.width,
      canvasHeight = runtime.canvas.height;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () =>
        !this.#disposed &&
        this.#generation === generation &&
        this.#attempt === attempt &&
        runtime.standardProfile === profile &&
        runtime.canvas.width === canvasWidth &&
        runtime.canvas.height === canvasHeight &&
        (region === undefined ||
          (input.globalSource !== undefined &&
            sourceCurrent?.() === true &&
            probeGlobalRegionCurrent(region, input.globalSource, runtime))) &&
        JSON.stringify([
          runtime.deviceScope.generation,
          input.camera,
          runtime.standardProfile?.probePlacement?.seeds,
          runtime.standardProfile?.probePlacement?.global,
        ]) === key
          ? generation
          : -1,
    };
    if (this.#kernel === undefined) {
      if (!this.#pending && this.#error === undefined) {
        const entries = [...(runtime.shaderRegistry?.entries() ?? [])].filter((entry) =>
          entry.wgsl.includes('fn placeRasterProbes('),
        );
        const source = entries[0];
        const compile = runtime.createShaderModule;
        if (entries.length !== 1 || source === undefined || compile === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'one published raster placement kernel',
            hint: 'publish the ordinary Standard shader closure before enabling placement',
          });
        this.#pending = true;
        void compile(device, { label: 'probe-placement.kernel', code: source.wgsl })
          .then((module) => {
            if (this.#disposed || this.#generation !== generation) return;
            this.#kernel = createRasterProbePlacement(device, module.unwrap()).unwrap();
          })
          .catch((cause: unknown) => {
            if (this.#disposed || this.#generation !== generation) return;
            this.#error =
              cause instanceof RhiError
                ? cause
                : new RhiError({
                    code: 'webgpu-runtime-error',
                    expected: 'supported raster placement preparation',
                    hint: 'inspect the producer cause before retrying placement',
                    detail: {
                      error: {
                        code: 'probe-placement-preparation',
                        message: cause instanceof Error ? cause.message : String(cause),
                      },
                    },
                  });
            runtime.errorRegistry.fire(this.#error);
          })
          .finally(() => {
            this.#pending = false;
          });
      }
      return undefined;
    }
    if (records.byteLength === 0 || (globalProfile !== undefined && region === undefined))
      return undefined;
    const buffer = (label: string, data: ArrayBufferView, usage = 128 | 12): Buffer => {
      const result = device.createBuffer({ label, size: data.byteLength, usage }).unwrap();
      try {
        device.queue.writeBuffer(result, 0, data).unwrap();
      } catch (cause) {
        device.destroyBuffer(result);
        throw cause;
      }
      return result;
    };
    if (this.#pair === undefined) {
      const owned: Buffer[] = [];
      const create = (label: string, data: ArrayBufferView, usage = 128 | 12): Buffer => {
        const value = buffer(label, data, usage);
        owned.push(value);
        return value;
      };
      try {
        const seedData = new ArrayBuffer(seeds.length * 32);
        const f32 = new Float32Array(seedData),
          u32 = new Uint32Array(seedData);
        const state = new Uint32Array(seeds.length * 8);
        for (const [index, seed] of seeds.entries()) {
          f32.set([...seed.position, seed.cellSize], index * 8);
          u32.set([seed.id, seed.generation, seed.traced ? 1 : 0, 0], index * 8 + 4);
          state.set([seed.id, seed.generation, 0, 0], index * 8 + 4);
        }
        let global: Pair['global'];
        if (globalProfile !== undefined) {
          const rayCount = seeds.length * globalProfile.rayResolution ** 2;
          const makePair = (name: string, data: ArrayBufferView) =>
            [
              create(`probe-global.${name}-a`, data),
              create(`probe-global.${name}-b`, data),
            ] as const;
          global = {
            rays: makePair('rays', new Uint8Array(rayCount * 48)),
            ...(globalProfile.cards === undefined
              ? {}
              : {
                  cards: {
                    candidates: makePair(
                      'card-candidates',
                      new Uint8Array(rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
                    ),
                    samples: makePair(
                      'card-samples',
                      new Uint8Array(rayCount * 4 * CARD_LOOKUP_STRIDE),
                    ),
                    diagnostics: makePair(
                      'card-support',
                      new Uint8Array(rayCount * PROBE_CARD_SUPPORT_STRIDE),
                    ),
                  },
                }),
            hits: makePair('hits', new Uint32Array(rayCount * 16).fill(0xffffffff)),
            emission: makePair('emission', new Uint32Array(seeds.length * 4).fill(0xffffffff)),
            diagnostics: makePair(
              'origin-support',
              new Uint8Array(seeds.length * PROBE_ORIGIN_SUPPORT_STRIDE),
            ),
            raySettings: create(
              'probe-global.ray-settings',
              new Float32Array([globalProfile.tMax, 0, 0, 0]),
              64 | 12,
            ),
            querySettings: create(
              'probe-global.query-settings',
              packGlobalSdfQuerySettings(globalProfile.grid, globalProfile).unwrap(),
              64 | 12,
            ),
          };
        }
        const probes = create('probe-placement.seeds', u32);
        const states = [
          create('probe-placement.state-a', state),
          create('probe-placement.state-b', state),
        ] as const;
        const diagnostic = new Uint32Array(seeds.length * 4);
        const diagnostics = [
          create('probe-placement.status-a', diagnostic),
          create('probe-placement.status-b', diagnostic),
        ] as const;
        this.#pair = {
          probes,
          states,
          diagnostics,
          accepted: 0,
          ...(global === undefined ? {} : { global }),
          lifetime: new ResidencyLifetime(() => {
            for (const value of owned) device.destroyBuffer(value);
          }),
        };
      } catch (cause) {
        for (const value of owned) device.destroyBuffer(value);
        throw cause;
      }
    }
    const pair = this.#pair;
    const candidate = pair.accepted === 0 ? 1 : 0;
    const recordBuffer = buffer('probe-placement.records', records);
    let viewRect: Buffer;
    try {
      viewRect = buffer(
        'probe-placement.view-rect',
        new Uint32Array([0, 0, width, height]),
        64 | 8,
      );
    } catch (cause) {
      device.destroyBuffer(recordBuffer);
      throw cause;
    }
    const inputs = new ResidencyLifetime(() => {
      device.destroyBuffer(recordBuffer);
      device.destroyBuffer(viewRect);
    });
    let settled = false;
    let encoded = 0;
    let submitted = false;
    const composeRequired = region !== undefined && !region.composed;
    const cardRegion = region?.cards;
    // This frame's budgeted Card slice; the scheduler advances once it is submitted.
    const captureSlice = cardRegion?.schedule.slice();
    const expectedEncoding =
      (region === undefined ? 1 : 1 | 4 | 8 | 16 | (composeRequired ? 2 : 0)) |
      (cardRegion === undefined ? 0 : 64 | 128 | 256 | (captureSlice !== undefined ? 32 : 0));
    const global: PreparedProbeGlobal | undefined =
      region === undefined || pair.global === undefined || globalProfile === undefined
        ? undefined
        : {
            region,
            ...(cardRegion === undefined || pair.global.cards === undefined
              ? {}
              : {
                  cards: {
                    region: cardRegion,
                    captureSlice,
                    candidates: pair.global.cards.candidates[candidate],
                    samples: pair.global.cards.samples[candidate],
                    diagnostics: pair.global.cards.diagnostics[candidate],
                    capture: (pass) => {
                      if (captureSlice === undefined)
                        throw new Error('native Card capture recorded without a scheduled slice');
                      if (captureSlice.clear) {
                        const cleared = cardRegion.capture.clearTiles(pass, captureSlice);
                        if (!cleared.ok) return cleared;
                      }
                      const result = cardRegion.capture.recordPass(pass, captureSlice);
                      if (result.ok) encoded |= 32;
                      return result;
                    },
                    lookup: (...args) => {
                      const result = cardRegion.lookup(...args);
                      if (result.ok) encoded |= args[3] === 'selectCandidates' ? 64 : 128;
                      return result;
                    },
                    support: (...args) => {
                      const result = cardRegion.support(...args);
                      if (result.ok) encoded |= 256;
                      return result;
                    },
                  },
                }),
            composeRequired,
            resolution: globalProfile.rayResolution,
            rayCount: seeds.length * globalProfile.rayResolution ** 2,
            rays: pair.global.rays[candidate],
            hits: pair.global.hits[candidate],
            emission: pair.global.emission[candidate],
            diagnostics: pair.global.diagnostics[candidate],
            raySettings: pair.global.raySettings,
            querySettings: pair.global.querySettings,
            compose: (...args) => {
              const result = region.compose(...args);
              if (result.ok) encoded |= 2;
              return result;
            },
            emit: (...args) => {
              const result = region.rays(...args);
              if (result.ok) encoded |= 4;
              return result;
            },
            query: (...args) => {
              const result = region.query(...args);
              if (result.ok) encoded |= 8;
              return result;
            },
            support: (...args) => {
              const result = region.support(...args);
              if (result.ok) encoded |= 16;
              return result;
            },
          };
    const kernel = this.#kernel;
    return {
      ...(global === undefined ? {} : { global }),
      generation,
      count: seeds.length,
      recordBytes: records.byteLength,
      record: (...args) => {
        const result = kernel.record(...args);
        if (result.ok) encoded |= 1;
        return result;
      },
      probes: pair.probes,
      accepted: pair.states[pair.accepted],
      candidate: pair.states[candidate],
      diagnostics: pair.diagnostics[candidate],
      records: recordBuffer,
      viewRect,
      fence,
      track: (done) => {
        submitted = true;
        pair.lifetime.track(done);
        inputs.track(done);
        region?.lifetime.track(done);
        cardRegion?.track(done);
        if (captureSlice !== undefined && (encoded & 32) !== 0)
          cardRegion?.schedule.commit(captureSlice);
        if (region !== undefined && (encoded & 2) !== 0) region.composed = true;
      },
      commit: () => {
        if (settled) return;
        settled = true;
        if (
          encoded === expectedEncoding &&
          fence.currentGeneration() === generation &&
          (cardRegion === undefined || (submitted && cardRegion.commit()))
        ) {
          if (this.#published !== pair) {
            this.#published?.lifetime.retire();
            this.#published = pair;
            this.#publishedGeneration = generation;
            this.#submitted = 0;
          }
          if (this.#publishedRegion !== region) this.#publishedRegion?.lifetime.retire();
          this.#publishedRegion = region;
          pair.accepted = candidate;
          this.#submitted++;
        }
        inputs.retire();
      },
      abort: () => {
        if (!settled) {
          settled = true;
          inputs.retire();
        }
      },
    };
  }
}
