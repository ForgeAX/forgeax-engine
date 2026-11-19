// Run: pnpm exec forgeax project play scripts/playthrough.mjs --require-ui --json
// `project play` starts a temporary game, waits until input is open, runs this
// module with real browser input, then applies the runtime gate to the final frame.
// Iteration runs may add --from <step> (a step with a setup); final acceptance
// runs the whole journey in real time.
//
// PlayContext signatures and gotchas: skills/forgeax-engine-sdk/references/api/play.md
// (also `pnpm exec forgeax help project play --json`).
// `game-3d.player` is this template's read projection (assets/player/player.ts);
// keep the steps in sync when the player changes.

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  const start = await play.step('spawn', async () => {
    await play.screenshot('spawn');
    return play.state('game-3d.player');
  });
  const distance = (s) =>
    Math.hypot(s.position[0] - start.position[0], s.position[2] - start.position[2]);
  // Mouse look: the player reads movementDelta while the right button is held.
  await play.step('look', async () => {
    await play.mouse.drag([0.5, 0.5], [0.65, 0.5], { button: 'right' });
    const s = await play.state('game-3d.player');
    if (Math.abs(s.camera.yaw - start.camera.yaw) < 0.01) throw new Error('camera yaw did not change');
  });
  const walked = await play.step('walk', async () => {
    const s = await play.keyboard.hold('KeyW', (p) => distance(p) > 0.3, { read: 'game-3d.player' });
    return Number(distance(s).toFixed(2));
  });
  // The setup reaches this step's start state, so `--from jump` can skip the steps before it.
  const grounded = () => play.waitFor((s) => s.grounded, { read: 'game-3d.player', timeoutMs: 20_000 });
  await play.step(
    'jump',
    async () => {
      const before = await play.state('game-3d.player');
      const read = { read: 'game-3d.player' };
      await play.keyboard.hold('Space', (s) => s.position[1] > before.position[1] + 0.2, read);
    },
    { setup: grounded },
  );
  await grounded();
  await play.screenshot('after-jump');
  return { walked };
}
