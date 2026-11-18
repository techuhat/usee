import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { LookChoices } from '../settings/LookChoices';
import type { SettingsStore } from '../settings/settings-store';
import { MOTION } from '../shell/motion';
import { AreaScene, AutoZoomScene, LooksScene, PrivacyScene } from './scenes';

interface Step {
  readonly title: string;
  readonly body: ReactNode;
  readonly scene: (settings: SettingsStore) => ReactNode;
}

const STEPS: readonly Step[] = [
  {
    title: 'Welcome to usee',
    body: (
      <p>
        Record your screen and get a video that looks edited. usee zooms in where you click, smooths
        the cursor and sets the picture on a background, so a demo or a bug report is ready to
        share.
      </p>
    ),
    scene: () => <AutoZoomScene />,
  },
  {
    title: 'Screen, window or area',
    body: (
      <p>
        Record a whole screen, one window or an area you draw, with your microphone if you want it.
        A three-second countdown starts the recording and usee steps aside. To stop, click the red
        dot in the notification area or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F10</kbd>.
      </p>
    ),
    scene: () => <AreaScene />,
  },
  {
    title: 'Your recordings stay with you',
    body: (
      <p>
        Everything stays on this computer: no account, no upload, no telemetry. You choose the
        microphone for each recording and it is never remembered. usee records where the pointer
        moves and clicks, never what you type.
      </p>
    ),
    scene: () => <PrivacyScene />,
  },
  {
    title: 'Choose how recordings start',
    body: (
      <p>
        Every new recording starts with these looks. Change any of them in the editor, and the rest
        in Settings.
      </p>
    ),
    scene: (settings) => <LooksScene settings={settings} />,
  },
];

const LAST = STEPS.length - 1;
/** How long the tour takes to leave, in milliseconds; styles.css matches it. */
const CLOSE_MS = 180;

/**
 * The welcome tour a first start opens with, and Settings opens again: four
 * steps, each with a picture of what it describes, the last one choosing the
 * looks new recordings start with. Escape, Skip or Done closes it for good.
 */
export function Welcome({
  settings,
  entranceDelayMs,
  onClose,
}: {
  readonly settings: SettingsStore;
  /** Waits for the startup intro when the tour opens with the app. */
  readonly entranceDelayMs: number;
  readonly onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  // Focus starts on the way forward and returns to where it was once the tour closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => before?.focus();
  }, []);
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [index]);

  const go = (to: number) => {
    if (to < 0 || to > LAST || to === index) {
      return;
    }
    setDirection(to > index ? 'forward' : 'back');
    setIndex(to);
  };
  const close = () => {
    if (closing) {
      return;
    }
    void settings.getState().update({ welcome: { seen: true } });
    if (MOTION) {
      setClosing(true);
      window.setTimeout(onClose, CLOSE_MS);
    } else {
      onClose();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      keepFocusInside(event, dialog.current);
      return;
    }
    // The arrows belong to a switch or the background swatches while one has focus.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target !== null && target.closest('[role="radiogroup"], input') !== null) {
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    }
  };

  const step = STEPS[index];
  if (step === undefined) {
    return null;
  }
  return (
    <div
      className={closing ? 'welcome-backdrop closing' : 'welcome-backdrop'}
      style={{ '--welcome-delay': `${String(entranceDelayMs)}ms` } as CSSProperties}
    >
      <section
        ref={dialog}
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onKeyDown={onKeyDown}
      >
        <div className="welcome-stage">
          <div key={index} className="welcome-scene">
            {step.scene(settings)}
          </div>
        </div>
        <div className="welcome-body">
          <div className="welcome-top">
            <ol className="welcome-steps" aria-label="Steps">
              {STEPS.map((candidate, at) => (
                <li key={candidate.title}>
                  <button
                    type="button"
                    className="welcome-dot"
                    aria-label={`Step ${String(at + 1)} of ${String(STEPS.length)}: ${candidate.title}`}
                    aria-current={at === index ? 'step' : undefined}
                    onClick={() => go(at)}
                  />
                </li>
              ))}
            </ol>
            <button type="button" className="ghost" onClick={close}>
              Skip
            </button>
          </div>
          <div key={index} className="welcome-step" data-direction={direction}>
            <h2 id="welcome-title">{step.title}</h2>
            {step.body}
            {index === LAST && (
              <div className="welcome-looks">
                <LookChoices settings={settings} />
              </div>
            )}
          </div>
          <div className="welcome-actions">
            <button
              type="button"
              className="ghost"
              disabled={index === 0}
              onClick={() => go(index - 1)}
            >
              Back
            </button>
            <button
              ref={primary}
              type="button"
              className="welcome-next"
              onClick={() => (index === LAST ? close() : go(index + 1))}
            >
              {index === LAST ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Tab and Shift+Tab go round the tour's own controls while it is open. */
function keepFocusInside(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  const focusable = container?.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])',
  );
  const first = focusable?.[0];
  const last = focusable?.[focusable.length - 1];
  if (first === undefined || last === undefined) {
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
