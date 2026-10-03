# Desktop host

The unchanged web contract is exposed on every platform. Only a published Windows
single-file executable enables the tray, Windows startup and self-update.
Development/dotnet-hosted builds report those capabilities as unavailable.

| Method | Route | Behaviour |
|---|---|---|
| GET | `/api/desktop` | Desktop capabilities, startup registration, update status and progress; explicit null fields |
| PUT | `/api/desktop/settings` | Boolean `startWithWindows` / `checkForUpdates`; local owner only |
| POST | `/api/desktop/update/check` | Trusted GitHub latest release check; keep the last result while offline |
| POST | `/api/desktop/update/install` | Verified-size and SHA-256 installer; asynchronous 202, then graceful shutdown |
| GET | `/api/settings/browse-folders` | Drives or sorted child directories, including hidden folders; explicit parent |
| POST | `/api/settings/open-folder` | Configured root/category or a download/title path; `reveal:false` verifies without launching |
| POST | `/api/downloads/{transferId}/open` | Largest selected, filed video; `mode:open` or `mode:reveal` |

`Domain.DesktopSettings` is the typed `Setting.desktop` section. Preferences,
release metadata, check time and check errors are committed with revision checks.
There is no `desktop.json` side file. Registry status remains the actual Windows
startup registration, including the existing `pointsElsewhere` warning.

The installed executable reuses an existing instance for the same data directory
and URL. `--background` and `--no-browser` are stripped before host configuration
and both suppress browser launch. Startup uses `--background`. The tray offers
Open, Pause all, Resume all and Quit; quit uses host shutdown, and losing the tray
does not stop the server. Windows single-file publication uses the GUI subsystem.

All filesystem inspection and file-manager launching lives in Library's
`ILocalFiles` adapter, reusing `LibraryPaths`. Paths must be inside enrolled roots,
with no linked ancestry. Missing files, other clients, unfinished downloads and
invalid modes retain the old errors. Containers and remote access cannot launch
host files. `PLAYWRIGHT_NO_REVEAL=1` disables both folder and file launching for
HTTP verification without leaving Explorer/player windows.

## Verification

OPS-767 evidence is in ignored `tools\.desktop-proof\`: build/publish logs,
48 real HTTP cases, two container refusal cases, database preference restart proof, and published Windows
checks. The published proof exercised startup on/off and restored the original
registry value (absent), manual GitHub checking, disabled-install refusal, and a
second background launch exiting successfully without a second server/browser.
The native tray owner window was confirmed against that executable's literal PID.
Only port 3946 and `D:\code\memtest\rebuild-desktop` were used.

GitHub currently returns 404 for its latest release. Installer replacement and
the ensuing relaunch therefore remain unverified; no installer was launched.
Raw-only tray pause/resume requires an authoritative Targets action surface
and is tracked as **OPS-769**. Catalog tray actions use the existing TargetPipeline
instead of copying or mutating Engine state in the shell.
