import playthrough from '../../../../templates/game-3d/scripts/playthrough.mjs';

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function cloudsPlaythrough(play) {
  const gameplay = await playthrough(play);
  const inspectSky = async (checkpoint) => {
    await play.mouse.drag([0.5, 0.8], [0.5, 0.2], { button: 'right' });
    const state = await play.state('game-3d.player');
    if (state.camera.pitch >= 0) throw new Error('Mouse input did not turn the camera toward the sky');
    await play.screenshot(checkpoint);
    return state.camera.pitch;
  };
  const pitch = await play.step('procedural-cloud-sky', () => inspectSky('procedural-cloud-sky'));
  await play.step('cloud-sky-after-reload', async () => {
    await play.reload();
    await inspectSky('cloud-sky-after-reload');
  });
  return { ...gameplay, skyCameraPitch: pitch };
}
