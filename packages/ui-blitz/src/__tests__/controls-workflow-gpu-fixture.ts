import type { BlitzUi } from '../index.js';
import { controlsWorkflowHtml, mountControlsWorkflow } from './controls-workflow-fixture.js';
import { required } from './fixture.js';
import type { UiRasterCase } from './gpu-parity-fixture.js';

const flows = new WeakMap<BlitzUi, ReturnType<typeof mountControlsWorkflow>>();
const flow = (ui: BlitzUi) => required(flows.get(ui));
const key = (ui: BlitzUi, key: string) => {
  ui.input.key({ type: 'keydown', key });
  ui.input.key({ type: 'keyup', key });
};
const inspect = (ui: BlitzUi) => {
  const state = flow(ui);
  let active = ui.document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return [
    active?.getAttribute('data-ui-setting') ?? active?.getAttribute('role') ?? active?.id,
    state.form.scrollTop,
    state.quantities.map((field) => field.value),
    state.inventoryUi.host.inert,
  ];
};
export const controlsWorkflowRasterCase: UiRasterCase = {
  name: 'controls-workflow',
  html: controlsWorkflowHtml,
  width: 640,
  height: 480,
  states: [
    {
      name: 'initial',
      time: 0,
      apply: (ui) => {
        flows.set(ui, mountControlsWorkflow(ui.document));
        // Mounting a closed modal preserves focus; this raster scenario
        // explicitly starts with the settings launcher focused.
        flow(ui).opener.focus();
      },
      inspect,
      expected: ['settings-open', 0, ['3', '', '1'], false],
    },
    {
      name: 'inserted-number',
      time: 1,
      apply: (ui) => {
        flow(ui).add.focus();
        key(ui, 'Enter');
        key(ui, 'Tab');
      },
      inspect,
      expected: ['quantity-1', 0, ['3', '', '1'], false],
    },
    {
      name: 'required-validation',
      time: 2,
      apply: (ui) => {
        flow(ui).form.reportValidity();
      },
      inspect,
      expected: ['quantity-1', 0, ['3', '', '1'], false],
    },
    {
      name: 'range-validation',
      time: 3,
      apply: (ui) => {
        ui.input.text('12');
        required(flow(ui).quantities[1]).reportValidity();
      },
      inspect,
      expected: ['quantity-1', 0, ['3', '12', '1'], false],
    },
    {
      name: 'scroll-with-feedback',
      time: 4,
      apply: (ui) => {
        flow(ui).form.scrollTop = 60;
      },
      inspect,
      expected: ['quantity-1', 60, ['3', '12', '1'], false],
    },
    {
      name: 'settings-modal',
      time: 5,
      apply: (ui) => key(ui, 'F2'),
      inspect,
      expected: ['document', 60, ['3', '12', '1'], true],
    },
    {
      name: 'settings-controls',
      time: 6,
      apply: (ui) => {
        key(ui, 'Tab');
        key(ui, 'Home');
        key(ui, 'Tab');
        key(ui, 'Tab');
        key(ui, 'Home');
      },
      inspect,
      expected: ['antialias', 60, ['3', '12', '1'], true],
    },
    {
      name: 'origin-removed-modal-close',
      time: 7,
      apply: (ui) => {
        flow(ui).row.remove();
        key(ui, 'Escape');
      },
      inspect,
      expected: ['settings-open', 26, ['3', '12', '1'], false],
    },
    {
      name: 'retained-row-submitted',
      time: 8,
      apply: (ui) => {
        const state = flow(ui);
        state.add.focus();
        key(ui, 'Enter');
        key(ui, 'Tab');
        ui.input.text('4');
        state.form.reportValidity();
        state.apply.focus();
        key(ui, 'Enter');
      },
      inspect: (ui) => [
        ...inspect(ui),
        flow(ui).submitted,
        flow(ui).state.music,
        flow(ui).state.antialias,
      ],
      expected: ['apply', 120, ['3', '4', '1'], false, [[3, 4, 1]], 0, 'none'],
    },
  ],
};
