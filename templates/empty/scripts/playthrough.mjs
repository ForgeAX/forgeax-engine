// Run: pnpm exec forgeax project play scripts/playthrough.mjs --json
// `project play` starts a temporary game, waits until input is open, runs this
// module with real browser input, and then applies the runtime gate to the
// final frame (no fatal, no console/page errors, non-uniform canvas). An empty
// scene draws one clear color, so the gate reports `flat-canvas` until the
// game renders content. Edit the steps below into the game's own journey.

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  await play.step('start', async () => {
    await play.screenshot('start');
  });
  await play.step('core input', async () => {
    // Points are canvas-normalized: [0, 0] top-left, [1, 1] bottom-right.
    await play.mouse.click([0.5, 0.5]);
    await play.keyboard.press('Space');
    // Read the game's projection (gameHost.gameProjection.registerRead) and
    // assert the gameplay result, for example:
    //   const state = await play.waitFor((s) => s.score > 0);
    //   if (state.phase !== 'playing') throw new Error(`phase ${state.phase}`);
  });
  await play.step('reload', async () => {
    await play.reload();
    await play.screenshot('after-reload');
  });
}
