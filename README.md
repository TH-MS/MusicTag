# MusicTag

A small, portable Windows 11 music tagger. Drop files in, edit per album, press **Auto**.

**Download:** [`MusicTag.exe` (latest build)](https://github.com/TH-MS/MusicTag/releases/tag/latest) – single file, no install.
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
- Changes are staged (highlighted). **Save** writes them; **Clear** discards.

## Build
Everything is built by GitHub Actions (`.github/workflows/build.yml`): tag-engine tests on Linux, then a Tauri build on Windows. Each push to `main` refreshes the `latest` release.

- `core/` – Rust tag engine ([lofty](https://crates.io/crates/lofty)): MP3, M4A, FLAC, OGG/Opus, WAV, AIFF, …
- `src-tauri/` – thin native shell (window, drag-and-drop, file dialog)
- `ui/` – plain HTML/CSS/JS, no build step
