import { topologyVisual } from './support/topology-visual';

export default topologyVisual('ribbon', {
  title: 'Ribbon particles',
  catalog: 'Ribbon particles',
  summary:
    'A ribbon renderer connects live particles in alive-index order into one camera-facing strip; the WGSL program places them on a rising helix.',
  expect:
    'ON: a cyan helical ribbon in the center column. OFF (session mask off): the ribbon disappears.',
});
