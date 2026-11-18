# Security policy

usee records screens and microphones, so a security bug in it can expose what people record. Thank you for reporting one privately.

## Supported versions

usee has no release yet, so fixes land on `main`. Once releases begin, security fixes go into the latest release.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion about a vulnerability.

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Please include:

- what an attacker could do, and what they need first (for example, a crafted project file);
- the steps, or a proof of concept, that reproduce it;
- the usee version or commit, and your Windows version.

We aim to reply within a week. Once the problem is confirmed, we fix it, publish the fix and credit you in the release notes, unless you would rather not be named. Please keep the details private until the fix is out.

## Scope

- The desktop app: its renderer, the preload bridge and the Electron main process
- The recorder host and its named-pipe protocol
- Project files (`.screenproj`) and anything usee reads from them
- The installer, and the check that lets the app run only its verified FFmpeg runtime

A vulnerability in Electron, Chromium or FFmpeg belongs to that project. If it affects usee, tell us too, so we can update.

How usee is meant to stay safe, boundary by boundary, is in [docs/security.md](docs/security.md).
