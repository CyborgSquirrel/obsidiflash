# Review log and sync design (DRAFT)

**Status: draft.** This captures the current thinking before implementation. Expect details to change. Open decisions are listed at the end. Background research is in `storage-notes.md`.

## Goals

- Store review history for FSRS scheduling in a form that is append-only and union-able.
- A central sync server is the source of truth. It is a core part of the project, not an add-on.
- Works on desktop (Linux) and mobile (iOS), using only Obsidian's whole-file read/write plus `append`.
- No SQLite. Card state is derived from the log and kept in memory.

## Data model

### Event

One line of JSONL per review (final schema TBD):

```json
{"id":"<deviceId>:<deviceSeq>","card":"<cardId>","t":"2026-10-11T09:14:03Z","rating":3,"seq":null}
```

- `id`: unique event id. Makes union idempotent (retries and duplicates are dropped).
- `card`: stable card id from note frontmatter (not the file path).
- `t`: review timestamp (UTC).
- `rating`: Again / Hard / Good / Easy.
- `seq`: server-assigned sequence number, set when the server accepts the event. `null` until then.
- Other event types, for example `undo` referencing an earlier event id, are appended like any other event. Corrections are always compensating events, never edits to old data.

### Two orders

- **Storage order** is server arrival order (`seq`). This is what makes the log truly append-only; a late entry from a stale device gets a new `seq` at the end and never shifts history.
- **Logical order** is by timestamp, with a deterministic tie-break: `(t, deviceId, deviceSeq)`. FSRS state depends on the order and the time gaps between reviews, so this is the order used to compute state. Arrival order does not matter to FSRS.

### Blocks

- Entries are grouped into blocks by `seq` range, with a fixed size (for example 10,000 entries) so every client derives identical boundaries.
- **Open block:** the newest block, still being filled. Stored in `seq` order. Small, so it is sorted in memory when needed.
- **Sealed block:** full and immutable. At seal time its entries are sorted by `(t, deviceId, deviceSeq)` once, and the block never changes afterwards. Sealed blocks are byte-identical wherever they are produced.
- Each block has a small manifest: `seq` range, entry count, content hash, format version. Sync compares manifests and fetches only missing blocks. The version field is the escape hatch for migrations.
- Late entries from a stale device always land in the open block, never in a sealed one.

### Local layout (sketch)

```
reviews/
  pending.jsonl        # entries not yet accepted by the server, in append order
  open.jsonl           # current block, in seq order
  sealed/
    0001.jsonl         # immutable, sorted by (t, deviceId, deviceSeq)
    0001.manifest.json
    ...
```

Folder name and file names are placeholders. Sealed blocks may later be gzipped (see `storage-notes.md`).

## Operations

- `append(entry)`: write the event to `pending.jsonl`. In v1 with no server, see single-device mode below.
- `union(entries)`: server-side. Drop entries whose `id` is already known, assign increasing `seq` values to the rest in arrival order, append to the open block, and seal when the block is full.

### Sync

1. Client sends its pending entries.
2. Server dedups by `id`, assigns `seq`, appends.
3. Client's cursor is the highest `seq` it has seen (not a timestamp). Server returns every entry with `seq > cursor`, including the client's own entries now stamped with `seq`.
4. Client appends the returned entries to its open block (sealing as the server does), and drops matching entries from `pending`.
5. When the server has sealed a block the client holds as open, the client replaces it with the sealed, sorted version.

Retries are safe because of dedup by `id`. A device that was offline for months uploads old entries and they simply land in the current open block; no other client's history is rewritten.

### Single-device mode (v1, no server)

The device acts as its own server: pending entries get provisional `seq` values locally and move into the open block, and blocks seal by the same rule. On first connection to a real server, the local `seq` values are discarded and the whole local history is uploaded as one device's unsynced history. The server assigns real values.

## Computing card state

- **Normal startup:** load an optional snapshot (per-card FSRS state plus the cursor and block list it covers), then fold only newer entries. The snapshot is a disposable cache; the log is the source of truth.
- **Full rebuild:** k-way merge (heap) over all sealed blocks, the open block (sorted in memory) and `pending`. Pop events in logical order and apply each to a `Map<cardId, state>` with `ts-fsrs`. This is a streaming pass: memory is k block readers plus the state map.
- **Late or out-of-order entry for a card:** re-fold that card's events in logical order; do not patch its current state.
- During a review session, state is updated in memory with one FSRS step per rating; the durable write is the append.
- Changing FSRS parameters or learning steps means re-running the fold over the log.

## What this gives up (known costs)

- Sealed blocks are immutable and cached on clients, and they bake in the sort key and event schema. Fixing a bad entry, deleting history, or changing the schema means a block rewrite plus client cache invalidation (the block version number exists for this).
- The server owns ordering and sealing. A never-synced device has no authoritative order, hence single-device mode and the first-sync reconciliation above. Server backups matter, because the authoritative `seq` numbering lives there (clients still hold full copies of the events).
- More moving parts than a plain per-device log: open block, sealed blocks, pending file, cursor, sealing rule, merge.
- Arrival order is not visible after sealing unless each event keeps its `seq`; it does.

## Open questions (to revisit at implementation)

1. Final event schema and how it is versioned. Block size and sealing rule.
2. Dedup rules for near-duplicate reviews from multiple devices (Anki unions history but keeps last-write-wins card state; we derive state from the log and would double-count). Options: ignore a review of a card within N seconds of another, or a server-chosen winner per card.
3. Handling devices with badly wrong clocks, since timestamps are baked into sealed ordering.
4. How a client verifies and recovers if its blocks diverge from the server's (manifest hash check, re-fetch).
5. First-sync reconciliation details when a device has local history and the server already has other devices' data.
6. Whether and when to gzip sealed blocks.
7. How much of the design can use ranged reads if Obsidian adds them, or if `fetch` + `Range` on `getResourcePath` proves reliable on iOS (unverified).
8. Server implementation, transport, auth, and storage (runs on the owner's VPS; not designed yet).
9. Verify on a real iPhone: `appendBinary`/`append` behavior, file handling at the scale of many small block files.
