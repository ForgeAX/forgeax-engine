import { CanvasTexture, Materials } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, material, spawnCamera, spawnMesh } from '../../lab/stage';

function paint(ctx: CanvasRenderingContext2D, on: boolean): void {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = on ? '#ff00c8' : '#00c8ff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = on ? '#ffe600' : '#003040';
  ctx.fillRect(width * 0.1, height * 0.1, width * 0.5, height * 0.35);
  ctx.font = `bold ${height * 0.22}px sans-serif`;
  ctx.fillText(on ? 'ON' : 'OFF', width * 0.15, height * 0.85);
}

export default defineFeature({
  title: 'Runtime CanvasTexture',
  catalog: 'Runtime CanvasTexture',
  kind: 'visual',
  summary:
    'new CanvasTexture(canvas, { flipY }) exposes a caller-owned 2D canvas as a CanvasTextureSource. The renderer uploads only after update(); the material samples it like any baseColorTexture.',
  expect:
    'ON: the quad shows a magenta canvas with a yellow box and the text ON (upright). OFF: the canvas is repainted cyan with OFF and update() publishes the new pixels.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 1, 4], target: [0, 1, 0] });
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const display = new CanvasTexture(canvas, { flipY: false });
    const source = world.allocSharedRef('CanvasTextureSource', display.source);
    const mat = material(
      world,
      Materials.unlit([1, 1, 1, 1], { baseColorTexture: source as never }),
    );
    spawnMesh(world, MESH.quad, mat, { pos: [0, 1, 0], scale: [2.6, 2.6, 1] });
    const draw = (on: boolean) => {
      if (ctx === null) return;
      paint(ctx, on);
      display.update();
    };
    draw(true);
    return {
      toggle: draw,
      checks: () => [
        { name: '2d context available', ok: ctx !== null },
        { name: 'source has a positive canvasTextureId', ok: display.source.canvasTextureId > 0 },
        { name: 'source orientation is flipY false', ok: display.source.flipY === false },
      ],
    };
  },
});
