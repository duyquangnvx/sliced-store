# sliced-store v2 — Design Spec

## Overview

Complete rewrite of sliced-store, a feature-sliced state manager for game and real-time UI applications. Fixes critical bugs (silent state mutation, misleading batch semantics, lost type safety), eliminates unnecessary complexity (middleware, computed, store-level onChange), and provides full TypeScript inference from slice definitions through cross-slice access.

## Motivation

V1 issues driving the rewrite:

- **Silent state corruption**: `get()` returns mutable reference to internal state. External mutation bypasses all notifications.
- **Lost type safety**: Store uses `Map<string, SliceHandle<any>>` internally. Cross-slice access requires manual type cast with no compile-time verification.
- **Misleading batch**: `handle.batch(partial)` doesn't batch — fires N notifications for N fields. Same name as `store.batch(fn)` which actually batches.
- **Excessive cloning**: `structuredClone` on every read, every notification, every store listener invocation. Catastrophic for 60fps game loops.
- **Broken middleware**: `set()` drops keys added by middleware. Per-key execution prevents cross-field validation.
- **Listener fragility**: One listener error breaks entire notification chain.
- **Overlapping APIs**: 5 state methods with unclear distinctions (`reset`, `resetState`, `getState`, `snapshot`, `restore`).

## Target Use Case

Game UI and real-time applications where:
- All features (slices) are known at startup
- State updates are frequent (game loops, animations)
- Read path must be fast (60fps rendering)
- Cross-feature reads are needed (spin logic reads wallet balance)
- Batch transactions resolve game rounds atomically

## Public API

### `defineSlice(defaults)`

Pure declaration. Takes a defaults object, returns a `SliceDefinition`. Type inferred from defaults — no generic annotation needed.

```typescript
const wallet = defineSlice({
  balance: 1000,
  bet: 1,
  currency: 'USD',
});
```

### `createStore(defs)`

Takes a registry object mapping names to slice definitions. Returns a fully typed store. All types are inferred from the registry — slice names and their state shapes are known at compile time.

```typescript
const store = createStore({ wallet, spin });
```

### `store.handle(name)`

Returns a read/write `SliceHandle` for the named slice. Cached — same instance every call. Only accepts names present in the registry (compile error otherwise).

```typescript
const w = store.handle('wallet');
```

### `store.slice(name)`

Returns a readonly view of the named slice. Cached — same instance every call. Exposes only: `get`, `getAll`, `on`, `onChange`. No write methods at compile time or runtime.

```typescript
const ro = store.slice('spin');
ro.get('remaining');    // OK
ro.set('remaining', 0); // compile error
```

### `store.batch(fn)`

Cross-slice transaction. Defers all notifications until `fn` completes. Rolls back all state changes if `fn` throws. Nested batches run inline within the outer batch.

```typescript
store.batch(() => {
  w.set('balance', 0);
  s.set('remaining', 0);
  // notifications deferred, rollback on error
});
```

### `store.snapshot()`

Deep clone of all slice state as a plain object. For serialization (save game, persist to storage).

```typescript
const snap = store.snapshot();
localStorage.setItem('save', JSON.stringify(snap));
```

### `store.restore(data)`

Load state from a snapshot. Merges with defaults (forward compatible). Fires notifications. Batch-aware — if called inside `store.batch()`, notifications deferred and rollback applies.

```typescript
store.restore(JSON.parse(localStorage.getItem('save')));
```

### `store.reset()`

Reset all slices to defaults. Keeps subscriptions. Fires notifications. Batch-aware.

### `handle.get(key)`

Read a single field. Returns the value directly — safe because state is frozen. No cloning cost.

### `handle.getAll()`

Returns the full frozen state object. No cloning — returns the internal frozen reference directly.

### `handle.set(key, value)`

Update a single field. Creates new state via spread, deep freezes, replaces internal reference. Fires field then slice notifications (unless in batch). No-op if `Object.is(prev, value)`.

### `handle.merge(partial)`

Multi-field update. Applies all fields to one new state object, deep freezes once, fires notifications once. Self-batching — field listeners fire for each changed field, then slice listener fires once. Does not require wrapping in `store.batch()`.

```typescript
w.merge({ balance: 500, bet: 10 });
// field: balance(500, 1000)
// field: bet(10, 1)
// slice: (newState)
// All in one pass
```

### `handle.on(key, listener)`

Subscribe to a specific field. Listener receives `(value, prev)`. Returns unsubscribe function.

### `handle.onChange(listener)`

Subscribe to any change in the slice. Listener receives `(state)`. Returns unsubscribe function.

## Removed from V1

| Feature | Reason |
|---------|--------|
| Middleware | No real use case. Broken design (silent key drop, per-key execution). Validation belongs in application code. |
| Computed | Removed per user decision. Can be built in userland via `onChange`. |
| Store-level `onChange` | Expensive (clones all slices per notification). Game features subscribe to specific slices, not the whole store. |
| `resetState()` | Merged into `reset()` — one method that resets state and keeps subscriptions. |
| `getState()` | Merged into `snapshot()` — both deep clone all state, no need for two. |
| `unregister()` | All slices known upfront. No dynamic registration/unregistration. |
| `defineSlice(name, opts)` | Name comes from the registry key, not the definition. `defineSlice(defaults)` is simpler. |

## Type System

### Core Types

```typescript
interface SliceDefinition<T extends Record<string, unknown>> {
  readonly defaults: T;
}

type InferState<D> = D extends SliceDefinition<infer T> ? T : never;

type Store<D extends Record<string, SliceDefinition<any>>> = {
  handle<K extends keyof D & string>(name: K): SliceHandle<InferState<D[K]>>;
  slice<K extends keyof D & string>(name: K): ReadonlySlice<InferState<D[K]>>;
  batch(fn: () => void): void;
  snapshot(): { [K in keyof D & string]: InferState<D[K]> };
  restore(data: Partial<{ [K in keyof D & string]: Partial<InferState<D[K]>> }>): void;
  reset(): void;
};

type SliceHandle<T extends Record<string, unknown>> = {
  get<K extends keyof T & string>(key: K): T[K];
  getAll(): Readonly<T>;
  set<K extends keyof T & string>(key: K, value: T[K]): void;
  merge(partial: Partial<T>): void;
  on<K extends keyof T & string>(key: K, listener: (value: T[K], prev: T[K]) => void): () => void;
  onChange(listener: (state: Readonly<T>) => void): () => void;
};

type ReadonlySlice<T extends Record<string, unknown>> = {
  get<K extends keyof T & string>(key: K): T[K];
  getAll(): Readonly<T>;
  on<K extends keyof T & string>(key: K, listener: (value: T[K], prev: T[K]) => void): () => void;
  onChange(listener: (state: Readonly<T>) => void): () => void;
};
```

### Type Safety Guarantees

- `store.handle('unknown')` — compile error: `'unknown'` not in `keyof D`
- `store.slice('unknown')` — compile error
- `handle.get('unknown')` — compile error: `'unknown'` not in `keyof T`
- `handle.set('balance', 'string')` — compile error: `string` not assignable to `number`
- `store.restore({ unknown: {} })` — compile error
- `store.restore({ wallet: { unknown: 1 } })` — compile error

## Internal Architecture

### State Storage

Each slice stores its state as a deeply frozen plain object. State is replaced (not mutated) on every write via object spread + deep freeze.

```
createStore({ wallet, spin })
  │
  ├─ SliceHandle('wallet', deepFreeze(clone(defaults)))
  ├─ SliceHandle('spin', deepFreeze(clone(defaults)))
  └─ BatchContext (shared reference)
```

### Deep Freeze

```typescript
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}
```

Applied on: `createStore` (initial state), `set`, `merge`, `restore`, `reset`.
Not applied on: `get`, `getAll` (already frozen), `snapshot` (plain object for serialization).

### `structuredClone` Usage

Minimized to boundary operations only:

| Operation | Uses `structuredClone`? | Why |
|-----------|------------------------|-----|
| `createStore` | Yes — clone defaults once | Defensive: user's original object stays independent |
| `get` / `getAll` | No | State already frozen |
| `set` / `merge` | No | Spread + freeze |
| `snapshot` | Yes | Produce mutable plain object for serialization |
| `restore` | Yes | Clone incoming data defensively |
| `reset` | Yes | Clone original defaults |
| Batch rollback snapshot | No | Just save reference to existing frozen state |

### Write Path: `set(key, value)`

```
set(key, value)
  ├─ Object.is(prev, value)? → return (no-op)
  ├─ newState = { ...state, [key]: value }
  ├─ deepFreeze(newState)
  ├─ this.state = newState
  └─ batch active?
      ├─ YES → save prev state ref (if first mutation), track dirty + pending
      └─ NO  → flush field(key) → flush slice
```

### Write Path: `merge(partial)`

```
merge(partial)
  ├─ Filter: only keys where !Object.is(state[key], partial[key])
  ├─ No changes? → return (no-op)
  ├─ newState = { ...state, ...changedFields }
  ├─ deepFreeze(newState)
  ├─ this.state = newState
  └─ batch active?
      ├─ YES → save prev state ref, track all changed fields as pending
      └─ NO  → flush each changed field → flush slice (once)
```

### Notification Flow

**Outside batch:**

```
set('bet', 5) or merge({ bet: 5, balance: 500 })
  → field listeners for each changed key, in Object.keys order: (value, prev)
  → slice listeners: (newState)
```

**Inside batch — flush order at batch end:**

```
Per slice (in mutation order):
  1. Field listeners for each changed key: (finalValue, originalPrev)
  2. Slice listeners: (finalState)
Then next slice...
```

Multiple updates to the same field within a batch collapse: listener sees `(finalValue, originalPrev)`, fires once.

### Batch Transaction

```
store.batch(fn)
  ├─ Already in batch? → run fn() inline, return
  ├─ Set batch.active = true
  ├─ Run fn()
  │   ├─ On first mutation per slice: save reference to current frozen state
  │   ├─ Track dirty slices + pending field changes
  │   └─ On error:
  │       ├─ Restore each slice to saved reference (cheap — just reassign)
  │       ├─ Clear batch context
  │       └─ Re-throw error (zero notifications)
  ├─ Set batch.active = false
  ├─ Flush: per-slice (fields → slice), then next slice
  └─ Clear batch context
```

Rollback is cheap: frozen state objects are immutable, so restoring is just reassigning the reference. No cloning needed.

### Handle Caching

`store.handle(name)` and `store.slice(name)` return cached instances. The readonly slice is created once (lazily on first `slice()` call) and frozen.

```typescript
// Internal
private handles: Map<string, SliceHandle<any>>;       // created at createStore
private readonlyCache: Map<string, ReadonlySlice<any>>; // created lazily
```

## Error Handling

| Situation | Behavior |
|-----------|----------|
| `createStore` with non-cloneable defaults | Throw: `"Slice 'name': defaults must be structuredClone-able"` |
| `set()` same value (`Object.is`) | No-op silently |
| `merge({})` empty object | No-op silently |
| Listener throws during notification | `console.error(err)`, continue remaining listeners |
| Batch callback throws | Rollback all state, zero notifications, re-throw original error |
| Nested `store.batch()` | Run inline within outer batch |
| `restore()` with non-cloneable data | Throw: `"Slice 'name': restore data must be structuredClone-able"` |
| `restore()` with unknown slice key | Skip silently (forward compatibility) |
| `restore()` with extra fields in slice data | Keep (forward compatibility) |
| Mutate frozen state via `get()` | `TypeError` thrown by runtime (strict mode) |

## File Structure

```
src/
  index.ts          — all implementation (~250-300 lines estimated)
  index.test.ts     — test suite
```

Single file, no internal modules. Library is small enough that splitting adds complexity without benefit.

## Testing Strategy

Tests organized by feature:

1. **createStore + defineSlice** — initialization, defaults cloning, type inference verification
2. **handle.get / getAll** — read correctness, freeze verification (mutation throws)
3. **handle.set** — single field update, no-op on same value, notification firing
4. **handle.merge** — multi-field update, atomic notifications, no-op on empty/same
5. **handle.on (field)** — subscribe, unsubscribe, multiple listeners, correct prev/value
6. **handle.onChange (slice)** — fires on any field change, receives full state
7. **store.slice (readonly)** — read works, no write methods, cached instance
8. **store.batch** — deferred notifications, flush order (field→slice per-slice), rollback on error, nested inline, no-op if no changes
9. **store.snapshot / restore** — round-trip correctness, partial restore, batch-aware restore, rollback on error during batched restore
10. **store.reset** — returns to defaults, keeps subscriptions, fires notifications, batch-aware
11. **Listener error isolation** — one bad listener doesn't break others
12. **Edge cases** — batch + restore + mutations, merge inside batch, multiple slices in batch
