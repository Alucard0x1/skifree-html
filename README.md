# SkiFree — HTML5 port

A browser rebuild of **SkiFree** (Chris Pirih, 1991), the Windows 3.1 game where the
mountain always wins. Three course modes, eight-direction skiing, slalom gates,
rainbow jump pads, runaway dogs — and the yeti released the moment the course is
behind you.

**Live:** _set after first deploy_

No build step, no dependencies, no framework. `index.html` + `game.js` + `style.css`.

---

## Play

| Action | Keyboard | Touch |
| --- | --- | --- |
| Steer | Arrow keys / WASD / numpad 1–9 | drag anywhere, or the on-screen pad |
| Hop over rocks | Space | tap the snow |
| Pause | P or F3 | pause button (top right) |
| Restart | R | — |

**Slalom** — 540 m against the clock, gates to clear.
**Tree Slalom** — the same 1040 m course with roughly 2.5× the trees.
**Freestyle** — untimed 1040 m, hunt the rainbow pads for airtime and style points.

Distance, speed, elapsed time and style are tracked in the HUD. Cross the finish
line and you keep skiing — that is when the yeti shows up. It is always a little
faster than you. It only takes one mistake, or one long straight run.

## What was reconstructed, and how

The gameplay constants and layout were derived by inspecting the shipped
executables with **REA** (the reverse-engineering MCP server), not from memory or
from a walkthrough.

Artifacts analysed:

| Build | Size | SHA-256 |
| --- | --- | --- |
| `SKI.EXE` v1.0 (Win16, NE) | 88,848 B | `0b97b99fcf34af5f5d624080417c79c7d36ae11351a7870ce6e0a476f03515c2` |
| `ski32.exe` v1.04 (Win32, PE32) | 118,784 B | `3572d3757638bc1ae388c3d007ba59ba1f370911901e2a35d2f1297e8cf0ff35` |

Findings that shaped this port:

- **PE imports (96 across 4 DLLs)** — `GDI32`: `BitBlt`, `CreateCompatibleBitmap`,
  `CreateCompatibleDC`, `PatBlt`, `TextOutA`, `GetObjectA`; `USER32`: `SetTimer`,
  `KillTimer`, `LoadBitmapA`, `InvalidateRect`, `BeginPaint`/`EndPaint`;
  `WINMM`: `sndPlaySoundA`; `KERNEL32`: `FindResourceA`/`LoadResource`.
  So: a timer-driven loop blitting bitmap sprites out of the executable's own
  resources, with WAV sound. This port keeps the same shape — a
  `requestAnimationFrame` loop drawing sprite functions, WebAudio for sound.
- **Resources: 99 entries** — 89 `RT_BITMAP`, 6 `RT_ICON`, 2 `RT_STRING`
  tables, 2 icon groups. The bitmaps are 16 × 32 and 24 × 28 skier frames,
  28–32 px trees, 32 × 48 yeti frames, 12 × 24 slalom flags, a 32 × 8 rainbow
  pad, and the menu art (`Start`, `Finish`, `Slalom`, `Tree Slalom`,
  `Freestyle`, the *SkiFree* logo).
- **RT_STRING tables** gave the HUD wording verbatim: `Time:`, `Dist:`,
  `Speed:`, `Style:`, `High Scores`, `Ski Paused ... Press F3 to continue`,
  ` <-- that's you!`, ` <-- try again!`, plus the printf formats
  `%5.2dm`, `%5.2dm/s`, `%7ld`. The HUD here uses those same four fields.
- **Course lengths** 540 m / 1040 m and the three mode names come from the same
  string and bitmap resources.

Resource metadata and the extraction scripts live in
[`reverse-engineering/`](reverse-engineering/): `resources.json` records every
resource entry with its offset, size and digest; `strings.json` holds the decoded
string table; the Python scripts parse the NE and PE resource directories.

### What is *not* copied

The original bitmaps are **not redistributed** in this repository and are not used
by the game. Every sprite here — skier, trees, rocks, stumps, dogs, flags, rainbow
pad, yeti, finish banner — is drawn from scratch with the Canvas 2D API at the same
sizes and in the same top-down style. Only factual metadata (sizes, digests,
resource inventory, HUD strings) is reproduced.

SkiFree itself is © Chris Pirih, released by the author as freeware. This is an
unofficial fan reimplementation; it ships none of the original code or art.

## Run it

```bash
python3 -m http.server 8123
# then open http://127.0.0.1:8123/
```

Any static host works. It is also plain-HTTP friendly: no service worker, no
module imports, no CORS requirements.

## Layout

```
index.html   markup, HUD, menus, touch pad
style.css    Win3.1-flavoured panels and the snow UI
game.js      physics, world generation, sprite drawing, audio
reverse-engineering/   NE/PE resource extractors + extracted metadata
```

## Licence

MIT for the code in this repository.
