/** Follow the panel's enabled import action before supplying saved content. */
export async function importRuntimeContent(page, panel, files) {
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Import content', exact: true }).click();
  await (await chooser).setFiles(files);
}

/** Follow the enabled save action before observing its native download. */
export async function saveRuntimeContent(page, panel, options = {}) {
  const button = panel.getByRole('button', { name: 'Save content', exact: true });
  await button.click({ trial: true });
  await button.evaluate(element => globalThis.__runtimeContentDownloadEvidence?.push({
    at: Date.now(), stage: 'save-ready', disabled: element.disabled,
  }));
  const [download] = await Promise.all([
    page.waitForEvent('download', options),
    button.click().then(() => button.evaluate(() => globalThis.__runtimeContentDownloadEvidence?.push({
      at: Date.now(), stage: 'save-click-complete',
    }))),
  ]);
  return download;
}

/** Open the optional runtime tools through the Content Browser menu. */
export async function openRuntimeContent(page) {
  await page.getByRole('button', { name: 'Content Browser settings', exact: true }).click();
  await page.getByRole('button', { name: 'Runtime asset tools', exact: true }).click();
}
