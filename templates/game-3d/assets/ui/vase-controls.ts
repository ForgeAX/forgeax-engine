import { VASE_CHANNEL, VASE_PARAMETERS, type VaseState } from '../runtime-vase/vase-program.ts';

/** The Host owns DOM; the Engine owns generation. Both borrow GameHost.port. */
export function installVaseControls(
  root: ShadowRoot,
  port: MessagePort,
  translate: (key: string, options?: { count: number }) => string,
) {
  const document = root.ownerDocument;
  const form = root.querySelector<HTMLFormElement>('[data-ui-part="vase-controls"]');
  const status = root.querySelector<HTMLElement>('[data-ui-part="vase-status"]');
  const button = form?.querySelector<HTMLButtonElement>('button');
  if (!form || !status || !button) throw new Error('Runtime vase UI is incomplete');
  const controls = VASE_PARAMETERS.map((parameter) => {
    const label = document.createElement('label');
    const text = document.createTextNode('');
    const input = document.createElement('input');
    input.name = parameter.name;
    input.type = 'number';
    input.min = String(parameter.minimum);
    input.max = String(parameter.maximum);
    input.step = parameter.type === 'u32' ? '1' : '0.05';
    input.value = String(parameter.default);
    input.required = true;
    label.append(text, input);
    form.insertBefore(label, button);
    return { input, text };
  });
  let state: VaseState | undefined;
  // Language changes only project text from the accepted game state. They never
  // reapply values, replace controls or ask the Engine to generate another vase.
  const localize = () => {
    for (const { input, text } of controls) text.textContent = translate(`vase.fields.${input.name}`);
    button.textContent = translate('vase.generate');
    status.textContent = !state ? translate('vase.preparing') : state.busy ? translate('vase.busy')
      : state.error ? translate('vase.error') : translate('vase.generated', { count: state.vertexCount ?? 0 });
  };
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== VASE_CHANNEL || event.data.kind !== 'state') return;
    state = event.data.state as VaseState;
    button.disabled = state.busy;
    for (const { input } of controls) {
      input.disabled = state.busy;
      if (!state.busy && !state.error) input.value = String(state.values[input.name as keyof typeof state.values]);
    }
    localize();
    status.dataset.state = state.busy ? 'busy' : state.error ? 'error' : 'ready';
  };
  // Generation is a local action; sandboxed hosts need no form-navigation permission.
  const submit = (event: Event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    port.postMessage({ channel: VASE_CHANNEL, kind: 'generate',
      values: Object.fromEntries(controls.map(({ input }) => [input.name, input.valueAsNumber])),
    });
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') submit(event);
  };
  button.addEventListener('click', submit);
  form.addEventListener('keydown', keydown);
  port.addEventListener('message', receive);
  port.start();
  port.postMessage({ channel: VASE_CHANNEL, kind: 'inspect' });
  localize();
  return { localize, dispose() {
    button.removeEventListener('click', submit);
    form.removeEventListener('keydown', keydown);
    port.removeEventListener('message', receive);
    for (const { input } of controls) input.parentElement?.remove();
  } };
}
