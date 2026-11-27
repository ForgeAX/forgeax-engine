import assert from 'node:assert/strict';

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function checkpointPlaythrough(play) {
  const read = 'game-3d.player';
  const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
  const checkpoint = play.page.getByRole('button', { name: 'Save checkpoint' });
  const status = play.page.locator('[data-ui-part="checkpoint-status"]');
  const before = await play.waitFor((player) => player.grounded, { read });
  const saved = await play.step('walk-and-save', async () => {
    await play.keyboard.hold('KeyW', (player) => distance(player, before) > 1, { read });
    const position = await play.waitFor((player) => player.grounded, { read });
    await checkpoint.click();
    await status.filter({ hasText: /^Checkpoint saved$/ }).waitFor();
    return position;
  });
  const restored = await play.step('reload-and-restore', async () => {
    await play.reload();
    await status.filter({ hasText: /^Checkpoint restored$/ }).waitFor();
    return play.waitFor((player) => player.grounded && distance(player, saved) < 0.45, { read });
  });
  assert.ok(distance(before, restored) > 0.55);
  await play.screenshot('checkpoint-restored');
  return { walked: distance(before, saved), restored: distance(saved, restored) };
}
