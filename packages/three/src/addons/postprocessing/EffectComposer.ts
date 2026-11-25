import { Vector2 } from 'three/src/Three.Core.js';
import { invalidError, unsupportedError } from '../../compatibility-error';
import type { ThreeFullscreenPass } from '../../fullscreen-pass';
import {
  isThreeFullscreenPass,
  renderThreePostProcessing,
  type ThreePostProcessing,
} from '../../post-processing';
import type { WebGPURenderer } from '../../renderer';
import { GTAOPass } from './GTAOPass';
import { OutputPass } from './OutputPass';
import type { Pass } from './Pass';
import { RenderPass } from './RenderPass';
import { UnrealBloomPass } from './UnrealBloomPass';

function aoSettings(pass: GTAOPass, surfaceWidth: number): ThreePostProcessing['ao'] {
  const { defines, uniforms } = pass.gtaoMaterial;
  const samples: unknown = defines?.SAMPLES;
  const scalar = (name: string): number => {
    const value: unknown = uniforms[name]?.value;
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw invalidError(`GTAOPass.${name}`);
    return value;
  };
  return {
    radius: scalar('radius'),
    intensity: Math.min(1, scalar('scale') * pass.blendIntensity),
    downsample: pass.width * 2 <= surfaceWidth,
    samples: typeof samples === 'number' ? samples : undefined,
  };
}

function validateAoPass(pass: GTAOPass, render: RenderPass): void {
  if (
    pass.scene !== render.scene ||
    pass.camera !== render.camera ||
    pass.output !== GTAOPass.OUTPUT.Default ||
    ('_renderGBuffer' in pass && pass._renderGBuffer !== true) ||
    pass.gtaoMaterial.defines?.SCENE_CLIP_BOX === 1 ||
    pass.gtaoMaterial.defines?.SCREEN_SPACE_RADIUS === 1
  )
    throw unsupportedError(
      'GTAOPass requires the RenderPass scene/camera, internal G-buffer and world-space default output',
    );
}

/** Run a supported Three addon sequence as a single Forgeax display frame. */
export class EffectComposer {
  readonly passes: Pass[] = [];
  renderToScreen = true;
  private readonly size: Vector2;
  private pixelRatio: number;
  private disposed = false;

  constructor(
    readonly renderer: WebGPURenderer,
    renderTarget?: unknown,
  ) {
    if (renderTarget !== undefined) throw unsupportedError('EffectComposer supplied render target');
    this.size = renderer.getSize(new Vector2());
    this.pixelRatio = renderer.getPixelRatio();
  }

  addPass(pass: Pass): void {
    this.insertPass(pass, this.passes.length);
  }

  insertPass(pass: Pass, index: number): void {
    this.passes.splice(index, 0, pass);
    pass.setSize(this.size.x * this.pixelRatio, this.size.y * this.pixelRatio);
  }

  removePass(pass: Pass): void {
    const index = this.passes.indexOf(pass);
    if (index >= 0) this.passes.splice(index, 1);
  }

  setSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw invalidError('EffectComposer.setSize');
    this.size.set(width, height);
    for (const pass of this.passes) pass.setSize(width * this.pixelRatio, height * this.pixelRatio);
  }

  setPixelRatio(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) throw invalidError('EffectComposer.setPixelRatio');
    this.pixelRatio = ratio;
    this.setSize(this.size.x, this.size.y);
  }

  dispose(): void {
    // The renderer owns GPU targets. As in Three, callers dispose their own passes.
    this.disposed = true;
    this.passes.length = 0;
  }

  render(_deltaTime?: number): void {
    if (this.disposed) throw invalidError('EffectComposer is disposed');
    if (!this.renderToScreen) throw unsupportedError('EffectComposer offscreen output');
    const first = this.passes.findIndex((pass) => pass.enabled);
    let last = this.passes.length - 1;
    while (last > first && !this.passes[last]?.enabled) last--;
    const scene = this.passes[first];
    const output = this.passes[last];
    if (!(scene instanceof RenderPass) || !(output instanceof OutputPass)) {
      throw unsupportedError('EffectComposer requires an enabled RenderPass and final OutputPass');
    }
    if (
      scene.overrideMaterial !== null ||
      scene.clearColor !== null ||
      scene.clearAlpha !== null ||
      scene.clearDepth ||
      !scene.clear
    )
      throw unsupportedError('EffectComposer RenderPass overrides');
    this.renderer[renderThreePostProcessing](
      scene.scene,
      scene.camera,
      this.collectPostProcessing(scene, first, last),
    );
  }

  private collectPostProcessing(
    scene: RenderPass,
    first: number,
    last: number,
  ): ThreePostProcessing {
    let ao: ThreePostProcessing['ao'];
    let bloom: ThreePostProcessing['bloom'];
    let fullscreen: ThreeFullscreenPass | undefined;
    for (let i = first + 1; i < last; i++) {
      const pass = this.passes[i];
      if (!pass?.enabled) continue;
      if (
        pass instanceof GTAOPass &&
        ao === undefined &&
        bloom === undefined &&
        fullscreen === undefined
      ) {
        validateAoPass(pass, scene);
        ao = aoSettings(pass, this.size.x * this.pixelRatio);
      } else if (
        pass instanceof UnrealBloomPass &&
        bloom === undefined &&
        fullscreen === undefined
      ) {
        bloom = {
          // Three r187 composites with 3 * strength; native Bloom uses intensity / 3.
          intensity: pass.strength * 9,
          radius: pass.radius ?? 0,
          threshold: pass.threshold ?? 0,
        };
      } else if (isThreeFullscreenPass(pass) && fullscreen === undefined) {
        fullscreen = pass;
      } else {
        throw unsupportedError(`EffectComposer pass or ordering: ${pass.constructor.name}`);
      }
    }
    return {
      ...(fullscreen === undefined ? {} : { fullscreen }),
      ...(ao === undefined ? {} : { ao }),
      ...(bloom === undefined ? {} : { bloom }),
    };
  }
}
