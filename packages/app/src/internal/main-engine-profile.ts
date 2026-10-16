import {
  type AnimationPayloadLookup,
  animationPayloadsPlugin,
  animationRuntimePlugin,
} from '@forgeax/engine-animation';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import {
  type ActionConfig,
  type InputBackend,
  inputBackendPlugin,
  ownedInputBackendPlugin,
} from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { statePlugin } from '@forgeax/engine-state';
import type { AssetRuntimeAssembly } from '../assets-runtime-assembly';
import { inputMapPlugin } from '../input-map-plugin';
import { inputPlugin } from '../input-plugin';
import {
  ownedRendererPlugin,
  type RenderFeatureHost,
  renderFeatureHostPlugin,
} from '../renderer-plugin';
import {
  assetRegistryPlugin,
  assetsWorldPlugin,
  rendererAssetsPlugin,
} from './assets-world-plugin';
import { createDebugDrawOnReady, type RendererDebugDrawHost, releaseDebugDraw } from './debug-draw';
import type { EngineProfileBase } from './engine-profile-common';

export interface MainEngineProfileOptions extends EngineProfileBase {
  readonly assetAssembly?: AssetRuntimeAssembly;
  readonly rendererDebugDrawHost?: RendererDebugDrawHost;
  readonly rendererFeatureHost?: RenderFeatureHost;
  readonly animationPayloads: AnimationPayloadLookup;
  readonly onDebugDrawReady?: (debugDraw: DebugDraw) => void;
  readonly input?: InputBackend;
  readonly inputDispose?: () => void;
  readonly inputMap?: readonly ActionConfig[];
}

function debugDrawPlugin(
  context: RendererDebugDrawHost,
  onReady: (debugDraw: DebugDraw) => void,
): Plugin {
  return {
    name: 'debug-draw',
    async apply(ctx) {
      try {
        const debugDraw = await createDebugDrawOnReady(context);
        onReady(debugDraw);
        ctx.effect(() => () => releaseDebugDraw(context, debugDraw), 'render/debug-draw');
      } catch {
        // DebugDraw is optional; renderer error reporting owns creation failures.
      }
    },
  };
}

/** Static browser-main selection; dependency order remains owned by inject/provide. */
export function mainEngineProfile(options: MainEngineProfileOptions): Plugin[] {
  return [
    ownedRendererPlugin(options.renderer),
    renderComponentsPlugin(),
    ...(options.rendererFeatureHost === undefined
      ? []
      : [renderFeatureHostPlugin(options.rendererFeatureHost)]),
    ...(options.assetAssembly === undefined
      ? [rendererAssetsPlugin(options.assets)]
      : [assetRegistryPlugin(options.assetAssembly, options.pluginPrograms, options.runtimePacks)]),
    assetsWorldPlugin(),
    ...(options.input === undefined
      ? []
      : [
          options.inputDispose === undefined
            ? inputBackendPlugin(options.input)
            : ownedInputBackendPlugin(options.input, options.inputDispose),
        ]),
    scenePlugin(),
    animationPayloadsPlugin(options.animationPayloads),
    animationRuntimePlugin(options.animation),
    statePlugin(),
    ...(options.onDebugDrawReady === undefined || options.rendererDebugDrawHost === undefined
      ? []
      : [debugDrawPlugin(options.rendererDebugDrawHost, options.onDebugDrawReady)]),
    ...(options.input === undefined ? [] : [inputPlugin()]),
    ...(options.inputMap === undefined ? [] : [inputMapPlugin(options.inputMap)]),
    ...(options.extensions ?? []),
  ];
}
