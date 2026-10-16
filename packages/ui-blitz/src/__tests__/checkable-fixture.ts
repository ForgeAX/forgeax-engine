import { required } from './fixture.js';

export const checkableHtml =
  '<style>body{margin:0}input{width:24px;height:24px}input:checked{outline:2px solid red}</style><form id="first"><label id="label" for="check">Check</label><input id="check" type="checkbox" checked><input id="one" type="radio" name="group" checked><input id="two" type="radio" name="group"><input id="peer" type="checkbox" name="group" checked></form><form><input id="other" type="radio" name="group" checked></form><input id="empty-one" type="radio"><input id="empty-two" type="radio"><div id="host"></div>';

/** Same DOM operations in Chromium and the real WASM document. */
export function checkableTrace(document: Document) {
  const field = (id: string) => required(document.querySelector<HTMLInputElement>(`#${id}`));
  const check = field('check');
  const one = field('one');
  const two = field('two');
  const shadow = required(document.querySelector('#host')).attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input type="radio" name="group" checked>';
  const shadowRadio = required(shadow.querySelector('input'));
  const trace: unknown[] = [];
  for (const control of [check, one, two])
    for (const kind of ['click', 'input', 'change'])
      control.addEventListener(kind, (event) => {
        trace.push([control.id, kind, control.checked, event.bubbles, event.composed]);
      });
  const states: unknown[] = [];
  const state = () =>
    states.push({
      check: [check.checked, check.defaultChecked, check.matches(':checked')],
      radios: [one.checked, two.checked, field('other').checked, shadowRadio.checked],
      peer: field('peer').checked,
    });
  state();
  check.defaultChecked = false;
  state();
  check.checked = true;
  check.defaultChecked = true;
  check.defaultChecked = false;
  state();
  check.checked = false;
  check.click();
  state();
  check.addEventListener('click', (event) => event.preventDefault(), { once: true });
  check.click();
  state();
  check.disabled = true;
  check.click();
  check.disabled = false;
  required(document.querySelector<HTMLLabelElement>('#label')).click();
  state();
  two.click();
  two.click();
  state();
  one.addEventListener('click', (event) => event.preventDefault(), { once: true });
  one.click();
  state();
  one.checked = true;
  state();
  field('empty-one').checked = true;
  field('empty-two').checked = true;
  const pristine = document.createElement('input');
  pristine.type = 'checkbox';
  pristine.setAttribute('checked', 'false');
  const before = pristine.checked;
  pristine.removeAttribute('checked');
  const after = pristine.checked;
  return {
    states,
    trace,
    unnamed: [field('empty-one').checked, field('empty-two').checked],
    booleanAttribute: [before, after],
  };
}
