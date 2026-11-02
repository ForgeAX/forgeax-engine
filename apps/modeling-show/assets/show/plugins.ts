import type {} from '@forgeax/engine/app';
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { Plugin } from '@forgeax/engine/plugin';
import type { AssetHandle } from '@forgeax/engine/types';
import { mountUi, uiAssetContribution } from '@forgeax/engine/ui';
import { SHOW_PROGRAMS } from './programs.ts';
import { isShowMessage, SHOW_CHANNEL, type ShowMessage } from './protocol.ts';
import { createShow, type ShowState } from './show.ts';
import { discoverOutputs, resolveSubjects } from './subjects.ts';
import { bindTimeline } from './timeline.ts';

/**
 * Source realm: load the program's Pack outputs, rebuild its histories and run the Show
 * in the World. The timeline UI talks to it over the App's message port.
 */
export const showEngine: Plugin.Object<{
  readonly program: string;
  readonly assets: readonly string[];
  /** The cooked polished disc; the realm's render target authoring lets it mirror the subject. */
  readonly disc?: string;
  /** Build identity shown on the page. */
  readonly label?: string;
  /** Cooked program looks by name (GUIDs). */
  readonly looks?: Readonly<Record<string, string>>;
}> = {
  name: 'modeling-show/engine',
  inject: ['world', 'assets', 'gameHost', 'executionBootstrapHost'],
  async apply(ctx, config) {
    const program = SHOW_PROGRAMS[config.program];
    if (program === undefined) throw new Error(`unknown Show program ${config.program}`);
    const assets = ctx.get('assets') as unknown as AssetRegistry;
    const port = ctx.gameHost?.port;
    // Canvas drags orbit the camera from pointer positions; a locked pointer would freeze them.
    ctx.effect(() => {
      ctx.gameHost?.setPointerLockAllowed?.(false);
      return () => ctx.gameHost?.setPointerLockAllowed?.(true);
    });
    await ctx.effect(async function* () {
      const loaded: AssetHandle[] = [];
      yield () => {
        for (const handle of loaded) assets.release(handle).unwrap();
      };
      const loadAsset = async (guid: string, kind: 'scene' | 'mesh' | 'material') => {
        const result = await assets.load(guid, kind);
        if (!result.ok) throw result.error;
        loaded.push(result.value as AssetHandle);
        return result.value as AssetHandle;
      };
      const looks: Record<string, AssetHandle<'material'>> = {};
      for (const [name, guid] of Object.entries(config.looks ?? {})) looks[name] = (await loadAsset(guid, 'material')) as AssetHandle<'material'>;
      const catalog = await assets.enumerateCatalog();
      const sources = discoverOutputs(program.subjects, catalog.ok ? catalog.value : assets.listCatalog());
      const subjects = await resolveSubjects(sources, loadAsset, looks);
      let disc: AssetHandle<'material'> | undefined;
      if (config.disc !== undefined) {
        const result = await assets.load(config.disc, 'material');
        if (!result.ok) throw result.error;
        loaded.push(result.value as AssetHandle);
        disc = result.value as AssetHandle<'material'>;
      }
      const renderTargets = ctx.executionBootstrapHost?.renderTargets ?? ctx.gameHost?.renderer;
      const post = (message: ShowMessage) => port?.postMessage(message);
      let posted = 0;
      let last: ShowState | undefined;
      const show = createShow(ctx.world, assets, {
        subjects,
        segments: program.segments,
        ...(disc === undefined ? {} : { disc }),
        ...(renderTargets === undefined ? {} : { renderTargets }),
        observe(state) {
          const now = performance.now();
          if (last !== undefined && now - posted < 100 && last.segment === state.segment && last.step?.index === state.step?.index) return;
          posted = now;
          last = state;
          post({ channel: SHOW_CHANNEL, kind: 'state', state });
        },
      });
      yield () => show.dispose();
      const receive = (event: MessageEvent) => {
        if (isShowMessage(event.data) && event.data.kind === 'command') show.command(event.data.command);
      };
      port?.addEventListener('message', receive);
      port?.start();
      yield () => port?.removeEventListener('message', receive);
      post({
        channel: SHOW_CHANNEL,
        kind: 'program',
        subjects: show.subjects(),
        segments: program.segments,
        ...(config.label === undefined ? {} : { label: config.label }),
      });
    });
  },
};

/** Presentation realm: mount the timeline UI and bind it to the Show's port. */
export const showTimeline: Plugin.Object<{ readonly ui: string }> = {
  name: 'modeling-show/timeline',
  inject: ['assets', 'gameHost'],
  async apply(ctx, config) {
    const assets = ctx.get('assets') as unknown as AssetRegistry;
    const host = ctx.gameHost;
    const root = host?.uiRoot;
    const port = host?.presentationPort ?? host?.port;
    if (root === undefined || port === undefined) throw new Error('the Show timeline needs a presentation uiRoot and the App port');
    await ctx.effect(async function* () {
      const lease = assets.installDecoder(uiAssetContribution.kind, uiAssetContribution.decoder);
      yield () => lease.dispose();
      const loaded = await assets.load(config.ui, uiAssetContribution.kind);
      if (!loaded.ok) throw loaded.error;
      yield () => assets.release(loaded.value).unwrap();
      const mounted = mountUi(assets.read(loaded.value).unwrap() as never, { root, layer: 50 });
      if (!mounted.ok) throw mounted.error;
      yield () => mounted.value.dispose();
      const shadow = mounted.value.host.shadowRoot;
      if (shadow === null) throw new Error('the timeline UI has no shadow root');
      const unbind = bindTimeline(shadow, port);
      yield unbind;
    });
  },
};
