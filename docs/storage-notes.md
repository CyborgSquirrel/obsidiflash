# Storage design notes (shelved)

Findings from the initial brainstorm on how to store review/scheduling state for the Obsidian flashcard plugin. Status: **backburnered**. Nothing here is built yet.

## Context

- Plugin in TypeScript, FSRS scheduling (`ts-fsrs`), same-day repeats, clozes later.
- v1: front/back cards only, no sync. Cards are notes with a flashcard tag; first H1 = front, second H1 = back.
- Sync will be a separate effort later: a custom service on the owner's VPS, not Syncthing / Obsidian Sync.
- Must work on desktop (Linux) and mobile (iOS).

## Leading design: append-only event log

- Review events are appended to a log; card state is derived from it.
- Each event has a unique id (e.g. `<deviceId>:<seq>`) so merging logs is an idempotent set union. This is the core property needed for later sync.
- FSRS is Markov: the next state depends only on the card's current state, the rating, and elapsed time. A session needs only the in-memory state per card, not the full history.
- Full history is only needed for: rebuild from scratch, changing FSRS parameters / learning steps, running the optimizer, stats, and fixing out-of-order or undone events.
- State lives in an in-memory `Map<cardId, CardState>`, rebuilt at startup. An optional snapshot (state + log offset/segment list) can skip replay later. The snapshot is a disposable cache; the log is the truth.
- Undo: append an `undo` event referencing an earlier one; never delete lines.
- Key events by a stable card `id` in frontmatter, not the file path or name. Events for deleted notes are ignored.
- Ordering: sort by (timestamp, deviceId, seq). `ts-fsrs` ships `reschedule` / `rollback` / `forget` for replay (per the second-opinion research; not independently checked).
- Scale: ~200 reviews/day is roughly 7 MB/year of JSONL. Loading that is cheap.

### Segments

- Obsidian's file API has no ranged reads, so split the log into small files (e.g. monthly per device: `reviews/<device>/2026-10.jsonl`).
- Normal startup reads only the snapshot plus the current segment. Rebuild/stats read old segments one at a time.
- Appends go through `adapter.append` / `appendBinary`.
- Device id must not be stored in synced `data.json` (a copied vault would share it); keep it in local storage.

## SQLite findings

- Anki uses SQLite natively, but Obsidian plugins are JS in a webview, with no native modules on mobile.
- `sql.js` (WASM) works in Obsidian, including mobile, but is **in-memory only**: load the whole file with `readBinary`, write it all back with `writeBinary`. Fine at this scale (a few MB), but every save rewrites the whole file, and iOS may suspend the app before a debounced write fires.
- `wa-sqlite` with IndexedDB / OPFS VFS gives paged access, but the data lives in browser storage, not the vault. It can be evicted or cleared, so it is unsafe as the only copy of progress. Fine only as a rebuildable cache.
- A custom VFS over chunk files in the vault would give paged, durable storage, but needs the asyncify build (SQLite is synchronous, Obsidian's file API is async), careful journal/crash handling, and many files. Possible, high effort, unverified on iOS.
- What SQLite needs from storage: ranged reads, ranged overwrites, truncate/size, and a durability guarantee. Obsidian currently offers none of these directly.
- Verdict: not needed for v1. If wanted later for stats, build it as a disposable cache over the log.

## Obsidian file API gaps

- Only whole-file `readBinary` / `writeBinary`. `appendBinary` was added in Obsidian 1.12.3 (per the forum thread below).
- No ranged read, no streaming read, no in-place overwrite.
- Forum thread: https://forum.obsidian.md/t/add-api-support-for-reading-and-writing-binary-by-chunks-or-streaming/77384 (by fyears, Feb 2024). Partially resolved. A community workaround for reads is `fetch()` on `adapter.getResourcePath(path)` with an HTTP `Range` header, reportedly working on Electron / Android / iOS WebView. **Unverified by us**, and a separate bug report says the Android resource server ignores the end of a Range request.
- Correction: an earlier citation of a thread named "Partial vault.adapter.readBinary() with byte range?" (id 113828) returned 404. Disregard it.
- Desktop (Electron) has Node `fs`, so real random access is possible there only.

## Compression / zip

- Browsers have no zip API. `CompressionStream` / `DecompressionStream` handle `gzip`, `deflate`, `deflate-raw` only, not the zip container. Reported iOS support from Safari 16.4 (from search snippets; not checked against Obsidian's webview).
- Pure-JS options that run identically on Linux and iOS: `fflate` (small, sync + streaming), `JSZip`, `zip.js`. The mobile-listed "File Compressor" plugin bundles `pako`, per its listing.
- None of these libraries append to an existing archive; they build or read whole zips.
- Plan if/when needed: gzip **sealed** monthly segments (`2026-10.jsonl.gz`), keep the current segment as plain text. Roughly 5-10x smaller. Does not give partial reads.

### Single append-only zip (idea, unverified)

- Zip layout: local headers + data, then a central directory and end-of-central-directory (EOCD) record at the end. Readers find the EOCD by scanning from the end.
- Append-only variant: append new local entries, then a fresh full central directory and EOCD. Old central directory/EOCD stay as dead bytes mid-file. Most readers use the last EOCD, but tolerance across tools is **not verified**.
- Problems: rewriting the central directory on every review makes the file bloat quadratically, so entries should be batches (e.g. one per day/flush) with the active journal in a plain file. A crash mid-append leaves trailing garbage, and there is no truncate API to repair it. Reading still needs the whole file (no ranged reads).
- Motivation noted by owner: avoid a directory with many files (some file viewers choke) and have an opaque store. Worth revisiting.
- Not tested: no zip experiments were run, on desktop or in a webview.

## How Anki handles conflicting sync (from memory, not re-verified)

- Review history entries are unioned by timestamp-based id, so redoing reviews on a second device yields duplicate history entries.
- Card scheduling state is last-write-wins by modification time, not recomputed from history.
- Schema-level divergence forces a full sync where one side overwrites the other.
- Implication for us: a log-derived state would double-count duplicated reviews. A future sync service needs dedup rules (e.g. ignore a review of a card within N seconds of another) or a per-card winner. Nothing in the v1 log format blocks either.

## Open questions / next steps

1. Spike on a real iPhone: does `appendBinary` behave on iOS Obsidian? Does `fetch` + `Range` on `getResourcePath` work? Is `CompressionStream` available in the webview?
2. Search the Obsidian forum for `appendBinary` problems on iOS.
3. Prototype and test the append-only zip layout against real zip tools (`unzip`, `7z`, Python `zipfile`) and `fflate`.
4. Decide sync dedup rules when the sync service is designed.
5. Scaffold v1 plugin: frontmatter `id` + flashcard tag, parser, monthly JSONL log writer, in-memory replay with `ts-fsrs`, review view, unit tests.
