# ADR-010: Picture and pointer on one clock, and a camera that follows the pointer

- Status: Accepted
- Date: 2026-11-17
- Owner: the project owner, who asked on 2026-11-17 for cursor tracking without delay and for the camera, in 2D and 3D, to move right; maintained with the recorder host and the domain's camera.

## Context

The editor draws the recorded pointer over the recorded picture and plans the camera from the pointer. Both are stamped on the session clock, but they are not stamped at the same point in their paths.

- The pointer is polled at 120 Hz and stamped when it is read.
- A video frame is stamped with its tick on the frame grid, but the picture in it belongs to the moment Windows gives it, `SystemRelativeTime`, when it is shown: the encoder takes the newest picture at each tick, so the picture's moment is a capture latency before the frame's time, or after it. With the pointer read at the frame's time, the drawn cursor, the click effects and the camera are off the picture by that latency.

Measured on the owner's machine on 2026-11-17 (one 3840 x 2160 display at 60 Hz), with their go-ahead to record the real screen: within a session the latency is the same to a millisecond (its 10th and 90th percentiles meet), because the encoder's ticks fall at one phase of the display's refresh; across sessions it was +3.5 to +7.5 ms for a display and -6.5 to -9.5 ms for a window, whose pictures can be given a time after the tick that encodes them (up to 26 ms). So the error was under a frame at 60 fps, but it changes with every session.

The same day's measurement ruled out the files themselves. Merged recordings put every sample at its session time: the first video sample of a merged recording is at the session time of its first frame (16.7 ms when the first tick found no frame yet), audio starts at 0, and the project's media time is that same clock (`sessionStartUs` 0). Segment files start at their own segment's time.

Separately, the generated camera held still between the places it planned to look at (clicks, pointer rests, picture changes). A pointer that moved away between them could leave the zoomed picture.

## Decision

### The capture latency is measured and the pointer is read at the picture's moment

- The host keeps, with the newest captured frame, the time Windows gives it (`SystemRelativeTime`, on the same QPC clock as the pointer) and whether it is new since the frame before.
- For each new picture it encodes, the host takes the frame time minus that time, negative for a picture shown after its frame time, and keeps a histogram of whole milliseconds from -250 to +750 ms. At the end of the session it writes the median as `captureLatencyUs` in the journal's `session-finalized` record (recorder protocol 1.3), and logs its spread (`session.capture-latency`: samples, how many were newer, the youngest, the 10th and 90th percentiles; numbers only). A median beyond 250 ms either way is not a screen's latency but two clocks that disagree or an encoder far behind: the host logs it (`session.capture-latency.implausible`) and leaves the value out, so the pointer is read as recorded. A median over new pictures is used rather than a value per frame: within a session the spread is a millisecond, and a still screen gives no new pictures to misjudge.
- The importer keeps it on each video asset (`captureLatencyUs`, manifest v10). A project made before, or from an interrupted session, has none and is read as before.
- The editor and export read the pointer, its clicks, the generated camera and picture-change focus at `sessionStartUs - captureLatencyUs + media time` (`pointerTimeOrigin`), earlier for a positive latency and later for a negative one, so the cursor and the camera meet the picture they are drawn over. The raw pointer stream and the video are left as recorded.

### The drawn cursor stays near the real one

- Smoothing averages the pointer over the moments around, as far ahead as behind, which takes out a hand's tremor but, on a fast move, starts the drawn cursor early and lands it late: it trailed into every stop. The smoothed cursor is now pulled back to within 4 + 12 x smoothing logical pixels of where the pointer really was (10 at the default 0.5, 16 at the most), so a move is drawn as it was made, while tremor, which is smaller, is still smoothed. It still lands exactly on each click.

### The generated camera follows the pointer

- At each frame, the generated camera's planned view is moved just enough to keep the pointer, averaged over the moments around with Gaussian weights (250 ms standard deviation, as far ahead as behind), within 0.6 of the view's half-size from its centre (`followPointer`). A steady move is followed without trailing it, a jump is crossed in a glide, and the view stays inside the frame.
- A view turned in 3D turns toward where it now looks as the planner turns it toward each action (`turnShift`, the linear part of `turnToward`).
- It applies to the generated camera only; a zoom the user placed holds where it was put and still overrides the generated one. Preview and export both compose frames with it, so they match.
- Analysis runs keep only their planned poses, so no strategy version changes and existing projects follow the pointer without re-planning.

## Consequences

The drawn cursor, click effects and camera now meet the picture to within a millisecond on a real screen, where they were off by up to 10 ms either way depending on the session; with the synthetic test source the latency is about a millisecond. The drawn cursor no longer trails a fast move by up to a fifth of a second, which is most of what read as delay; the smoothest setting no longer glides far from the real path. A camera that follows moves more than one that holds, which shows most at high zoom. The latency is a session's median, so a session whose capture latency changes part way through, such as one whose display changes refresh rate, is aligned to its typical value.

Tests check the signed median, its percentiles and freshness in the native frame store and meter, that the host journals a latency for the synthetic source, that it reaches the manifest and the snapshot and the render plan, and that the pointer, the generated zooms and picture-change focus move by it; that the followed camera holds, moves just enough, never trails a steady move, glides over a jump, stays in the frame, turns in 3D, and leaves the user's zooms alone; and that the drawn cursor never strays past its bound from a random flicking pointer, yet still smooths tremor.
