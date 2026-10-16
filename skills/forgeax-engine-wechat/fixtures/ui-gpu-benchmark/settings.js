import { controlsWorkflowHtml, mountControlsWorkflow } from '@probe/settings-scene';

export const html = controlsWorkflowHtml;
export const fontFamily = 'Inventory Fixture';

// The existing author source/controller owns every control and transition.
export function mount(document, { rect, point }) {
  const flow = mountControlsWorkflow(document);
  const required = (selector) => {
    const element = flow.shadow.querySelector(selector);
    if (!element) throw new Error(`Missing settings element ${selector}`);
    return element;
  };
  return {
    dispose() {
      flow.settings.dispose();
      flow.inventoryUi.dispose();
    },
    scrollTo: (top) => {
      flow.form.scrollTop = top;
    },
    snapshot() {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const controls = Array.from(flow.shadow.querySelectorAll('[data-ui-setting]'));
      const dialog = required('[role="dialog"]');
      const close = required('button[data-ui-action="close-settings"]');
      return {
        modalOpen: !dialog.hidden,
        pageInert: flow.inventoryUi.host.inert,
        active:
          active?.getAttribute('data-ui-setting') ?? active?.getAttribute('role') ?? active?.id,
        ids: Array.from(flow.items.children, (row) => row.id),
        values: flow.quantities.map((field) => field.value),
        valid: flow.quantities.map((field) => field.validity.valid),
        scroll: {
          top: flow.form.scrollTop,
          height: flow.form.scrollHeight,
          client: flow.form.clientHeight,
        },
        submittedValues: flow.submitted.map((values) => [...values]),
        settings: { ...flow.state },
        trace: flow.trace.slice(),
        geometry: [
          flow.inventory,
          flow.form,
          flow.apply,
          flow.opener,
          ...flow.quantities,
          required('[role="document"]'),
          required('#settings-title'),
          ...controls,
          close,
        ].map((element) => ({
          id:
            element.id ||
            element.getAttribute('data-ui-setting') ||
            element.getAttribute('role') ||
            element.getAttribute('data-ui-action'),
          ...rect(element),
        })),
        points: {
          add: point(flow.add),
          open: point(flow.opener),
          close: point(close),
          apply: point(flow.apply),
          scroll: point(flow.form),
          quantities: flow.quantities.map(point),
          controls: Object.fromEntries(
            controls.map((element) => [
              element.getAttribute('data-ui-setting'),
              point(element),
            ]),
          ),
        },
      };
    },
  };
}
