# State-management architecture

There is no application-wide mutable renderer store. State is split by authority and lifetime.

| State class                               | Authority                                     | Renderer representation                         |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| Project/timeline/history                  | Main-process project session                  | Immutable snapshots and subscriptions           |
| Recording/export jobs                     | Main-process services + native host execution | Read-only lifecycle projections                 |
| Settings                                  | Settings service                              | Validated snapshot and explicit update commands |
| Playback position/viewport                | Renderer scoped playback store                | Ephemeral, throttled view state                 |
| Selection, panels, drag previews, dialogs | Component/local renderer store                | Ephemeral; not persisted as project truth       |

Future renderer state uses small Zustand stores selected by slice (shell, recording, editor interaction, playback, settings). React Query or a similar query cache is not introduced for local project truth; event subscriptions and commands are the appropriate desktop model. A high-frequency drag alters local view state, then emits one semantic command on completion. Undo/redo remains in the main-process project command history.

Persistent user preferences and project settings have distinct schema/migration paths. Neither is an untyped key-value dumping ground.

## Settings

The settings manager (`apps/desktop/src/main/settings.ts`) owns the user's preferences: what a recording starts with (frame rate, whether the pointer is recorded or shown, whether the window minimizes while it runs, `hideWhileRecording`, and whether three seconds are counted down first, `countdown`, each absent meaning it does), what a new recording's project starts with (auto zoom and its depth, the generated camera's 3D turn, the canvas), the export quality last chosen and, optionally, whether the automatic camera also follows changes on screen (`analysis.pictureFocus`, absent in files from before it, meaning off). It keeps them as one `appSettingsSchema` snapshot, version 1, in `settings.json` in the OS app-data folder. A missing file is a first start and gives the defaults, which keep the app as it behaved before it had settings; a file that is not JSON, fails the schema or has another version also gives the defaults, with a warning in the log, and is replaced on the next change. Changes run one at a time, each merged onto the one before, validated whole and written atomically. A later `settingsVersion` comes with a migration from this one.

The renderer's settings store (`apps/desktop/src/renderer/settings/settings-store.ts`) shows a change at once and then keeps main's answer; after a failure it reads the saved settings back and shows why. The recording panel starts from the remembered recording choices and remembers the ones made there. When a recording is imported, its project copies the new-recording looks into its own settings (`projectLooks` of the recording store), so changing the settings later never changes a project that exists.

The shell's page (Home, Recordings, Settings) is local view state. While a project is open the editor takes the whole window; closing it returns to the page that opened it, which its back button names.

## Project session

`ProjectSession` (`packages/application/src/project-session.ts`) is the main-process project session. It holds the open project, changes it only through `ProjectCommand`s (`packages/domain/src/project-edit.ts`: the timeline edits below, adding, updating and removing clip effects, the cursor settings, the canvas style (`set-canvas`), a clip's speed (`set-clip-speed`, which ripples like a trim), and the manual overrides of the generated camera: `set-auto-zoom`, `set-generated-zoom`, `take-over-generated-zoom`), and keeps up to 100 undo steps as whole immutable snapshots; a command that changes nothing adds no step. Generated analysis is not an edit: `applyAnalysis` puts new runs into the project and into every snapshot of its history, so undo never brings an old run back. Every change is saved in the background through the project repository, one save at a time; changes made during a save, or as one finishes, are saved together after it. The snapshot's `saveState` (`saved`, `saving`, `failed`) tells the editor where that stands, and closing or quitting waits for the last save.

Timeline commands edit one clip and ripple: the clips after it on its track move with it, so a track never gains gaps or overlaps, and other tracks are untouched.

- `split` cuts a clip at a timeline time at least one frame from either end.
- `delete` removes a clip and closes the gap.
- `trim` moves one edge by a signed amount. The clip keeps its position: shortening drops media, lengthening reveals source media up to its ends. The amount is relative, so the first clip's hidden start can be pulled back too.
