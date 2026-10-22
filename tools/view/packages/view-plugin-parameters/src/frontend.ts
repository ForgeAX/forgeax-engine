import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { PARAMETERS_FRONTEND_MODULE, PARAMETERS_FRONTEND_PLUGIN_ID } from './identity.ts';
export { PARAMETERS_FRONTEND_MODULE, PARAMETERS_FRONTEND_PLUGIN_ID } from './identity.ts';

const parametersFrontendPlugin = {
  name: PARAMETERS_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'contentBrowserDetailTabs'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const details = ctx.get('contentBrowserDetailTabs')!;
    const client = ctx.get('viewOperationClient');
    const panelHost = config.panelHost ?? ctx.get('panelHost', false);
    const releases: Array<() => void | Promise<void>> = [];
    releases.push(details.register({
      id: 'pack-parameters',
      titleKey: 'contentBrowser.preview.modeParameters',
      matches: input => /\.pack\.(?:ts|json)$/i.test(input.path),
      mount: async (element, context) => {
        const { mountParametersPanel } = await import('./ui/mount.tsx');
        return mountParametersPanel({
          mountElement: element,
          client: context.client,
          sourcePath: context.sourcePath,
          mode: 'generation',
          addConversationReference: context.addConversationReference,
        });
      },
    }));
    if (panelHost) releases.push(panelHost.mountAssetPanel({
      id: 'pack-parameters-runtime',
      kinds: ['scene', 'mesh', 'material', 'texture', 'audio', 'model', 'plugin'],
      panel: 'Parameters',
      titleKey: 'view.slots.parameters',
      activity: { labelKey: 'view.slots.parameters', icon: 'sliders-horizontal' },
      layout: { dock: 'right', size: { value: 0.28, unit: 'fraction' }, stack: 'tabs', order: 900 },
      props: { client, mode: 'runtime' },
    }));
    ctx.effect(() => async () => { for (const release of releases.reverse()) await release(); });
  },
};

export default parametersFrontendPlugin;
