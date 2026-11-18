# ADR-011: Annotations

- Status: Accepted
- Date: 2026-11-17
- Owner: the project owner, who asked on 2026-11-17 to continue the phases; next in the build order (docs/roadmap.md, "Order"). Maintained with the editor's effects.

## Context

A screen recording often needs a word or a pointer added after the fact: a label on a button, an arrow at a field, a box around a result. Commercial screen-recording editors put text, shapes, lines and callouts on the timeline (docs/roadmap.md). usee's clips carry effects (zooms, blurs) that cover a span of their source and travel with it through splits, trims and ripple deletes; the preview and export draw every frame from one composition (`composeFrame`), so whatever it holds looks the same in both.

## Decision

### Model

An annotation is a clip effect, `kind: 'annotation'`, like a blur: it covers a span of the clip's source time, can be turned off, and moves with its content when the clip is edited. Its `shape` is one of:

- `text`: one line of at most 120 characters, centred at `at`, `size` high as a share of the frame's height (0.02-0.2), in `color`, on a rounded label behind it when `background` is on;
- `arrow`: a line from `from` to `to` with a head at `to`, `lineWidth` thick as a share of the frame's height (0.002-0.03), in `color`;
- `box`: a rounded rectangle outline at `bounds`, `lineWidth` thick, in `color`.

Positions are normalized to the recorded frame (0-1), so an annotation stays on what it points at when the camera zooms or turns, as blurs and the cursor do. Colours are `#rrggbb`. An annotation does not move during its span in this first version; it fades in and out over 200 ms (a quarter of a shorter span).

The manifest moves to version 11: the new effect kind is the only change, so the migration from 10 only changes the version and an older build refuses a project with annotations instead of failing on an unknown effect.

### Drawing

`composeFrame` lists the annotations showing at a moment with their opacity, and the compositor draws them over the picture, its blurs and the spotlight, and under click effects and the cursor, which stay on top. Text uses the app's own type (Segoe UI Variable Display, 600) at the composed scale, so it is as sharp as the output; nothing is drawn as HTML.

### Editing

The editor's Annotate tool (T) adds a text annotation at the playhead for three seconds, selected. The inspector switches it between text, arrow and box, and sets its words, colour, size and label; the preview shows handles to move the text, move and resize the box, and move either end of the arrow. Its span is changed on the timeline like any effect's.

## Privacy and security review

- The words are the user's own, typed into the project. They stay in the project file and in exports the user makes; nothing is sent anywhere.
- The text is drawn on a canvas with `fillText`, never inserted as HTML, so it cannot run or load anything. Its length and every number are bounded by the schema, and the font is fixed.
- No new input is captured: no keystrokes, no screen, no device.

## Benchmark and maintenance

An annotation costs a text draw or two strokes per frame, small beside decoding and composing the picture; no new budget. The editor's maintainer owns it with the other effects.

## Consequences

Annotations work in preview and export alike and survive editing with their clip. Animated annotations (moving with keyframes), more shapes (callouts, ellipses, highlights), and keystroke or typing overlays are left for later; keystroke overlays need input capture and their own privacy decision first.
