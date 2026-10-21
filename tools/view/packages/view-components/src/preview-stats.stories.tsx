import type { Meta, StoryObj } from '@storybook/react-vite';
import { PreviewStatsOverlay } from './PreviewStatsOverlay';

const meta = {
  title: 'Feedback/Preview Stats', component: PreviewStatsOverlay, tags: ['autodocs'],
  parameters: { docs: { description: { component: 'Fixed viewport statistics with pointer events disabled. The consumer supplies translated rows and controls visibility; there is no expansion or scrolling interaction.' } } },
  args: { label: 'Mesh statistics', rows: [
    { id: 'triangles', label: 'Triangles', value: '12' },
    { id: 'vertices', label: 'Vertices', value: '24' },
    { id: 'uv', label: 'UV channels', value: '2' },
    { id: 'size', label: 'Local dimensions', value: '100 x 100 x 100' },
    { id: 'collision', label: 'Collision data', value: 'None' },
  ] },
  decorators: [Story => <div style={{ position: 'relative', width: '100%', height: 260, background: '#52616a' }}><Story /></div>],
} satisfies Meta<typeof PreviewStatsOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Narrow: Story = { decorators: [Story => <div style={{ position: 'relative', width: 240, height: 260 }}><Story /></div>], args: { rows: [
  { id: 'count', label: 'Triangles', value: '12,345,678' },
  { id: 'size', label: 'Local dimensions', value: '123456.123 x 456789.456 x 789012.789' },
  { id: 'unavailable', label: 'Collision triangles', value: 'Unavailable' },
] } };
