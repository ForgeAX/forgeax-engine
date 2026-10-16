/** Follow the panel's enabled import action before supplying saved content. */
export async function importRuntimeContent(page, panel, files) {
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Import content', exact: true }).click();
  await (await chooser).setFiles(files);
}
