# Microsoft Store listing

What usee's Store submission says, field by field, for the product "Usee 3D Motion - Screen Recoder" in Partner Center, live since 2026-11-23 at [apps.microsoft.com/detail/9n7gb8ld2g62](https://apps.microsoft.com/detail/9n7gb8ld2g62). The package is described in [release.md](release.md), "Microsoft Store". When the listing changes, change this file with it.

## Pricing and availability

- Markets: all markets.
- Visibility: public.
- Pricing: free, with no in-app purchases. Selling usee would first need the review with a lawyer that [ADR-012](decisions/ADR-012-ffmpeg-release.md) asks for.

## Properties

- Category: Photo & video; secondary category: Productivity.
- Does it access, collect or transmit personal information: yes. Recordings of the screen and the microphone can hold it, even though usee keeps them on the computer and sends nothing. Privacy policy: https://techuhat.github.io/usee/privacy.html
- Website: https://techuhat.github.io/usee/
- Support contact: https://github.com/techuhat/usee/issues. No phone number or address.
- Display mode: none; usee is not a Mixed Reality app.
- Product declarations: no purchases outside the Store, and no claim of accessibility testing, which has not been done. Windows backing up the app's data to OneDrive is turned off, so its settings and logs stay on the computer, as PRIVACY.md says. Installing to other drives stays allowed.
- System requirements, minimum: 4 GB of memory, DirectX 11, an x64 processor. Recommended: 8 GB of memory, a microphone for narration, and a graphics card with a hardware H.264 encoder, which makes exports faster. usee's own peak while exporting was 0.9 GB at 1080p and 1.4 GB at 4K (docs/development-phases.md, the soak gate).

## Age ratings

The IARC questionnaire, app type "All Other App Types", with every question answered No: no ratings-relevant content in the package; people cannot talk to each other or share content through usee, as export only saves a file on the computer, so the questions about shared content do not apply; no online content beyond the download; nothing age-restricted promoted or sold; no location sharing, digital purchases, cash rewards or NFTs; not a web browser, search engine, news or educational product; no rating from a ratings board and no physical media. That gives the lowest rating.

## Packages

Upload `usee-<version>-store.appx` from the Release run for the version's tag: on GitHub, Actions, Release, that run, Artifacts, `store-package`. Each submission needs a higher version than the last.

## Store listing (English, United States)

### Description

```text
usee is a free, open-source screen recorder and editor for Windows. Record a screen, a window or an area, and usee turns it into a video that looks edited: the camera zooms in where you click, follows the pointer, and can turn in 3D toward each action.

Everything stays on your computer. usee has no account and no telemetry, and it never uploads your recordings.

Record
• A whole screen, one window or an area you draw, at 30 or 60 fps
• Your microphone, when you pick one for that recording
• A three-second countdown first, and Ctrl+Shift+F10 to stop

Edit
• Automatic zoom on clicks and where the pointer rests, and zooms of your own
• 3D camera moves: presets, drag to turn, and a lens setting
• A smooth cursor with its own size, colour, click effects and a spotlight
• Backgrounds (solid, gradient or a blur of the recording), padding, rounded corners, shadow and aspect ratios
• Words, arrows and boxes, and blur for anything private
• A timeline with split, trim, speed changes, undo and redo

Export
• MP4 at 1080p30, 1080p60, 1440p30 or 4K30

usee is free software under the MIT License. Its source code, issues and roadmap are at github.com/techuhat/usee.
```

### What's new in this version

Blank on the first submission, as Partner Center asks. From the next one on, the changes in that version's CHANGELOG section, in plain words.

### Short description

Shown at the top of the listing; 270 characters or fewer.

```text
A free, open-source screen recorder for Windows. It zooms in where you click, follows the pointer and can turn the picture in 3D, then exports an MP4, with everything kept on your computer.
```

### Product features

1. Records a screen, a window or an area, at 30 or 60 fps
2. Zooms in where you click and follows the pointer
3. 3D camera moves with presets, drag to turn and a lens setting
4. A smooth cursor with click effects and a spotlight
5. Backgrounds, padding, rounded corners and shadow
6. Words, arrows and boxes, and blur for anything private
7. A timeline with split, trim, speed, undo and redo
8. MP4 export up to 4K
9. No account and no telemetry: recordings stay on your computer
10. Free and open source, under the MIT License

### Screenshots

In this order, from `docs/store/screenshots/` (1440 × 900). They show usee's built-in test pattern, recorded through its synthetic source, not anyone's screen.

| File              | Caption                                                    |
| ----------------- | ---------------------------------------------------------- |
| `1-3d-camera.png` | The camera turns in 3D toward each click                   |
| `2-canvas.png`    | A gradient background, padding, rounded corners and shadow |
| `3-export.png`    | Export an MP4 at up to 4K                                  |
| `4-welcome.png`   | A short tour on the first start                            |

### Store logos

`scripts/build-icon.mjs` draws them with the app's icon, into `docs/store/`:

| Field                                         | File                       | Size        |
| --------------------------------------------- | -------------------------- | ----------- |
| 9:16 Poster art, the main logo                | `poster-art-1440x2160.png` | 1440 × 2160 |
| 1:1 Box art                                   | `box-art-2160.png`         | 2160 × 2160 |
| 1:1 App tile icon, under Store display images | `app-tile-300.png`         | 300 × 300   |

The Xbox images do not apply.

### Trailer

Under Trailers and additional assets. The trailer plays at the top of the listing only when there is a 16:9 Super hero art, and that image may carry no text.

| Field               | Value                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| Trailer title       | usee: screen recordings that look edited                                      |
| Trailer             | `usee-trailer.mp4`: 46 seconds, 1920 × 1080, H.264 High at 30 fps, no sound   |
| Thumbnail           | `trailer-thumbnail.png`, 1920 × 1080: the icon and the name beside the editor |
| 16:9 Super hero art | `docs/store/super-hero-art-3840x2160.png`: the icon alone, with no words      |

usee recorded the trailer itself: its own website, used on a real screen, then the editor's features one after another, each named by a caption. The captions sit centred and clear of the bottom edge, because some Store layouts crop the top and bottom. The trailer shows no age rating, which the Store does not allow in trailers. The video and its thumbnail are kept outside the repository.

### Keywords

Up to 7, at most 21 words in all: screen recorder · screen recording · video editor · screen capture · zoom · tutorial · open source

### Copyright and trademark info

© 2026 Mohammad Umar Wajid Khan

### Additional license terms

usee is free software under the MIT License: https://github.com/techuhat/usee/blob/main/LICENSE

### Developed by

techuhat

## Submission options

### Why usee needs runFullTrust

```text
usee is a desktop app built with Electron and packaged from its Win32 build. It runs as a full-trust desktop process because it starts its own recorder process, which captures the screen with Windows.Graphics.Capture, reads the microphone through WASAPI and encodes with Media Foundation, and because it saves recordings in the user's Videos folder.
```

### Notes for certification

```text
No account is needed, and usee makes no network connections. To try it: on Home, keep Screen selected and choose Start recording. After a three-second countdown usee records and moves out of the way; stop it from the red dot in the notification area (Stop recording) or with Ctrl+Shift+F10. The editor opens on the recording; Export, at the top right, saves an MP4.
```
