# Review log and sync design (DRAFT)

**Status: draft.** This captures the current thinking before implementation. Expect details to change. Open decisions are listed at the end. Background research is in `storage-notes.md`.

## Goals

- Store review history for FSRS scheduling in a form that is append-only and union-able.
- A central sync server is the source of truth. It is a core part of the project, not an add-on.
- Works on desktop (Linux) and mobile (iOS), using only Obsidian's whole-file read/write plus `append`.
- No SQLite. Card state is derived from the log and kept in memory.
- The cards themselves are notes in the vault, synced by Syncthing. The log directories are excluded from Syncthing (`.stignore`); the log is synced only by the custom sync server.

## Architecture overview

One reusable data structure, the **block log** (`BlockLog`), is pointed at a directory and manages its own files. The server and the client both use it.

- You append entries as often as you like. The log keeps sealed blocks and one in-progress block. When the in-progress block reaches 1,000 entries it is sorted, sealed, and a new in-progress block starts.
- Blocks are numbered. There are no per-entry sequence numbers.
- The **server** has one block log: the source of truth.
- A **client** has two block logs:
  - **local log**: this device's own reviews that the server may not have yet. If no server is configured, it just keeps growing and nothing else is needed.
  - **mirror**: a local clone of the server's log.
- Whenever the full sorted history is needed, k-way merge all blocks from both client logs.

Intended `BlockLog` surface (sketch): `append(entry)`, `blocks()`, block and open-entry readers, a way to adopt a whole sealed block, and a merged iterator over any set of logs.

## Data model

### Event

One line of JSONL per review (final schema TBD):

```json
{"t":1760184843000,"d":"a1b2c3d4","card":"<cardId>","rating":3}
```

- `t`: review timestamp (UTC, milliseconds).
- `d`: device id, 32 random bits (8 hex characters), generated per install.
- `card`: stable card id from note frontmatter (not the file path).
- `rating`: Again / Hard / Good / Easy.
- Events are reviews only. Undo is handled at the application level (see below).

### Ordering key

- The key is `(t, d)`. It is unique and a total order across all devices and logs.
- Uniqueness comes from each device issuing strictly increasing timestamps: `t = max(now, last + 1)`, where `last` is the largest `t` the device has issued. This also survives the clock moving backwards.
- `last` is not stored separately. The local log contains only this device's entries, in increasing `t`, so `last` is the `t` of the final line of the local log (the open block, or the newest sealed block if the open block is empty). Cleanup after a sync never deletes the local log's newest entry, so `last` survives; the extra duplicate line is dropped by the merge.
- The device id is likewise read from the local log. A fresh install has no entries: it generates an id in memory, `last = 0`, and persists the id by writing its first entry.
- FSRS state depends on the order of a card's reviews and the gaps between them, so the key order is the logical order. Reviews of different cards never interact.

### Blocks

- Fixed size: 1,000 entries, everywhere (local, mirror, server). At 200 reviews a day that is about 73 sealed blocks a year per log.
- **In-progress block:** stored in arrival order (on the server this interleaves devices). Sorted in memory when needed.
- **Sealed block:** immutable. Sorted once by `(t, d)` at seal time. Because the key is unique and total, every machine produces byte-identical bytes regardless of the order entries arrived in.
- Blocks are numbered. The server assigns block numbers in creation order. The in-progress block keeps its number even if sealed blocks are adopted after it; it is therefore not necessarily the highest-numbered block.
- **The directory is the source of truth; there is no manifest.** A sealed block exists once its file has been atomically renamed into place (temp file + rename). Block numbers are never reused: the next number is one more than the highest across `sealed/` and `open/`, and there is at most one open file. If `sealed/N` exists, `open/N` is stale and is removed on open.
- Per-block facts (entry count, min/max `t`, content hash) are derived data. They live in an optional `index.json` cache that is rebuilt from the block files when it is missing, stale or corrupt. Sync can use them to compare blocks, and `maxT()` reads them instead of scanning.
- A one-line `VERSION` file holds the format version (the escape hatch for migrations). The block size is a constant and is not stored: a block seals when it reaches that size, so existing blocks stay valid if the constant changes.
- A client's local log only holds its own entries in increasing `t`, so local blocks are sorted by construction.

### Layout (sketch)

```
<log dir>/                 # excluded from Syncthing
  local/
    VERSION
    index.json             # optional cache
    open/000002.jsonl      # at most one in-progress block
    sealed/000001.jsonl
  mirror/
    VERSION
    index.json
    open/000004.jsonl
    sealed/000001.jsonl
```

Names are placeholders. Sealed blocks may later be gzipped (see `storage-notes.md`).

### Line validity

- A line counts only if it ends with a newline. An unterminated last line is invalid and is dropped. No checksums.
- On open, a server truncates the file to the last newline. A client rewrites the open block trimmed to its last newline (preferably write a temp file and rename; rename-over-existing needs checking on iOS).

## Merge

- K-way merge with a binary heap over all blocks of both client logs (the open blocks sorted in memory).
- Compare the cached head timestamp of each block; on equal `t`, the lower device id wins. There is no concept of which log an entry came from.
- Two entries with the same key `(t, d)` are the same event (it can exist in both the local log and the mirror before cleanup), so the merge drops an entry equal to the previous one.
- Implementation notes from throwaway Node/V8 benchmarks with synthetic data (scratchpad only, not in the repo; single runs or medians of 5; iOS/JavaScriptCore not measured):
  - A plain global sort is already fast: 700k events sort in about 12 ms when nearly sorted and about 300 ms when fully random. The block structure's value is immutability, incremental sync and a streaming rebuild, not raw speed.
  - A zero-allocation binary heap beats the global sort when data is out of order. It holds block indices in an `Int32Array`, keeps per-block cursors in another, and replaces the top in place with one sift-down per output (no push/pop, no wrapper objects).
  - Caching each block's head timestamp in a `Float64Array` and only touching event objects on exact ties cut a further 20-35% on slow cases.
  - A linear scan over block heads degrades badly with hundreds of blocks (about 2 s at 700 blocks), so use the heap.
  - With 1k blocks (700 blocks at 700k events) the heap merge took roughly 190-280 ms.
  - Heavy timestamp ties cost essentially nothing extra when the tie rule runs only on equal timestamps.

## Sync

### Client side

1. Flush any reviews still held in memory for undo (see below) into the local log.
2. Upload the full sealed local blocks whole, in order, plus the entries of the local open block as loose entries. The local open block is not force-sealed, so blocks stay at 1,000 entries.
3. The server replies with the device's mark (last `t` received) and the result.
4. Pull: comparing block numbers and hashes gives the sealed blocks the client lacks; for any block it holds only in part, the client sends a per-device map of the last `t` it holds and gets the rest (see Pull cursor).
5. Place each pulled sealed block into the mirror atomically (temp file + rename), and append pulled open-block entries to the mirror's open block.
6. Cleanup: delete acknowledged sealed local blocks; rewrite the local open file without acknowledged entries, but keep the newest entry.

### Server side

- **Whole sealed blocks:** the server verifies the block (valid lines, sorted by `(t, d)`, strictly increasing `t` per device, `t` above the device's mark, hash) and adopts it, giving it the next free block number. No sorting or renumbering is needed because the lines contain nothing the server assigns. The client keeps its own copy as the mirror block, so it does not download its own upload back.
- **Loose entries:** appended to the server's in-progress block, which seals at 1,000 entries and is sorted then.
- **Marks:** the server keeps the last `t` received per device. Entries at or below the mark are accepted only as an exact repeat of a batch it already committed (same block hash for blocks; same first `t`, last `t` and count for loose entries), which makes retries after a lost response safe. Anything else is a device-id error: the server rejects it and the client gets a "reset device id" option. Reset generates a new id, re-stamps the unsynced local entries with it (keeping `t`), and drops the retained old-id newest entry instead of rewriting it, so no review is counted twice.
- This mirrors Raft's client-request deduplication (the state machine remembers the latest applied per client).

### Pull cursor

The client sends the sealed block numbers it holds completely (as ranges, for example `[[1,5]]`) and, for each block it holds only in part (normally the one in-progress block), that block's number and a map `{device: last t held}`.

Why the map works: the server accepts each device's entries in increasing `t`, so within any block each device's entries arrive in `t` order. A client holding a prefix of a block therefore holds, per device, every entry up to some timestamp, and the missing entries are exactly those with `t` above that value. A device the client holds nothing for is absent from the map, meaning all of its entries are missing.

The server replies with:

- every sealed block the client lacks, whole (they are cached forever);
- for each partial block, the entries whose `t` is above the client's value for their device, whether that block is still open or has been sealed and sorted since. The server scans the block (at most 1,000 lines) to pick them. Nothing needs the arrival order after sealing, so no unsorted block type and no extra line field are needed.

If the server has sealed the client's partial block and also started a new open block, the client sends the partial block's map and asks for the new open block with an empty map (everything).

Once the client's copy of a block is complete it sorts it locally and checks the block's hash against the server's. A match means the block is final; a mismatch means fetch the sealed block whole.

The in-progress block is not necessarily the highest-numbered block, so block numbers are always sent explicitly.

### Server crash safety (WAL / commit journal)

- Append entries (or write the adopted block) to the data file and `fsync`.
- Append one journal record and `fsync` it; the record is the commit point: `device, first t, last t, count or block number and hash, file, endOffset`.
- Only then acknowledge the client.
- On startup, truncate the data file to the last committed `endOffset`; anything beyond it is an uncommitted tail. A torn last journal line is invalid and ignored.
- The per-device marks live in the server's journal and checkpoint, not in the log entries and not on clients.
- Sealing and adoption: write the file to a temp name, `fsync`, rename, then journal a record. Recovery deletes leftover temp files and redoes unfinished seals.
- Checkpoint / compaction: write the new checkpoint (per-device marks, last committed offset) to a temp file, `fsync`, `rename` over the old one, `fsync` the directory. Never overwrite in place. The journal after the checkpoint is what recovery replays.
- Alternative if this becomes too fiddly: run the server on SQLite (WAL mode) so entry insert and mark update are one transaction, and generate block files from it.

### Single-device mode (v1, no server)

Only the local log exists and it chugs along. On first connection to a real server, the whole local history is uploaded as sealed blocks plus loose entries.

## Undo (application level)

- Undo is not in the storage format.
- The app applies each review to its in-memory card state immediately (so same-day repeats and queue ordering work), but keeps the last ~5 reviews uncommitted in memory, together with each card's previous state.
- Undo restores a card's previous state and discards that uncommitted review.
- When a sixth review arrives, the oldest is appended to the log (in order, with its original timestamp).
- Uncommitted reviews are flushed to the log automatically when a review session ends, when the app goes to the background / is closed for a while, and before a sync. Flush-on-background is a later quality-of-life item.
- Known cost: if the app is killed or suspended before a flush, up to ~5 reviews are lost. A tiny staging file would close this gap if it ever matters; not planned for now.
- Snapshots must correspond to the committed log, so write them only when the held-back reviews are flushed.
- An older mistake cannot be undone. If that is ever needed, a compensating event type can be added later without changing the structure.

## Computing card state

- **Normal startup:** load an optional snapshot (per-card FSRS state plus the blocks and partial-block positions it covers), then fold only newer entries. The snapshot is a disposable cache; the logs are the source of truth. FSRS only needs a card's current state to schedule the next review, not the full history.
- **Full rebuild:** k-way merge over all blocks. Pop events in key order and apply each to a `Map<cardId, state>` with `ts-fsrs`. This is a streaming pass: memory is k block cursors plus the state map.
- **Late or out-of-order entry for a card** (a pulled entry whose timestamp is older than or equal to the card's last review): re-fold that card's events in key order; do not patch its current state. This needs a merge filtered to the affected cards.
- During a review session, state is updated in memory with one FSRS step per rating; the durable write is the append.
- Changing FSRS parameters or learning steps means re-running the fold over the log.
- To test: `ts-fsrs` behavior when two reviews of the same card are very close together in time.

## Prior art: Anki

Based on a quick search, not a full study:

- Review log ids are epoch-millisecond timestamps, unique within their table; a colliding id is incremented ([Anki-Android database docs](https://github-wiki-see.page/m/ankidroid/Anki-Android/wiki/Database%E2%80%90Structure%E2%80%902026)). We get uniqueness differently, with a device id in the key.
- Sync uses an update sequence number: -1 marks local changes still to push, otherwise the server's number at last sync; the client pulls everything changed since its last number ([forum discussion](https://forums.ankiweb.net/t/show-and-resolve-per-card-per-note-conflicts-during-normal-sync-instead-of-silently-keeping-the-newest/71321)). This resembles our local log plus a server-side cursor, though ours is block-based.
- Review history is merged, but a card changed on two devices keeps the version with the newer modification time ([Anki manual: syncing](https://docs.ankiweb.net/syncing.html)). Our card state is derived from the merged history instead, so it stays consistent with it.

## What this gives up (known costs)

- Sealed blocks are immutable and cached on clients, and they bake in the sort order and event schema. Fixing a bad entry, deleting history, or changing the schema means a block rewrite plus client cache invalidation (the block version number exists for this).
- The server owns block numbering and adoption. Server backups matter. Clients still hold full copies of the events.
- Every line carries a device id (about 14 bytes with its key and quotes).
- More moving parts than a plain per-device log: two logs per client, an index cache, block-based cursor, server journal.
- Many small files: about 73 sealed blocks a year per log at 200 reviews a day.
- Up to ~5 recent reviews can be lost if the app dies before a flush (see Undo).

## Open questions (to revisit at implementation)

1. Final event schema and versioning.
2. Dedup rules for near-duplicate reviews from multiple devices (Anki unions history but keeps last-write-wins card state; we derive state from the log and would double-count). Options: ignore a review of a card within N seconds of another, or a server-chosen winner per card.
3. Handling devices with badly wrong clocks (a clock far in the future would sort a device's reviews after everything else, and the monotonic rule would keep them there).
4. How a client verifies and recovers if its blocks diverge from the server's (block hash check against the server's, re-fetch).
5. First-sync reconciliation when a device has local history and the server already has other devices' data.
6. Whether and when to gzip sealed blocks.
7. Whether ranged reads (Obsidian API, or `fetch` + `Range` on `getResourcePath`, unverified on iOS) change any of this.
8. Server implementation, transport, auth, and storage (runs on the owner's VPS; not designed yet).
9. Exact reset-device-id flow and what the user sees when the server returns a device-id error.
10. Verify on a real iPhone: `append`/`appendBinary`, rename-over-existing, and file handling at the scale of many small block files.
