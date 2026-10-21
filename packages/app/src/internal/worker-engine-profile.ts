import { animationPlugin } from '@forgeax/engine-animation';
import { type AudioBackend, audioBackendPlugin } from '@forgeax/engine-audio';
import { type InputBackend, inputBackendPlugin } from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { statePlugin } from '@forgeax/engine-state';
import { inputPlugin } from '../input-plugin';
import {
  ownedRendererPlugin,
  type RenderFeatureHost,
  renderFeatureHostPlugin,
} from '../renderer-plugin';
import { assetProfilePlugins, type EngineProfileBase } from './engine-profile-common';

interface WorkerEngineProfileOptions extends Omit<EngineProfileBase, 'renderer'> {
  readonly renderer?: EngineProfileBase['renderer'];
  readonly input: InputBackend;
  readonly audio: AudioBackend;
  readonly rendererFeatureHost?: RenderFeatureHost;
}

/** Static Engine Worker selection; Host-only acquisition stays outside this realm. */
export function workerEngineProfile(options: WorkerEngineProfileOptions): Plugin[] {
  return [
    ...(options.renderer === undefined ? [] : [ownedRendererPlugin(options.renderer)]),
    renderComponentsPlugin(),
    ...(options.rendererFeatureHost === undefined
      ? []
      : [renderFeatureHostPlugin(options.rendererFeatureHost)]),
    ...assetProfilePlugins(options),
    inputBackendPlugin(options.input),
    audioBackendPlugin(options.audio),
    scenePlugin(),
    animationPlugin(options.animation),
    statePlugin(),
    inputPlugin(),
    ...(options.extensions ?? []),
  ];
}
