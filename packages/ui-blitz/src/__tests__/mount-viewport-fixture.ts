import type { UiAsset } from '@forgeax/engine-ui';

export const mountViewportAsset: UiAsset = {
  guid: 'mounted-viewport',
  html: '<main class="viewport"><div class="stack"><button data-ui-action="save">Save</button></div></main>',
  css: ':host{display:block}.viewport{height:100%;overflow:auto;pointer-events:auto;background:#123456}.stack{height:240px}button{display:block;width:80px;height:30px;pointer-events:auto}',
};
