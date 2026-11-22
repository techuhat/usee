# Changelog

Notable changes to usee are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A Microsoft Store package of usee, built with each release; the Store signs it.

### Changed

- usee now runs on Electron 45.3.3, up from 44.9.3.

## [0.1.1] - 2026-11-20

### Added

- A privacy policy (PRIVACY.md), installed beside the app as PRIVACY.txt and summed up in Settings, under About.

### Fixed

- The welcome tour now plays its exit when it closes, and a tour closing a moment before can no longer close one opened straight after it from Settings.

## [0.1.0] - 2026-11-18

The first release: usee's first installer, built from the public source by GitHub Actions.

### Added

- Recording of a whole screen, one window or a drawn area, at 30 or 60 fps, with the microphone, after a three-second countdown.
- Automatic zoom on clicks and where the pointer rests, a camera that follows the pointer, and zooms of your own.
- 3D camera moves: a switch for the automatic camera, five presets, dragging to turn, and a lens setting.
- A smooth cursor with size, colour, click effects and a spotlight.
- Canvas styling: solid, gradient and blurred-recording backgrounds, padding, rounded corners, shadow, aspect ratios and motion blur.
- Annotations (words, arrows and boxes) and privacy blur.
- A timeline with split, trim, ripple delete, speed changes, undo and redo, and each clip's frames and waveform.
- MP4 export at 1080p30, 1080p60, 1440p30 and 4K30, with an FFmpeg runtime built from its official source.
- A welcome tour on the first start, a short intro as the window opens, and an icon drawn for every size Windows shows.
- A per-user Windows installer, not signed yet.

[Unreleased]: https://github.com/techuhat/usee/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/techuhat/usee/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/techuhat/usee/releases/tag/v0.1.0
