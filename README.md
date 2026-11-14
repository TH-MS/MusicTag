# MusicTag

A small, portable Windows 11 music tagger. Drop files in, edit per album, press **Auto**.

**Download:** [`MusicTag-vX.Y.Z.exe` (latest build; the number is the build version)](https://github.com/TH-MS/MusicTag/releases/tag/latest) – single file, no install.
(Unsigned, so Windows SmartScreen may warn once: *More info → Run anyway*.)

## Use
- Drag music files or folders onto the window (or click *Add*). Folders are scanned recursively.
- One card per **Album** value. The fields above each table edit every track in that album (`<keep>` = tracks differ; leave it to keep them).
- Double-click a cell to edit it (Enter = accept, Tab = next cell, Esc = cancel).
- Table columns: drag to reorder, drag the edge to resize (double-click edge = fit), click to sort, **right-click a header** to add/remove any column.
- **Auto** (under the cover):
  1. Album Artist found on any track → copied to tracks that lack one.
  2. Highest-resolution embedded cover → copied over lower-resolution (or missing) covers.
  3. Track `1` → `01`, and "of" = highest track number on that disc (`01/12`).
  4. Disc `1` → `01/01`; "of" is always filled (disc count, `01/03` for three discs).
  5. Empty Sort Album + one shared year across the album → year copied into Sort Album.
- **Under each cover:** Auto · Select All · **Save (n)** (this album only). Top right: **Save all (n)**.
  Ctrl/Shift-click rows to pick a subset; the bulk fields then edit just those tracks.
- **Top bar:** *Sort* albums (title / artist / year, asc/desc, within artists), *Collapse all / Expand all* (each album also has its own arrow), *Folder*.
- **Filing on save** (Folder menu: choose a root folder; can be switched off). Files are moved to
  `Root\Album Artist\Album\NN - Title.ext`, or `Root\Album Artist\Album\D-NN - Title.ext` when the album has more than one disc
  (same as the MP3Tag rule `%albumartist%\%album%\$ifgreater(%totaldiscs%,1,%discnumber%-,)$num(%track%,2) - %title%`).
  Characters Windows forbids become `_`; an existing file is never overwritten (` (1)` is appended).
- **Cover art:** click the cover for Add / Remove / Extract / Cut / Copy / Paste (applies to the whole album). There is deliberately no "Adjust cover": re-encoding images would need an image library and bloat the app.
- **Settings:** *Global adjustment* on = column widths/order/headers are shared by all albums; off = each album keeps its own. Turning it back on copies the most recently adjusted album's layout to the rest.
- **Clean tags:** saving writes one value per field (ID3v2.4), removes legacy duplicate date frames (TYER/TDAT/TIME) and any stale ID3v1 block, and leaves other frames (ratings, etc.) alone.
- Typing a track/disc number without a leading zero is padded automatically (`3` → `03`, `003` for 100+ track albums); filenames always use the padded form.
- Changes are staged (highlighted). **Save** writes them; **Clear** discards.

## Build
Everything is built by GitHub Actions (`.github/workflows/build.yml`): tag-engine tests on Linux, then a Tauri build on Windows. Each push to `main` refreshes the `latest` release.

- `core/` – Rust tag engine ([lofty](https://crates.io/crates/lofty)): MP3, M4A, FLAC, OGG/Opus, WAV, AIFF, …
- `src-tauri/` – thin native shell (window, drag-and-drop, file dialog)
- `ui/` – plain HTML/CSS/JS, no build step
