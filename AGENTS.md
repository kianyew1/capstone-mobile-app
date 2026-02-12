# AGENTS.md

You are Codex (GPT-5) running as a coding agent in the Codex CLI on a user's computer.

## Mission: Reliable ECG Pipeline With Minimal UI

You are building features for a 2-person Expo React Native team that relies heavily on AI agents.
Optimize for:
- Reliable, behind-the-scenes work over UI polish: BLE stream handling, decoding, buffering, SQLite writes, export, Supabase upload, FastAPI triggers, retries, determinism.
- Minimal UI surfaces: only enough UI to validate flows (buttons + status + debug outputs).
- Low merge friction: feature modules, clear interfaces, small cohesive commits/patches.

## Repo-first rule (critical)

Before writing code:
- Scan the repo to learn existing patterns and conventions (folder structure, hooks/services, navigation, env/config, existing storage helpers).
- If the plan conflicts with repo patterns, update `PLANS.md` (and only then implement) with a small note describing the change.

## Phase-based execution (critical)

Work in phases aligned to `PLANS.md`.
For each phase:
- Implement that phase completely.
- Add a section to `PLANS.md` titled "Sanity checks & tests" for that phase (if missing), and ensure it is actionable.
- Provide the same checklist in your final response.
- Do not proceed to the next phase unless the current phase has a clear validation path.

## Product rules for this project (ECG-specific)

### Core flows
- Policy A: Calibration MUST happen before Run (separate sessions).
- Calibration is exactly 20 seconds and is accepted by duration on-device.
- Calibration can be rejected by backend after upload; on reject, block Run and prompt redo.
- Never upload during recording. Upload only after user ends calibration/run.

### Data format & storage
- BLE packets contain `seq` and samples as int16. Use seq to detect gaps.
- Store raw ECG incrementally in `expo-sqlite` as chunked rows (default chunk duration 2s).
- Do not store raw ECG as JSON arrays.
- Store raw as little-endian int16 bytes, base64-encoded for SQLite.
- At session end, export one consolidated blob and compute SHA-256 of raw bytes.

### Cloud stack
- Supabase Storage holds raw blobs.
- FastAPI registers sessions, validates calibration cleanliness, and triggers analysis.

### Multi-lead
- Multi-lead post-processing is not finalized.
- Implement a strict boundary function `postProcessPacketToLeads(...)` with a stub and TODOs.
- Store lead metadata fields (`lead_count`, `layout`) now so schema won’t need breaking changes later.
- Do not invent lead mapping if repo/docs don’t define it—leave TODO + make 1-lead mode work end-to-end.

## Team workflow & merge safety

- Prefer feature modules: add code under `src/features/<featureName>/...` unless the repo already uses a different pattern.
- Separate concerns strictly:
  - UI components: presentation only, no direct BLE/SQLite/Supabase/FastAPI calls.
  - Hooks/controllers: orchestrate side effects (recording state machine, timers, export).
  - Services: BLE wrapper, DB wrapper, cloud client with typed interfaces.
- Make “drop-in” APIs: export a small surface like `{ useEcgSession }` and a minimal screen/widget for testing.
- Avoid broad refactors. If necessary, explain why and keep changes scoped.
- Keep dependencies minimal; add new libraries only if clearly necessary and compatible with Expo.

## Error handling & determinism

- No silent failures. If input is invalid, surface an error (log + return error state).
- Ensure exports are deterministic: same stored chunks -> same base64 + same SHA-256.
- Idempotency: use `local_session_id + sha256` as an idempotency key for retries.

## Tools & repo operations

- Prefer fast search tools: `rg` / `rg --files`.
- Batch reads and edits; avoid thrashing.
- Use non-destructive operations. Never run `git reset --hard` or revert unrelated changes.

## Deliverable expectations

Default expectation: deliver working code, not just a plan.
If blocked (missing lead mapping or API contract), still deliver scaffolding with clear TODOs and a working 1-lead local pipeline.

Final response must include:
- What changed + key file paths
- How to test (sanity checklist per phase)
- Integration snippet(s) for UI wiring (minimal)

## Documentation in PLANS_TRACKER.md

For me to know what you've done and completed