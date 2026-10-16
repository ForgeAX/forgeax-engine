import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

it('validates a required multiline feedback form before submission and respects cancellation and editability', async () => {
  const html = `<!doctype html><style>body{margin:0}form{padding:12px}label{display:block}textarea{display:block;width:220px;height:60px}</style>
    <form><label>Subject<input id=subject required value="Game feedback"></label>
    <label>Details<textarea id=details required></textarea></label><button id=send>Send feedback</button></form>`;
  const iframe = document.createElement('iframe');
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width: 320,
    height: 240,
    onError: (error) => errors.push(error),
  });
  try {
    await loaded;
    const run = (document: Document) => {
      const form = required(document.querySelector('form'));
      const details = required(document.querySelector<HTMLTextAreaElement>('#details'));
      const subject = required(document.querySelector<HTMLInputElement>('#subject'));
      const send = required(document.querySelector<HTMLButtonElement>('#send'));
      const events: string[] = [];
      let submissions = 0;
      details.addEventListener('invalid', () => events.push('invalid'));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        events.push(`submit:${(event.submitter as HTMLElement | null)?.id ?? ''}`);
        submissions++;
      });
      const states: unknown[] = [];
      const snapshot = (stage: string) =>
        states.push({
          stage,
          willValidate: details.willValidate,
          missing: details.validity.valueMissing,
          valid: details.validity.valid,
          message: details.validationMessage !== '',
          focus: document.activeElement?.id ?? '',
          submissions,
        });
      subject.focus();
      const checked = form.checkValidity();
      snapshot('empty-check');
      send.click();
      snapshot('empty-submit');
      details.value = 'The scene loads.\nThe controls respond.';
      send.click();
      snapshot('completed-submit');
      details.value = '';
      subject.focus();
      details.addEventListener('invalid', (event) => event.preventDefault(), { once: true });
      send.click();
      snapshot('canceled-feedback');
      details.readOnly = true;
      send.click();
      snapshot('readonly');
      details.readOnly = false;
      details.disabled = true;
      send.click();
      snapshot('disabled');
      details.disabled = false;
      details.required = false;
      send.click();
      snapshot('optional');
      return { checked, states, events };
    };
    const browser = run(required(iframe.contentDocument));
    const native = run(ui.document);
    await commands.writeFile(
      `${uiEvidenceDirectory(required(expect.getState().testPath), 'ui-textarea-validation')}/result.json`,
      JSON.stringify({ browser, native, errors }, null, 2),
    );
    expect(browser.checked).toBe(false);
    expect(browser.events).toEqual([
      'invalid',
      'invalid',
      'submit:send',
      'invalid',
      'submit:send',
      'submit:send',
      'submit:send',
    ]);
    expect(native).toEqual(browser);
    expect(errors).toEqual([]);
  } finally {
    ui.dispose();
    iframe.remove();
  }
}, 30_000);
