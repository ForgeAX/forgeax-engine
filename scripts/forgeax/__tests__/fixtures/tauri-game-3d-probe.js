globalThis.__forgeaxTauriSmokeProbe = async () => {
  const wait = async (condition) => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const value = await condition();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Game 3D WebView observation timed out');
  };
  const root = document.querySelector('#game-ui > [data-ui-asset]')?.shadowRoot;
  if (!root) throw new Error('The ordinary game UiAsset was not mounted');
  const title = root.querySelector('[data-ui-part="guide-title"]');
  root.querySelector('[data-ui-action="language-fr"]').click();
  await wait(() => title.textContent === 'Prototype 3C');
  root.querySelector('[data-ui-action="language-en"]').click();
  await wait(() => title.textContent === '3C starter');
  const status = root.querySelector('[data-ui-part="vase-status"]');
  await wait(() => status.dataset.state === 'ready');
  const initial = status.textContent;
  const form = root.querySelector('[data-ui-part="vase-controls"]');
  const height = form.querySelector('input[name="height"]');
  const sides = form.querySelector('input[name="sides"]');
  height.focus();
  height.value = '3.5';
  height.dispatchEvent(new Event('input', { bubbles: true }));
  sides.value = '16';
  form.querySelector('button').click();
  await wait(() => status.dataset.state === 'ready' && status.textContent !== initial);
  const updated = status.textContent;
  if (height.value !== '3.5') throw new Error('Engine did not acknowledge the edited vase height');
  height.min = '0';
  height.value = '0';
  form.querySelector('button').click();
  await wait(() => status.dataset.state === 'error');
  const rejected = status.textContent;
  height.min = '1';
  height.value = '2.4';
  form.querySelector('button').click();
  await wait(() => status.dataset.state === 'ready');
  if (height.value !== '2.4')
    throw new Error('Vase did not recover through the ordinary UI action');
  height.blur();
  return { language: title.textContent, initial, updated, rejected, recovered: status.textContent };
};
