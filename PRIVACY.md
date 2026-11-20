# Privacy policy

Effective 20 November 2026. This policy covers the usee app and its installer. It is short because usee collects nothing about you.

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## What usee sends

Nothing. usee makes no network connections of its own: it has no account or sign-in, no telemetry or analytics, no crash reports, no ads and no automatic update checks. Your recordings are never uploaded anywhere.

## What stays on your computer

| What                        | Where                  | What it holds                                                                                                                                      |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recordings                  | `Videos\usee`          | One folder per recording: its video and sound, where the pointer moved and clicked, and your edits                                                 |
| Recordings still being made | `%LOCALAPPDATA%\usee`  | Temporary files, until a recording becomes a project in `Videos\usee`                                                                              |
| Settings                    | `%APPDATA%\usee`       | Your preferences, such as the frame rate, the looks new recordings start with and the export quality. No microphone and no folder are kept there   |
| Logs                        | `%APPDATA%\usee\logs`  | Technical events, to find what went wrong. They hold no pictures, sound, window titles or keystrokes, and show your user folder as `%USERPROFILE%` |
| Exported videos             | Wherever you save them | The finished MP4 files                                                                                                                             |

## What usee records, and when

- **Your screen** only after you start a recording and its countdown ends, and only the screen, window or area you chose. It stops when you stop it.
- **Your microphone** only when you pick one for that recording. The choice is never remembered, so each recording starts without one.
- **The pointer** (where it moves, its clicks and its shape) only while "Record it for cursor effects" is on, to draw the cursor in the editor. usee never reads what you type.
- **Window titles** appear in the window picker alone; they are never saved.

## Removing your data

Delete the folders in the table above. Uninstalling usee (Windows Settings, Apps, Installed apps) removes the app but keeps your recordings, settings and logs until you delete them yourself.

## Downloads and the website

usee is downloaded from GitHub, and its website is hosted on GitHub Pages, so visiting either is covered by [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The website loads nothing from other sites and sets no cookies.

## Code signing

Once usee is signed through the SignPath Foundation ([code signing policy](README.md#-code-signing-policy)), signing happens on SignPath's servers from GitHub's build. It involves no information about you.

## Changes and questions

Changes to this policy are made in the open, in this file's history on GitHub. Questions are welcome as an [issue](https://github.com/techuhat/usee/issues).
