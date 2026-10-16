import { topologyVisual } from './support/topology-visual';

export default topologyVisual('billboard', {
  title: 'Billboard particles',
  catalog: 'Billboard particles',
  summary:
    'A GPU emitter with a billboard renderer: camera-facing additive sprites burst upward from the left column, simulated and drawn entirely on the GPU.',
  expect:
    'ON: a magenta fountain of glowing sprites on the left. OFF (session mask off): the fountain disappears.',
});
