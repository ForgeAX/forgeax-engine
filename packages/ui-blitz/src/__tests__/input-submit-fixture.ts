import { required } from './fixture.js';
import type { UiRasterCase } from './gpu-parity-fixture.js';

export const inputSubmitRasterCase: UiRasterCase = {
  name: 'input-submit',
  html: '<!doctype html><style>body{margin:16px;background:white;font:16px/24px "UI Fixture"}form{display:grid;gap:12px}input{box-sizing:border-box;width:140px;height:36px;padding:4px;font:inherit}</style><form><label>Radius <input id=radius type=number value=0.35 min=0.1 max=2 step=0.05 required></label><input id=submit type=submit value=Generate><input id=action type=button value=Cancel></form>',
  width: 360,
  height: 210,
  states: [
    { name: 'static-label', time: 0 },
    {
      name: 'updated-label',
      time: 1,
      apply: (ui) => {
        const submit = required(ui.document.querySelector<HTMLInputElement>('#submit'));
        submit.value = 'Apply';
        submit.setAttribute('value', 'Retry');
      },
      inspect: (ui) => required(ui.document.querySelector<HTMLInputElement>('#submit')).value,
      expected: 'Retry',
    },
  ],
};
