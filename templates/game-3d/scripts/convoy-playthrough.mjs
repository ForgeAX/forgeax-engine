/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function convoyPlaythrough(play) {
  const read = 'game-3d.player';
  const start = await play.state(read);
  if (start.mode !== 'robot') throw new Error(`Expected robot after startup: ${JSON.stringify(start)}`);
  await play.step('orbit with real mouse input', async () => {
    await play.mouse.drag([0.1, 0.72], [0.9, 0.72], { button: 'right' });
    const state = await play.state(read);
    if (state.camera.yaw < 1) throw new Error('Mouse orbit did not turn the camera');
  });
  await play.screenshot('convoy-robot');
  await play.step('continuous transform', async () => {
    await play.keyboard.press('KeyT');
    // Step the actual World and render its final frame. Software GPU speed does
    // not determine the simulation duration, and the toggle remains real input.
    const middle = await play.advance(start.transformSeconds * 0.5, { read, stepSeconds: 0.05 });
    if (middle.mode !== 'transforming' || middle.transformProgress < 0.25 || middle.transformProgress > 0.9)
      throw new Error(`No intermediate transformation pose: ${JSON.stringify(middle)}`);
    await play.screenshot('convoy-folding');
    await play.advance(start.transformSeconds + 0.1, { read, stepSeconds: 0.05 });
  });
  const truck = await play.state(read);
  if (truck.mode !== 'truck' || truck.pose.headRetraction < 0.38 || Math.abs(truck.pose.thighRotationX + Math.SQRT1_2) > 0.01)
    throw new Error(`Truck pose did not reach its actual joint endpoint: ${JSON.stringify(truck)}`);
  await play.screenshot('convoy-truck');
  const driven = await play.step('drive with rolling wheels', () =>
    play.keyboard.hold('KeyW', s => Math.hypot(s.position[0] - truck.position[0], s.position[2] - truck.position[2]) > 0.8, { read, timeoutMs: 20_000 }));
  if (driven.wheelTime === truck.wheelTime) throw new Error('Driving did not rotate the wheels');
  await play.step('restore robot while moving', async () => {
    await play.page.keyboard.down('KeyW');
    try {
      await play.keyboard.press('KeyT');
      await play.advance(start.transformSeconds + 0.1, { read, stepSeconds: 0.037 });
      const robot = await play.state(read);
      if (robot.mode !== 'robot' || Math.abs(robot.pose.headRetraction) > 0.001) throw new Error('Robot pose did not restore');
    } finally { await play.page.keyboard.up('KeyW'); }
  });
  await play.screenshot('convoy-restored');
  await play.reload();
  const restored = await play.state(read);
  if (restored.mode !== 'robot' || restored.transformProgress !== 0) throw new Error('Reload retained transformation state');
  await play.screenshot('convoy-reloaded');
  return { mode: restored.mode, drivenMeters: Math.hypot(driven.position[0] - truck.position[0], driven.position[2] - truck.position[2]) };
}
