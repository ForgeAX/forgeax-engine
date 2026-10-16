import { topologyVisual } from './support/topology-visual';

export default topologyVisual('trail', {
  title: 'Trail particles',
  catalog: 'Trail particles',
  summary:
    'A trail renderer keeps a fixed GPU history ring per particle (historyLength 8) and draws a tapered strip behind each head; the heads orbit a circle.',
  expect:
    'ON: yellow comet trails orbiting a circle right of center. OFF (session mask off): the trails disappear.',
});
