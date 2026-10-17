import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { Button } from './components';
import { PanelVisibilityProvider, usePanelVisible } from './panel-visibility';

function Observation() {
  const visible = usePanelVisible();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setReads(value => value + 1), 500);
    return () => clearInterval(timer);
  }, [visible]);
  return <output>Presentation reads: {reads}</output>;
}
function Example() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(false);
  return <div>
    <Button onClick={() => setHidden(value => !value)}>{hidden ? 'Show panel' : 'Hide panel'}</Button>
    <div ref={setElement} hidden={hidden} style={{ padding: 20 }}>
      {element && <PanelVisibilityProvider element={element}><Observation /></PanelVisibilityProvider>}
    </div>
    <p>Hide the panel, wait, and show it again. Its counter retains its value and resumes from it.</p>
  </div>;
}
export default { title: 'Workspace Patterns/Panel observation', component: PanelVisibilityProvider,
  parameters: { docs: { description: { component:
    'Panel activity derives from DOM visibility and document visibility. Hidden panels retain presentation state while active observation queries stop. This does not suspend Engine execution or the shared Host transport.' } } },
} satisfies Meta<typeof PanelVisibilityProvider>;
export const RetainedState: StoryObj = { render: () => <Example /> };
