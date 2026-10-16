/** Follow the panel's enabled import action before supplying saved content. */
export async function importRuntimeContent(page, panel, files) {
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Import content', exact: true }).click();
  await (await chooser).setFiles(files);
}

/** Open the optional runtime tools through the Content Browser menu. */
export async function openRuntimeContent(page) {
  await page.getByRole('button', { name: 'Content Browser settings', exact: true }).click();
  await page.getByRole('button', { name: 'Runtime asset tools', exact: true }).click();
}
