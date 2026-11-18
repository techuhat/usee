import { useCallback, useEffect, useState, type PointerEvent } from 'react';

import type { DesktopBridge } from '@usee/contracts';

/** The smallest side of an area the recorder accepts, in display pixels. */
const MIN_SIDE = 64;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function areaBetween(from: Point, to: Point): Area {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Display pixels as the recording will have them: whole and even. */
function displayPixels(cssPixels: number): number {
  return Math.floor((cssPixels * window.devicePixelRatio) / 2) * 2;
}

/**
 * The area picker (ADR-009). It fills its own transparent window over one
 * display: the screen shows through, and the user drags out the area to
 * record. Enter or "Record this area" answers with that rectangle alone, in
 * CSS pixels; main turns it into the display's pixels. Escape, a right click
 * or Cancel answers null.
 */
export function RegionPicker({
  bridge,
}: {
  readonly bridge: Pick<DesktopBridge, 'finishRegionChoice'>;
}) {
  /** Where the drag began, while the pointer is down. */
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const width = area === null ? 0 : displayPixels(area.width);
  const height = area === null ? 0 : displayPixels(area.height);
  const usable = area !== null && anchor === null && width >= MIN_SIDE && height >= MIN_SIDE;

  const finish = useCallback(
    (chosen: Area | null) => void bridge.finishRegionChoice({ area: chosen }),
    [bridge],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finish(null);
      } else if (event.key === 'Enter' && usable) {
        finish(area);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [area, finish, usable]);

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    setAnchor(point);
    setArea(areaBetween(point, point));
  };

  // Below the area when there is room, else above it, else inside its bottom edge.
  const actionsTop =
    area === null
      ? 0
      : area.y + area.height + 64 <= window.innerHeight
        ? area.y + area.height + 12
        : area.y >= 64
          ? area.y - 56
          : area.y + area.height - 56;
  const actionsLeft = area === null ? 0 : Math.max(12, Math.min(area.x, window.innerWidth - 360));

  return (
    <div
      className={area === null ? 'region-picker' : 'region-picker drawn'}
      data-testid="region-picker"
      onPointerDown={begin}
      onPointerMove={(event) => {
        if (anchor !== null) {
          setArea(areaBetween(anchor, { x: event.clientX, y: event.clientY }));
        }
      }}
      onPointerUp={() => setAnchor(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        finish(null);
      }}
    >
      {area === null ? (
        <p className="region-hint">Drag over the part of the screen to record. Escape cancels.</p>
      ) : (
        <div
          className="region-area"
          style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
        >
          <span className="region-size">
            {width} × {height}
          </span>
        </div>
      )}
      {area !== null && anchor === null && (
        <div
          className="region-actions"
          style={{ left: actionsLeft, top: actionsTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {!usable && <span className="region-note">At least 64 × 64 pixels</span>}
          <button type="button" onClick={() => finish(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="region-use"
            disabled={!usable}
            onClick={() => finish(area)}
          >
            Record this area
          </button>
        </div>
      )}
    </div>
  );
}
