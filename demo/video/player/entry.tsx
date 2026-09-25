/* Plays one scene full-screen in real time, for the screencast recorder.
   window.__player is the Remotion PlayerRef; window.__ended flips when it ends. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import durations from '../src/durations.json';
import { PITCH } from '../src/pitch';
import { TECH } from '../src/technical';

const scenes: Record<string, React.FC> = { ...PITCH, ...TECH };
const id = new URLSearchParams(location.search).get('c') ?? 'P09';
const w = window as unknown as { __player?: PlayerRef | null; __ended?: boolean; __ready?: boolean };

const App: React.FC = () => {
  const ref = React.useRef<PlayerRef>(null);
  React.useEffect(() => {
    w.__player = ref.current;
    ref.current?.addEventListener('ended', () => { w.__ended = true; });
    document.fonts.ready.then(() => { w.__ready = true; });
  }, []);
  return (
    <Player ref={ref} component={scenes[id]} durationInFrames={(durations as Record<string, { seconds: number }>)[id].seconds * 30}
      fps={30} compositionWidth={1920} compositionHeight={1080} style={{ width: 1920, height: 1080 }}
      controls={false} clickToPlay={false} doubleClickToFullscreen={false} spaceKeyToPlayOrPause={false} />
  );
};
createRoot(document.getElementById('root')!).render(<App />);
