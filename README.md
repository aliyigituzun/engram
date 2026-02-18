# Engram

Engram is a browser extension for fast RSVP-style reading with selectable page content and a PDF reader mode.

## Quick Start

1. Pick browser manifest:
   - Firefox: `./scripts/change-manifest.sh firefox`
   - Chrome: `./scripts/change-manifest.sh chrome`
2. Load unpacked extension:
   - Firefox: `about:debugging` -> `This Firefox` -> `Load Temporary Add-on` -> select `manifest.json`
   - Chrome: `chrome://extensions` -> enable `Developer mode` -> `Load unpacked` -> select project folder

## How To Use

- Open a normal website.
- Trigger selection mode in one of two ways:
  - Shortcut (recommended): `MacCtrl+R` on macOS, `Alt+R` otherwise
  - Popup fallback: click `Activate Selection` at the bottom of the popup
- Click blocks to select text, then use Enter to start reading.

## Chrome Shortcut Note

Chrome may not apply extension shortcuts automatically.
If the shortcut does not work, set it manually:

1. Open `chrome://extensions/shortcuts`
2. Find `Engram - RSVP Reader`
3. Set `Enter Paragraph Selection Mode` to your preferred key combo

## PDF Reader

From the popup, click `Launch PDF Reader`, upload a PDF, then start reading from selected blocks.
