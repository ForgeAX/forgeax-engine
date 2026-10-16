import { mountUi } from '@forgeax/engine-ui';
import type { UiRasterCase } from './gpu-parity-fixture.js';

export const disabledControlsHtml = '<style>html,body{margin:0;background:white}</style>';
export const disabledControlsAsset = {
  guid: 'disabled-controls',
  html: '<main><label>Editable<input id=editable type=number value=3></label><label>Disabled<input id=disabled type=number value=3 disabled></label><label>Empty disabled<input id=empty disabled></label><label>Read only<input id=readonly type=number value=3 readonly></label><label>Disabled textarea<textarea id=textarea disabled>3</textarea></label><label>Disabled select<select id=select disabled><option>3</option></select></label><label>Disabled button<button id=button disabled>3</button></label><label>Author colors<input id=author value=3 disabled></label></main>',
  css: 'main{pointer-events:auto;padding:20px;font:16px/24px "Disabled Fixture"}label{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}input,textarea,select,button{box-sizing:border-box;width:160px;height:32px;padding:4px;font:16px/24px "Disabled Fixture"}#author{color:#900;background:#fff0d0;border-color:#169}',
};

export function mountDisabledControls(document: Document) {
  const result = mountUi(disabledControlsAsset, { root: document.body, layer: 1 });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export const disabledControlsRasterCase: UiRasterCase = {
  name: 'disabled-controls',
  html: disabledControlsHtml,
  width: 430,
  height: 400,
  states: [
    {
      name: 'default',
      time: 0,
      apply: (ui) => {
        mountDisabledControls(ui.document);
      },
    },
  ],
};
