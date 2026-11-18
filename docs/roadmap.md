# Roadmap

usee is a free, open-source screen recorder and editor for Windows, so developers can record demos, tutorials and bug reports that look finished without paying for a tool. This page lists what a complete screen-recording editor offers, where usee stands on each feature, and the order of the remaining work.

## Where the list comes from

The features follow the public product pages and user guides of commercial screen-recording editors, chiefly FocuSee's user guide (focusee.ai/guide, read 2026-11-18). usee builds each feature independently, with its own design and code, and copies no other product's code, assets, names or look (docs/architecture.md).

Status: **Done**; **Partial**; **Next**, buildable without an open decision; **Later**, the same at a lower priority; **Decision first**, which needs an ADR with a privacy, licence or dependency review before it is built; **Not planned**.

## Recording

| Feature                                                         | Status         | Notes                                                      |
| --------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| Full screen                                                     | Done           | Phase 1                                                    |
| One window                                                      | Done           | ADR-009                                                    |
| An area drawn on the screen                                     | Done           | ADR-009                                                    |
| Microphone                                                      | Done           | Never remembered between recordings                        |
| System audio                                                    | Next           | Loopback capture, chosen per recording like the microphone |
| Three-second countdown                                          | Done           |                                                            |
| The app hides while recording; stop from the tray or a shortcut | Done           |                                                            |
| Start a recording from the tray                                 | Later          |                                                            |
| Teleprompter                                                    | Later          |                                                            |
| Webcam                                                          | Decision first | Camera access, layouts                                     |
| A phone or tablet over USB                                      | Decision first |                                                            |

## Camera and zoom

| Feature                                                          | Status         | Notes            |
| ---------------------------------------------------------------- | -------------- | ---------------- |
| Automatic zoom on clicks and where the pointer rests             | Done           | Phases 4 and 6   |
| Automatic zoom where the picture changes                         | Done           | Opt-in           |
| Manual zooms with depth, position and timing                     | Done           |                  |
| The camera follows the pointer inside a zoom                     | Done           | ADR-010          |
| 3D motion: one click, intensity, presets, turn by dragging, lens | Done           | Phase 6          |
| Apply one zoom's settings to every zoom                          | Next           |                  |
| Automatic zoom on typing                                         | Decision first | Reads keystrokes |

## Cursor

| Feature                                    | Status | Notes                  |
| ------------------------------------------ | ------ | ---------------------- |
| Show or hide, size, colour                 | Done   |                        |
| Smoothing that stays on the real pointer   | Done   | ADR-010                |
| Click effects: ripple, pulse, ring, bounce | Done   |                        |
| Spotlight around the pointer               | Done   |                        |
| Cursor styles                              | Next   | Artwork drawn for usee |
| Hide the cursor while it is idle           | Next   |                        |
| Click sounds                               | Next   | Sounds made for usee   |
| A cursor that turns with its movement      | Later  |                        |

## Canvas

| Feature                                          | Status         | Notes                                              |
| ------------------------------------------------ | -------------- | -------------------------------------------------- |
| Aspect ratios, padding, rounded corners, shadow  | Done           | Phase 5                                            |
| Solid and gradient backgrounds                   | Done           |                                                    |
| The recording itself, blurred, as the background | Done           |                                                    |
| Motion blur                                      | Done           |                                                    |
| An image background                              | Partial        | In the project format, not yet in the Canvas panel |
| Blur for an image background                     | Next           |                                                    |
| Crop and inset                                   | Next           |                                                    |
| Device frames                                    | Decision first | Needs artwork made for usee                        |

## Annotations

| Feature                                   | Status         | Notes                          |
| ----------------------------------------- | -------------- | ------------------------------ |
| Words, an arrow, a box                    | Done           | ADR-011                        |
| Privacy blur: rectangle, ellipse, polygon | Partial        | A polygon cannot be edited yet |
| Lines, ellipses and other shapes          | Next           |                                |
| Opacity and rotation                      | Next           |                                |
| Callout, magnifier, spotlight on an area  | Next           |                                |
| Annotations that move over time           | Next           |                                |
| Watermark                                 | Next           |                                |
| Keyboard shortcut display                 | Decision first | Reads keystrokes               |

## Webcam

| Feature                                                  | Status         | Notes                     |
| -------------------------------------------------------- | -------------- | ------------------------- |
| Webcam over the recording, with shape, size and position | Decision first | Comes with webcam capture |
| Layouts that change along the timeline                   | Decision first |                           |
| Background removal or blur behind the speaker            | Decision first | Needs a local model       |

## Audio and captions

| Feature                                           | Status         | Notes                                                  |
| ------------------------------------------------- | -------------- | ------------------------------------------------------ |
| The recording's audio on the timeline, with speed | Done           |                                                        |
| Volume, mute and fades per clip                   | Next           |                                                        |
| Background music                                  | Next           | A file the user picks                                  |
| Noise reduction                                   | Decision first | A new library                                          |
| Captions, with an editor                          | Decision first | Speech recognition on the computer; no audio leaves it |
| Removing silences and filler words                | Decision first | The same speech recognition                            |

## Timeline

| Feature                                          | Status         | Notes            |
| ------------------------------------------------ | -------------- | ---------------- |
| Split, trim, ripple delete, speed, undo and redo | Done           |                  |
| Pictures and the waveform along each clip        | Done           |                  |
| Import an existing video                         | Next           |                  |
| Speed up typing                                  | Decision first | Reads keystrokes |

## Export

| Feature                                   | Status         | Notes                                      |
| ----------------------------------------- | -------------- | ------------------------------------------ |
| MP4 at 1080p30, 1080p60, 1440p30 and 4K30 | Done           | Phase 7                                    |
| More sizes and frame rates                | Next           |                                            |
| GIF                                       | Next           | Needs an FFmpeg build with the GIF encoder |
| Copy the exported file or open its folder | Next           |                                            |
| Upload and share links                    | Decision first | Recordings stay on the computer until then |

## Presets and platforms

| Feature                                                  | Status         | Notes        |
| -------------------------------------------------------- | -------------- | ------------ |
| The look new recordings start with                       | Done           |              |
| Named presets: save, rename, make default, apply, delete | Next           |              |
| macOS                                                    | Decision first |              |
| Paid tiers, credits or accounts                          | Not planned    | usee is free |

## Order

1. Finish Phase 7: build the release FFmpeg runtime (ADR-008, ADR-012) and publish releases (docs/release.md).
2. Then, in this order: system audio; the image background in the Canvas panel, with blur; annotations (shapes, opacity, rotation, callout, magnifier, spotlight, movement, polygon editing); cursor styles, idle hiding and click sounds; per-clip volume and background music; more export sizes and frame rates, and GIF; named presets; crop and inset; importing a video; watermark.
3. Each "Decision first" feature gets its own ADR, with a privacy or licence review and a benchmark and maintenance owner, before it is built: webcam and layouts; features that read keystrokes; captions and silence removal; noise reduction; device frames; phones; sharing; macOS.
