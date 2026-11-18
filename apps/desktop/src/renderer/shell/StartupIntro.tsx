import { useEffect, useState } from 'react';

import { MOTION } from './motion';

/** How long the intro plays, in milliseconds; styles.css times its steps within it. */
export const INTRO_MS = 1250;

/**
 * As the window opens, usee's mark draws itself once: the plate, the lens
 * ring, then the tally light coming on, and the whole mark zooms past as the
 * app shows through. It never takes a click, and it does not play when
 * Windows asks for less motion.
 */
export function StartupIntro() {
  const [playing, setPlaying] = useState(MOTION);
  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const timer = window.setTimeout(() => setPlaying(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [playing]);

  if (!playing) {
    return null;
  }
  return (
    <div className="startup-intro" aria-hidden="true">
      <div className="startup-mark">
        <svg className="startup-mark-art" viewBox="0 0 28 28" focusable="false">
          <rect className="intro-plate" x="1.5" y="1.5" width="25" height="25" rx="8" />
          <circle className="intro-glass" cx="14" cy="14" r="5.2" />
          <circle className="intro-lens" cx="14" cy="14" r="6.2" pathLength={1} />
          <circle className="intro-glow" cx="14" cy="14" r="4.6" />
          <circle className="intro-tally" cx="14" cy="14" r="2.6" />
        </svg>
        <span className="startup-word">usee</span>
      </div>
    </div>
  );
}
