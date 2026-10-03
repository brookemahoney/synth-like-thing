---
id: 12
group: "monet-inspired-browser-synthesizer"
dependencies: [10]
status: "pending"
created: 2026-10-02
skills:
  - javascript
  - file-api
  - data-persistence
complexity_score: 5
execution_profile: "standard-implementation"
---
# Preset System: 12 localStorage Slots and JSON Round-Trip

## Objective
Give the instrument memory: twelve named preset slots in `localStorage` under a versioned schema key, each storing every parameter, all four patterns, the chain order, the swing value, the tempo and any user-loaded wavetables, with a baked init patch as the fallback and a JSON export/import that round-trips the whole document.

## Skills Required
- **javascript** — store serialization, schema versioning, validate-before-replace.
- **file-api** — `Blob` + object URL for export, `<input type="file">` for import.
- **data-persistence** — `localStorage` schema versioning, migration and failure fallback.

## Acceptance Criteria
- [ ] Twelve slots exist and are individually addressable by name. Verified by `playwright-cli eval` enumerating 12 slots and writing a different value to each, then reading all 12 back.
- [ ] A patch saved to a slot **survives a full page reload** with all parameters, patterns, chain order and tempo intact. Verified concretely: move one knob to a distinctive value, set a distinctive tempo, write a distinctive pattern step and chain order, save, run `playwright-cli goto https://soc.ddev.site/` to reload, then `playwright-cli eval` the restored values and confirm an exact match.
- [ ] The stored document includes all four patterns, the chain order, swing, tempo and any user-loaded wavetables. Verified by writing each and confirming each survives the reload.
- [ ] Export produces a JSON file containing all of it, and import reads one back. Verified by exporting, reading the emitted JSON, changing several parameters, importing, and confirming the original values return exactly.
- [ ] Import **validates before replacing anything**. Verified by importing a malformed JSON document and confirming the instrument's current state is untouched and still playable, and that the captured-error array records the reason.
- [ ] A stored document that fails to parse falls back to the baked init patch, logs the reason, and leaves the instrument fully playable. Verified by writing garbage into the storage key, reloading, and confirming the init patch loads, the reason is logged, and a note still sounds.
- [ ] A schema-version mismatch is detected rather than silently applied. Verified by writing a document with a bumped version and confirming it is treated as incompatible (fallback to init patch with a logged reason), not partially applied.
- [ ] The storage key is versioned and namespaced. Verified by reading the key name through `playwright-cli eval`.
- [ ] Presets save and restore the currently playing pattern set, chain order and swing. Verified by saving with a non-default chain order, reloading, and confirming the chain order is restored.
- [ ] `localStorage` content is readable through the runtime inspection path for self-validation step 12.

## Technical Requirements
- Storage key is namespaced and versioned, for example `soc.synth.presets.v1`.
- A stored document carries a schema version field. On load, a version mismatch is a controlled fallback to the init patch with a logged reason — never a partial apply.
- The document contains: schema version, the full flat parameter map, four patterns, chain order, swing, tempo, and any user-loaded wavetables (as serialized sample data or as the resampled 2048-point table — pick one, document the choice and the size implication of a `localStorage` quota).
- `localStorage` has a size quota. A loaded wavetable can be large. Handle quota exhaustion as a save failure with a visible reason, not a silent truncation.
- Export: serialise the document to JSON, wrap it in a `Blob`, create an object URL and trigger a download with a sensible filename including the patch name.
- Import: `<input type="file" accept=".json,application/json">` → read → `JSON.parse` in a `try` → validate the schema version and the presence of every expected top-level key → only then apply.
- The init patch is a module-level constant equal to the store's default set, so there is exactly one definition of the defaults.

## Input Dependencies
- The parameter store and the init patch from **Task 1**.
- The patterns, chain order, swing and tempo from **Task 10**.
- Any user-loaded wavetables from **Task 5**.

## Output Artifacts
- A preset module: 12 named slots, load, save, delete, a "next empty slot" behaviour, and the schema-versioned document shape.
- JSON export and import with validation before replacement.
- A store subscription that keeps the currently-loaded slot's state consistent (decide and document: live editing of a loaded slot, or a copy-on-load; pick one and implement it cleanly).
- Rendered slot controls in the global strip or a dedicated preset area.

## Implementation Notes

Presets that silently fail to restore are the plan's named risk. Every failure path must be **visible and recoverable**: schema mismatch, parse error and quota exhaustion each fall back to the init patch and log a distinct reason. A preset system that fails quietly is worse than one with no presets.

Decide the live-editing question deliberately. If a loaded slot tracks further knob movements, saving is implicit and a "revert" action needs a snapshot. If loading copies the values and leaves the slot untouched, saving is always explicit and revert is just "load again". The second is simpler and less surprising; pick it and say so in the module header.

Wavetables in `localStorage` are a real size risk. A 2048-point table is manageable as plain integers, but a user could load a large file and the resampled table is what gets stored, not the original. Store the resampled table and document the approximate byte cost per slot.

Export and import must be exact round-trips, not approximate ones. Verify with distinctive values, not defaults — a default-valued patch round-trips trivially and proves nothing.