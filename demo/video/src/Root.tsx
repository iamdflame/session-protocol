import React from 'react';
import { Composition, Series } from 'remotion';
import durations from './durations.json';
import { PITCH } from './pitch';
import { TECH } from './technical';

const FPS = 30;
const W = 1920, H = 1080;
const secs = (id: string) => (durations as Record<string, { seconds: number }>)[id].seconds;

const Whole: React.FC<{ scenes: Record<string, React.FC> }> = ({ scenes }) => (
  <Series>
    {Object.entries(scenes).map(([id, Scene]) => (
      <Series.Sequence key={id} durationInFrames={secs(id) * FPS}><Scene /></Series.Sequence>
    ))}
  </Series>
);

export const Root: React.FC = () => (
  <>
    {Object.entries({ ...PITCH, ...TECH }).map(([id, Scene]) => (
      <Composition key={id} id={id} component={Scene} durationInFrames={secs(id) * FPS} fps={FPS} width={W} height={H} />
    ))}
    <Composition id="Pitch" component={() => <Whole scenes={PITCH} />} durationInFrames={Object.keys(PITCH).reduce((a, id) => a + secs(id) * FPS, 0)} fps={FPS} width={W} height={H} />
    {Object.keys(TECH).length > 0 && <Composition id="Technical" component={() => <Whole scenes={TECH} />} durationInFrames={Object.keys(TECH).reduce((a, id) => a + secs(id) * FPS, 0)} fps={FPS} width={W} height={H} />}
  </>
);
