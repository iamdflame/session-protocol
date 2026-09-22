/* One icon family, drawn on a 20-unit grid with a 1.6 stroke and round caps.
 *
 * Small and supportive: every icon here labels something that also has words,
 * or is a control with an accessible name. None is decoration. Kept in one
 * file so a new glyph is drawn to the same rules as the rest rather than
 * pasted in from wherever. */
import type { SVGProps } from 'react';

const PATHS = {
  trade: 'M4 7h11l-3-3M16 13H5l3 3',
  markets: 'M3.5 16.5V9M8.5 16.5V4.5M13.5 16.5v-5M17 16.5H3',
  portfolio: 'M3.5 6.5h13v9.5h-13zM7 6.5V4.5h6v2M3.5 10.5h13',
  research: 'M4 15.5l3.5-4 3 2.5L16 6.5M16 6.5v3.5M16 6.5h-3.5',
  how: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 13.5v.2M8.2 8.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4',
  bell: 'M6 8a4 4 0 1 1 8 0c0 3.8 1.5 5 1.5 5h-11S6 11.8 6 8zM8.6 15.6a1.5 1.5 0 0 0 2.8 0',
  list: 'M10 4.5v11M4.5 10h11',
  search: 'M8.8 14.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6zM12.6 12.6l3.9 3.9',
  close: 'M5 5l10 10M15 5L5 15',
  chevronDown: 'M5.5 8l4.5 4.5L14.5 8',
  chevronRight: 'M8 5.5l4.5 4.5L8 14.5',
  external: 'M8 4.5H4.5v11h11V12M11 4.5h4.5V9M15.5 4.5L9 11',
  copy: 'M7 7h8.5v8.5H7zM13 7V4.5H4.5V13H7',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  star: 'M10 3.5l2 4.2 4.5.6-3.3 3.1.8 4.5L10 13.7l-4 2.2.8-4.5-3.3-3.1 4.5-.6z',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  info: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 9.2v4M10 6.8h.01',
  wallet: 'M3.5 6.5h12a1 1 0 0 1 1 1v8H4.5a1 1 0 0 1-1-1v-8zM3.5 6.5l9-2.5v2.5M13 11.5h.01',
  logout: 'M8 4.5H4.5v11H8M11.5 7l3 3-3 3M14.5 10H7.5',
  clock: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 6.5V10l2.5 1.5',
  layers: 'M10 3.5l6.5 3.5L10 10.5 3.5 7zM3.5 10.5L10 14l6.5-3.5M3.5 13.5L10 17l6.5-3.5',
  command: 'M7.5 7.5h5v5h-5zM7.5 7.5V6a1.5 1.5 0 1 0-1.5 1.5zM12.5 7.5V6a1.5 1.5 0 1 1 1.5 1.5zM12.5 12.5V14a1.5 1.5 0 1 0 1.5-1.5zM7.5 12.5V14A1.5 1.5 0 1 1 6 12.5z',
  play: 'M7 5l8 5-8 5z',
  menu: 'M4 6.5h12M4 10h12M4 13.5h12',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
