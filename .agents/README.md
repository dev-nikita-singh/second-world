# Agent Coordination Protocol

Several Claude agents build SECOND WORLD in parallel (max 4 at a time). This folder is the
**durable shared memory**: anything not written here is lost if an agent stops.

## Files

| File | Who writes | Purpose |
|---|---|---|
| `README.md` | main | This protocol |
| `BOARD.md` | main only | Waves, agents, ownership, task status |
| `CONTRACTS.md` | owner of the API (append-only for others: "Requests" section) | Cross-agent APIs: exact signatures + status |
| `progress/<agent>.md` | that agent only | Checkpoint log: done / in progress / next / decisions / blockers |
| `messages.log` | everyone, append-only one line per message | Durable copy of inter-agent messages |

## Rules for every agent

1. **Start**: read `README.md`, `BOARD.md`, `CONTRACTS.md`, and your own `progress/<you>.md`. If the progress file has content, you are **resuming**: continue from "Next", do not redo "Done".
2. **Ownership**: only create/edit files inside the paths you own (see BOARD.md). Need a change elsewhere? Message the owner.
3. **Never** run `npm install`/`npm i`, edit `package.json`, `tsconfig.json`, `vitest.config.ts`, or `biome.json`. Ask `main` via message for dependencies or config changes.
4. **Checkpoint** after every finished unit (a module + its tests passing): update `progress/<you>.md`. Keep it short and factual. A stranger must be able to resume from it.
5. **Messaging**: use the `SendMessage` tool. Address peers by the names in BOARD.md (use `ListAgents` if a name does not resolve), and the coordinator as `main`. Also append a one-line copy to `messages.log`:
   `2026-10-29T12:00Z sw-shared -> sw-perf: LatencyHistogram ready in src/shared/stats/hdr.ts`
   The first line of every message must be a self-contained summary.
6. **Contracts first**: if others depend on you (CONTRACTS.md), ship those exports first, with tests, then mark them `READY` in CONTRACTS.md and message the dependents.
7. **Blocked on a peer?** Code against the signature in CONTRACTS.md, use a local test double, and keep going. Don't wait idle.
8. **Tests are mandatory**: unit tests in `tests/unit/<area>/`, integration tests in `tests/integration/<area>/`. Run only your own tests: `npx vitest run tests/unit/<area>`. Also run `npx tsc --noEmit -p tsconfig.json` before declaring done. Don't break others' tests: if a contract change of yours does, message them.
9. **Code style**: TypeScript strict, ESM with `.js` import suffixes (`import { x } from "./y.js"`), no `Math.random` / `Date.now()` for durations in engine code (use ctx.rng / ctx.clock), no `console.*` outside `src/cli`, no recursion on user-sized input, bounded memory. Match docs/ (the spec) and cite the section in a header comment.
10. **Portability**: Windows + macOS + Linux. Use `node:path`, bind servers to port 0 on `127.0.0.1`, never hard-code ports, never use `shell: true`.
11. **Finish**: final progress update, mark your tasks on the board in your progress file (main updates BOARD.md), message `main` with a summary: what's done, test counts, known gaps.

## Resuming a stopped agent

- Same agent: main sends it a message (its transcript is kept), e.g. "continue from your progress file".
- New agent: spawned with the same name and prompt; it reads `progress/<name>.md` and continues.

## Important: don't wake finished agents

Agents marked DONE on BOARD.md are stopped. A SendMessage to them **restarts** them and breaks the 4-agent limit.
Send anything meant for a DONE agent to `main` instead; main resumes it when a slot is free.
