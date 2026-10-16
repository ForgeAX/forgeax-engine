import { topologyVisual } from './support/topology-visual';

export default topologyVisual('beam', {
  title: 'Beam particles',
  catalog: 'Beam particles',
  summary:
    'A beam renderer draws a segment per particle from position to position + velocity * lifetime (endpointField velocity), here a fan of nine rays.',
  expect:
    'ON: an orange fan of nine beams on the right. OFF (session mask off): the fan disappears.',
});
