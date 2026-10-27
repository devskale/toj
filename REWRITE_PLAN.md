# jot Collaborative Editing Rewrite — Execution Plan

Based on `plan.md` and the `articulated` semantic-rebasing demo architecture.

## Phase 0: Foundation (Shared Types & TrackedIdList)

### 0.1 Create `src/collab.ts` — Server-side collaborative state
- `CollabState`: `idList`, `chars` (Map), `serverCounter`
- `TrackedIdList` wrapper recording `IdListUpdate[]`
- `applyClientMutations()` — applies mutations, returns `{state, markdown, idListUpdates, changed}`
- `saveCollabState()` / `loadCollabState()` for persistence
- `selectionToIds()` / `selectionFromIds()` helpers

### 0.2 Create `public/collab-shared.js` — Browser-side equivalents
- `SimpleIdList` (load/clone/at/indexOf/cursorAt/cursorIndex/insertAfter/deleteRange)
- `TrackedIdList` wrapper
- `applyClientMutation()` / `applyIdListUpdates()`
- `selectionToIds()` / `selectionFromIds()`
- `ElementIdGenerator` for client-side ID generation

## Phase 1: Server Rewrite

### 1.1 Refactor `NoteRecord` — Make collab authoritative
- Remove `markdown` field (derived)
- Store `collab: CollabState` + `clientAcks: Map<string, number>`
- `persistNote()` derives markdown via `collabToMarkdown()`

### 1.2 Replace WebSocket protocol
- Remove generic `updated` broadcast for editors
- Implement:
  - `hello` — sends full state + `idListState` + `serverCounter`
  - `mutation` (server→client) — `{senderId, senderCounter, serverCounter, markdown, idListUpdates}`
  - `presence` / `presence-leave` (keep)

### 1.3 Server mutation handling
- Receive `ClientMutationMessage` with `clientId` + `mutations[]`
- Filter by `clientAcks` (only fresh mutations)
- Apply via `TrackedIdList` → get `idListUpdates`
- Update `note.collab`, `note.updatedAt`, persist
- Broadcast `ServerMutationMessage` to all editor connections
- Acknowledge sender (implicit via `senderCounter` in broadcast)

### 1.4 REST `/api/notes/:id/edit` — Convert to mutations
- Find `oldText` in current markdown → compute index
- Build delete + insert mutations
- Apply via same `applyClientMutations()` path
- Return saved state

### 1.5 REST `PUT /api/notes/:id` (markdown replacement)
- Rebuild `CollabState` from new markdown via `collabFromMarkdown()`
- Increment `serverCounter`
- Persist + broadcast `hello` to all editors

## Phase 2: Client Rewrite (New `collab-editor.js`)

### 2.1 State model
```
serverState: { text, idList }          // confirmed from server
pendingMutations: ClientMutation[]     // sent, not yet acked
currentState: { text, idList }         // serverState + replayed pending
```

### 2.2 Mutation generation (beforeinput)
- `insertText` / `insertReplacementText` / `insertFromPaste` → insert mutation
- `insertLineBreak` / `insertParagraph` → insert "\n"
- `deleteContentBackward` / `deleteContentForward` → delete mutation
- `deleteWordBackward` / `deleteWordForward` → delete word range
- `deleteSoftLineBackward` / `deleteHardLineBackward` → delete to line start
- Fallback: diff-based for composition edge cases

### 2.3 Send mutations
- Assign incrementing `clientCounter`
- Add to `pendingMutations`
- Apply locally immediately (optimistic)
- Send via WebSocket

### 2.4 Receive server mutation
```js
function receiveMutation(msg) {
  // 1. Apply to serverState
  serverState = { text: msg.markdown, idList: applyIdListUpdates(serverState.idList, msg.idListUpdates) }
  
  // 2. Drop acked mutations if from us
  if (msg.senderId === clientId) {
    const ackedUpTo = msg.senderCounter
    pendingMutations = pendingMutations.filter(m => m.clientCounter > ackedUpTo)
  }
  
  // 3. Rebuild currentState by replaying pending on serverState
  currentState = replayPending(serverState, pendingMutations)
  
  // 4. Restore selection by IDs
  const selIds = selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, ...)
  render(selectionFromIds(selIds, currentState.idList))
}
```

### 2.5 Receive hello
- Initialize `serverState`, `clientId`
- Replay any pending (should be none on fresh connect)
- Render

### 2.6 Selection preservation
- Track selection in ID-space via `selectionToIds()`
- On render, convert back via `selectionFromIds()`
- Throttled presence sends ID-based selection

## Phase 3: Wire Into `app.js`

### 3.1 Replace editor initialization
- Remove old `reloadFromServer` / REST polling for editor mode
- Import new `createCollabEditor` from `/static/collab-editor.js`
- Pass callbacks: `onReady`, `onTextChange`, `onConnectionChange`, `onThreadsUpdated`

### 3.2 Keep preview rendering via `/api/render` (server-side)
- Debounced render on `onTextChange`

### 3.3 Threads — keep existing WebSocket `threads-updated` flow

## Phase 4: Test & Verify

### 4.1 Smoke tests (manual, two tabs)
- [ ] Normal typing speed — no dropped/reordered chars
- [ ] Two tabs editing same note — converge correctly
- [ ] Backspace / delete / paste / newline / word delete
- [ ] Editing in middle of line
- [ ] Both users typing in different places
- [ ] Both users typing in same word
- [ ] Cursor stable during remote updates
- [ ] `.md` file stays up to date on disk
- [ ] Comments still render and can be added
- [ ] CLI list/search/read/edit/update/delete works

### 4.2 Edge cases
- [ ] Reconnect after disconnect — state syncs
- [ ] Rapid typing + network latency
- [ ] IME composition
- [ ] Large paste

## File Changes Summary

| File | Action |
|------|--------|
| `src/collab.ts` | **Rewrite** — core server collab logic |
| `src/server.ts` | **Refactor** — note model, WS protocol, REST edit |
| `public/collab-shared.js` | **New** — browser collab primitives |
| `public/collab-editor.js` | **Rewrite** — new editor with reconciliation |
| `public/app.js` | **Modify** — wire new editor, remove reload logic |
| `public/styles.css` | Keep (cursor overlay styles already exist) |

## Non-Goals (Deferred)
- Remote cursors (presence works, rendering later)
- Public collaborative edit mode
- Operation history slider
- Migration tooling for old notes (convert on load)