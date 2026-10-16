import { mountUi } from '@forgeax/engine-ui';
import {
  createGameSettingsState,
  mountSettings,
  SETTINGS_UI_GUID,
} from '../../../../apps/game-capability-lab/assets/plugins/settings.js';
import settingsSource from '../../../../apps/game-capability-lab/assets/ui/settings.pack.json';
import { required } from './fixture.js';
import { inventoryHtml, mountInventory } from './inventory-fixture.js';

export const controlsWorkflowHtml = inventoryHtml.replace(
  '</style>',
  `
  #inventory{width:344px}#items{margin:0}.item{flex-wrap:wrap;gap:8px}.quantity{display:flex;width:100%;justify-content:space-between;align-items:center}
  .quantity input{font:inherit;width:72px;height:30px;box-sizing:border-box;padding:4px}
  #quantities{height:208px;overflow:auto;margin:0 0 12px;padding:4px;border:1px solid #8097af}
  #apply{margin-top:12px;width:100%}#settings-open{position:absolute;left:384px;top:16px;width:224px}
  #game{top:408px;width:344px}
</style>`,
);

/** One author controller combines the existing inventory and actual settings UI. */
export function mountControlsWorkflow(document: Document) {
  const inventory = mountInventory(document);
  // Mount the retained inventory nodes through the actual UiAsset owner too,
  // so the browser reference receives the same control defaults as a real game.
  const mounted = mountUi(
    {
      guid: 'controls-workflow-inventory',
      html: '',
      css: `${required(controlsWorkflowHtml.split('<style>')[1]?.split('</style>')[0]).replace(
        /@font-face\{[^}]+\}/,
        '',
      )}\n#inventory,#game{pointer-events:auto}`,
    },
    { root: document.body, layer: 0 },
  );
  if (!mounted.ok) throw mounted.error;
  const inventoryUi = mounted.value;
  required(inventoryUi.host.shadowRoot).append(inventory.inventory, inventory.game);
  const form = document.createElement('form');
  form.id = 'quantities';
  inventory.items.replaceWith(form);
  form.append(inventory.items);
  const rows = [
    required(inventory.a.parentElement),
    inventory.row,
    required(inventory.c.parentElement),
  ];
  const quantities = rows.map((row, index) => {
    const label = document.createElement('label');
    label.className = 'quantity';
    label.textContent = 'Quantity';
    const field = document.createElement('input');
    field.type = 'number';
    field.min = '1';
    field.max = '9';
    field.required = true;
    field.id = `quantity-${index}`;
    field.defaultValue = ['3', '', '1'][index] ?? '';
    label.append(field);
    row.append(label);
    return field;
  });
  const apply = document.createElement('button');
  apply.id = 'apply';
  apply.type = 'submit';
  apply.textContent = 'Apply quantities';
  form.append(apply);
  const submitted: number[][] = [];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted.push(
      Array.from(form.querySelectorAll<HTMLInputElement>('input'), (field) => field.valueAsNumber),
    );
  });
  const opener = document.createElement('button');
  opener.id = 'settings-open';
  opener.type = 'button';
  opener.textContent = 'Game settings (F2)';
  document.body.append(opener);
  const state = createGameSettingsState();
  const settings = mountSettings(
    { guid: SETTINGS_UI_GUID, ...settingsSource.assets['ui/settings'].payload },
    document.body,
    state,
    opener,
  );
  if (settings.error) throw settings.error;
  opener.addEventListener('click', () => settings.open());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F2') {
      event.preventDefault();
      settings.open();
    }
  });
  return {
    ...inventory,
    inventoryUi,
    form,
    quantities,
    apply,
    submitted,
    opener,
    state,
    settings,
    shadow: required(required(settings.instance).host.shadowRoot),
  };
}
