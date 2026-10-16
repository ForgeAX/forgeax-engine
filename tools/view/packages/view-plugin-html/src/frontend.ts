import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig, Dispose } from '@forgeax/view-workspace-core/frontend-contract';
import { createHtmlUiViewState } from './state.ts';
import { FRONTEND_PLUGIN_ID as HTML_UI_FRONTEND_PLUGIN_ID, PAGE_TYPE as HTML_UI_PAGE_TYPE } from './identity.ts';

const htmlUiPlugin = {
  name: HTML_UI_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const panelHost = config.panelHost ?? ctx.get('panelHost', false);
    if (!panelHost) return;
    const pageHost = config.pageHost ?? ctx.get('pageHost', false);
    if (!pageHost) throw new TypeError('HTML UI page requires pageHost');
    const state = createHtmlUiViewState();
    const unregister = pageHost.registerType({ typeId: HTML_UI_PAGE_TYPE, context: 'project', title: 'HTML UI', order: 60, closable: true, singleton: true, initial: false, openable: true, layout: 'dock', showPanelRail: true, hideWhenInactive: true, resourceSelector: { extensions: ['.html'] }, createController: () => ({ getResource: () => { const file = state.getSnapshot().file; return file ? { file } : undefined; }, getTitle: () => state.getSnapshot().file?.path.split('/').at(-1) ?? 'HTML UI', subscribeTitle: state.subscribe }) });
    const unsubscribe = pageHost.subscribeResourceOpen((request) => { if ('file' in request && request.file.extension === '.html') state.open(request.file); });
    const disposers: Dispose[] = [];
    ctx.effect(() => async () => { unsubscribe(); for (const dispose of [...disposers].reverse()) await dispose(); unregister(); state.dispose(); });
    try {
      const client = ctx.get('viewOperationClient');
      disposers.push(await panelHost.mountPanel({ id: 'html-ui-preview', pageType: HTML_UI_PAGE_TYPE, titleKey: 'view.slots.htmlPreview', dockTitleHidden: true, activity: { labelKey: 'view.slots.htmlPreview', icon: 'monitor' }, layout: { dock: 'fill', stack: 'tabs', order: 0 }, panel: 'HtmlUiPreview', props: { client, state } }));
      disposers.push(await panelHost.mountPanel({ id: 'html-ui-inspector', pageType: HTML_UI_PAGE_TYPE, titleKey: 'view.slots.htmlInspector', activity: { labelKey: 'view.slots.htmlInspector', icon: 'sliders' }, layout: { dock: 'right', size: { value: 0.32, unit: 'fraction' }, stack: 'tabs', order: 1 }, panel: 'HtmlUiInspector', props: { client, state } }));
    } catch (error) { for (const dispose of [...disposers].reverse()) await dispose(); unsubscribe(); unregister(); state.dispose(); throw error; }
  },
};
export default htmlUiPlugin;
