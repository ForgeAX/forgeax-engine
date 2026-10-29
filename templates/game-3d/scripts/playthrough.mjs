// Run: pnpm exec forgeax project play scripts/playthrough.mjs --require-ui --json
// `project play` starts a temporary game, waits until input is open, runs this
// module with real browser input, then applies the runtime gate to the final
// frame. `game-3d.player` is the template's read projection
// (assets/player/player.ts); keep the steps in sync when the player changes.

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  const start = await play.step('spawn', async () => {
    await play.screenshot('spawn');
    return play.state('game-3d.player');
  });
  const distance = (s) =>
    Math.hypot(s.position[0] - start.position[0], s.position[2] - start.position[2]);
  const walked = await play.step('walk', () =>
    play.keyboard.hold('KeyW', (s) => distance(s) > 0.3, { read: 'game-3d.player' }),
  );
  await play.step('jump', () =>
    play.keyboard.hold('Space', (s) => s.position[1] > walked.position[1] + 0.2, {
      read: 'game-3d.player',
    }),
  );
  await play.waitFor((s) => s.grounded, { read: 'game-3d.player', timeoutMs: 20_000 });
  await play.screenshot('after-jump');
  return { walked: Number(distance(walked).toFixed(2)) };
}
