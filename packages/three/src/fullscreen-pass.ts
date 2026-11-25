import type { RenderFeature, RenderFeaturePlan } from '@forgeax/engine-render';
import { ok, sha256 } from '@forgeax/engine-types';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { ShaderMaterial } from 'three/src/Three.Core.js';
import { invalidError, unsupportedError } from './compatibility-error';
import { threeFullscreenPass } from './post-processing';

export interface ThreeFullscreenProgram {
  /** Stable build identity. WGSL uses vs_main/fs_main and the native fullscreen bindings. */
  readonly identity: string;
  readonly source: string;
  /** Optional digest of the original LF-normalized fragment source. */
  readonly sourceDigest?: string;
  readonly uniformWords: number;
  readonly uniforms: readonly {
    readonly name: string;
    readonly offset: number;
    readonly width: 1 | 2 | 3 | 4;
  }[];
}

/** A cooked color-only pass. The composer supplies the preceding HDR texture. */
export class ThreeFullscreenPass extends Pass {
  readonly [threeFullscreenPass] = true;
  readonly fragmentShader: string;
  readonly vertexShader: string;

  constructor(
    readonly material: ShaderMaterial,
    readonly program: ThreeFullscreenProgram,
  ) {
    super();
    this.fragmentShader = material.fragmentShader;
    this.vertexShader = material.vertexShader;
    if (
      program.sourceDigest !== undefined &&
      sha256(this.fragmentShader.replaceAll('\r\n', '\n')) !== program.sourceDigest
    )
      throw invalidError('ThreeFullscreenPass fragment does not match the cooked program');
  }

  override render(): never {
    throw unsupportedError('ThreeFullscreenPass requires EffectComposer');
  }
}

export class ThreeFullscreenPrograms {
  private readonly registered = new Map<
    ThreeFullscreenProgram,
    {
      readonly identity: string;
      readonly words: number;
      readonly uniforms: ThreeFullscreenProgram['uniforms'];
    }
  >();
  private active: { readonly identity: string; readonly bytes: Uint8Array } | undefined;
  readonly features: readonly RenderFeature<unknown>[];

  constructor(programs: readonly ThreeFullscreenProgram[] = []) {
    const identities = new Set<string>();
    this.features = programs.map((program): RenderFeature<Uint8Array | undefined> => {
      const { identity: name, source, uniforms, uniformWords } = program;
      if (
        !/^[a-zA-Z0-9._-]+$/.test(name) ||
        identities.has(name) ||
        !source ||
        !Number.isSafeInteger(uniformWords) ||
        uniformWords <= 0 ||
        uniformWords % 4 !== 0
      )
        throw invalidError('ThreeFullscreenProgram');
      const used = new Set<number>();
      for (const { name, width, offset } of uniforms) {
        if (
          !name ||
          !Number.isInteger(width) ||
          width < 1 ||
          width > 4 ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset + width > uniformWords
        )
          throw invalidError('ThreeFullscreenProgram uniform layout');
        for (let word = offset; word < offset + width; word++) {
          if (used.has(word)) throw invalidError('ThreeFullscreenProgram overlapping uniforms');
          used.add(word);
        }
      }
      identities.add(name);
      const identity = `forgeax-three::fullscreen::${name}`;
      const params = { byteSize: uniformWords * 4, defaultValue: new Uint8Array(uniformWords * 4) };
      // Snapshot the build-produced program and its layout once.
      const layout = uniforms.map((uniform) => ({ ...uniform }));
      this.registered.set(program, { identity, words: uniformWords, uniforms: layout });
      return {
        identity,
        requiredFullscreenPostProcesses: [{ identity, source }],
        extract: () => ok(this.active?.identity === identity ? this.active.bytes : undefined),
        plan: (frameParams) =>
          ok<RenderFeaturePlan>({
            work:
              frameParams === undefined
                ? []
                : [
                    {
                      scope: 'frame',
                      resources: [
                        {
                          kind: 'fullscreen-program',
                          name,
                          source,
                          chain: true,
                          stage: 'before-output',
                          params,
                          frameParams,
                        },
                      ],
                      passes: [],
                    },
                  ],
          }),
      };
    });
  }

  select(pass: ThreeFullscreenPass | undefined): void {
    this.active = undefined;
    if (pass === undefined) return;
    const { material, program } = pass;
    const layout = this.registered.get(program);
    if (layout === undefined)
      throw unsupportedError('ThreeFullscreenPass program must be registered in renderer options');
    if (
      material.fragmentShader !== pass.fragmentShader ||
      material.vertexShader !== pass.vertexShader
    )
      throw invalidError('ThreeFullscreenPass shader changed after cook');
    if (material.transparent || material.depthTest || material.depthWrite)
      throw unsupportedError('ThreeFullscreenPass requires a color-only replacement draw');
    const data = new Float32Array(layout.words);
    for (const { name, offset, width } of layout.uniforms) {
      const value: unknown = material.uniforms[name]?.value;
      const components =
        typeof value === 'number'
          ? [value]
          : Array.isArray(value)
            ? value
            : value != null &&
                typeof value === 'object' &&
                'toArray' in value &&
                typeof value.toArray === 'function'
              ? value.toArray()
              : [];
      if (
        !Array.isArray(components) ||
        components.length !== width ||
        !components.every(
          (component: unknown) =>
            typeof component === 'number' && Number.isFinite(Math.fround(component)),
        )
      )
        throw invalidError(`ThreeFullscreenPass uniform ${name}`);
      data.set(components, offset);
    }
    this.active = { identity: layout.identity, bytes: new Uint8Array(data.buffer) };
  }
}
