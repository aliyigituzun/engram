# Engram

A browser extension for RSVP reading — words are flashed one at a time in a fixed
position, so your eyes stop moving and you read at the speed you set instead of the
speed your saccades allow.

Engram works on any web page and on local PDFs. You pick which blocks to read
rather than handing the whole page over to a parser, so sidebars, cookie banners and
comment threads never end up in the stream.

Firefox and Chrome, Manifest V3, no build step, no telemetry, no network calls.

---

## Install

Engram is not on the extension stores yet — load it unpacked.

```bash
./scripts/change-manifest.sh firefox   # or: chrome
```

**Firefox** — `about:debugging` → *This Firefox* → *Load Temporary Add-on* → pick `manifest.json`

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick the project folder

Chrome does not always apply the bundled shortcut. If `Alt+R` does nothing, open
`chrome://extensions/shortcuts`, find *Engram – RSVP Reader*, and bind
*Enter Paragraph Selection Mode* yourself.

## Reading a page

Enter selection mode with `MacCtrl+R` (macOS) or `Alt+R`, or click **Activate
Selection** in the popup.

| Selection mode | |
|---|---|
| Click | toggle a block |
| Hold `Shift` + hover | sweep several blocks at once |
| `Enter` | start reading |
| `Esc` | cancel |

| Reading | |
|---|---|
| `Space` | play / pause |
| `Enter` | acknowledge a checkpoint and continue |
| `Esc` | exit |
| Slider | change speed live, 100–1200 WPM |
| Rewind 10 | jump back ten words |

Each word is rendered with its optimal recognition point highlighted, so the pivot
letter stays put and your eyes never track sideways.

## Checkpoints

Prose is not uniform, and RSVP falls apart on the parts that aren't prose. Engram
stops and waits for `Enter` rather than flashing through them:

- **Stop before header** — so a new section doesn't start mid-flow
- **Pause on media, lists, tables and code** — these get shown to you as blocks
  instead, images included, since flashing a table one cell at a time is useless

Both are on by default and toggleable from the popup, along with **Auto-Continue**
for when you'd rather not be interrupted at all.

## PDFs

Click **Launch PDF Reader** in the popup, drop in a PDF, and select blocks the same
way. Rendering uses a vendored copy of pdf.js, so the file is parsed locally and
never uploaded anywhere.

## Settings

Default WPM, Auto-Continue, and both checkpoint rules live in the popup and persist
through `storage`.

## Layout

```
content.js           selection mode, the RSVP reader, checkpoint rules
background.js        command routing and content-script injection
popup.html/.js       settings and entry points
pdf-reader.html/.js  standalone PDF reading mode
vendor/pdfjs         vendored pdf.js
scripts/             change-manifest.sh — swaps the browser manifest into place
test-fixtures/       pages that exercise specific checkpoint rules
```

## Permissions

`activeTab`, `storage` and `scripting`, plus host access so the content script can
run on the page you're reading. Nothing is collected and nothing is sent anywhere.

## License

MIT — see [LICENSE](LICENSE).
