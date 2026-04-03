# sliced-store

Feature-sliced state management for game and real-time UI. Each feature declares its own typed state shape. The store provides full TypeScript inference, freeze-on-write safety, and batch transactions with rollback.

```
┌──────────────────────────────────────────────┐
│          createStore({ wallet, spin })        │
│                                               │
│  ┌───────────┐  ┌───────────┐                │
│  │  wallet    │  │  spin     │                │
│  │ ────────── │  │ ────────  │                │
│  │ balance    │  │ remaining │  state: frozen │
│  │ bet        │  │ total     │  reads: free   │
│  │ currency   │  │ multiplier│  writes: safe  │
│  └───────────┘  └───────────┘                │
│                                               │
│  handle('wallet')  → read + write            │
│  slice('spin')     → read only               │
│  batch(() => ...)  → atomic + rollback       │
└──────────────────────────────────────────────┘
```

## Install

```bash
npm install @duyquangnvx/sliced-store
```

## Quick start

```ts
import { defineSlice, createStore } from '@duyquangnvx/sliced-store';

// 1. Define slices
const wallet = defineSlice({ balance: 1000, bet: 1, currency: 'USD' });
const spin = defineSlice({ remaining: 5, total: 10, multiplier: 1 });

// 2. Create store — types are inferred from the registry
const store = createStore({ wallet, spin });

// 3. Read and write through typed handles
const w = store.handle('wallet');
w.get('balance');              // 1000 (typed as number)
w.set('bet', 10);
w.merge({ balance: 500, bet: 5 });
w.getAll();                    // { balance: 500, bet: 5, currency: 'USD' }

// 4. Cross-slice readonly access
const ro = store.slice('spin');
ro.get('remaining');           // 5
ro.set('remaining', 0);       // compile error — no set on readonly
```

## API

### `defineSlice(defaults)`

Pure declaration. Type is inferred from the defaults object — no generic annotation needed.

```ts
const wallet = defineSlice({ balance: 1000, bet: 1, currency: 'USD' });
```

All values must be `structuredClone`-able (no functions, Symbols, DOM nodes, etc.).

### `createStore(defs)`

Takes a registry object mapping names to slice definitions. Returns a fully typed store.

```ts
const store = createStore({ wallet, spin });
```

Throws if any slice has non-cloneable defaults.

### `store.handle(name)`

Returns a read/write `SliceHandle`. Cached — same instance every call. Only accepts names in the registry (compile error otherwise).

```ts
const w = store.handle('wallet');  // auto-inferred type
store.handle('nope');              // compile error
```

### `store.slice(name)`

Returns a **readonly** view. Cached and `Object.freeze`d. Exposes only `get`, `getAll`, `on`, `onChange` — no write methods at compile time or runtime.

```ts
const ro = store.slice('spin');
ro.get('remaining');     // OK
ro.set('remaining', 0);  // compile error
```

### `store.batch(fn)`

Batch updates across slices. All notifications fire once at the end. Rolls back on error.

```ts
store.batch(() => {
    w.set('bet', 10);
    w.set('balance', 500);
    s.set('remaining', 0);
});
// Notifications fire here, not during
```

If `fn` throws, all state mutations are **rolled back** and no notifications fire:

```ts
store.batch(() => {
    w.set('bet', 99);
    throw new Error('abort');
});
w.get('bet'); // still 1 — rolled back
```

Nested `batch()` calls run inline within the outer batch.

### `store.snapshot()` / `store.restore(data)`

Deep clone state for save/load. `restore` merges with defaults (forward compatible) and fires notifications.

```ts
const saved = store.snapshot();
localStorage.setItem('save', JSON.stringify(saved));

// Later
store.restore(JSON.parse(localStorage.getItem('save')));
```

`restore` is batch-aware — calling it inside `batch()` defers notifications and supports rollback.

### `store.reset()`

Reset all slices to defaults. Keeps subscriptions. Fires notifications. Batch-aware.

### `SliceHandle`

| Method | Description |
|--------|-------------|
| `get(key)` | Read a single field. Returns frozen value directly — zero cost |
| `getAll()` | Full frozen state object. No cloning — returns internal reference |
| `set(key, value)` | Update one field. No-op if same value (`Object.is`) |
| `merge(partial)` | Multi-field update. One notification pass (all fields then slice) |
| `on(key, cb)` | Subscribe to a field. Callback: `(value, prev)`. Returns unsubscribe fn |
| `onChange(cb)` | Subscribe to any change. Callback: `(state)`. Returns unsubscribe fn |

### `ReadonlySlice`

Returned by `store.slice()`. Same as SliceHandle but only: `get`, `getAll`, `on`, `onChange`.

## Subscriptions

```ts
// Field-level
const unsub = w.on('balance', (value, prev) => {
    console.log(`${prev} → ${value}`);
});
unsub(); // cleanup

// Slice-level
w.onChange((state) => {
    console.log('wallet changed:', state);
});
```

Notification order: field listeners first, then slice listeners. Inside a batch, notifications are grouped per-slice (fields → slice for each slice in mutation order).

A throwing listener is caught and logged via `console.error` — it does not break other listeners.

## Safety

- **Frozen state** — all state is deeply frozen on every write. `get()` returns safe references. Mutation attempts throw `TypeError`.
- **No silent corruption** — v1's `get()` returned mutable references. v2 freezes on write, so reads are always safe.
- **Batch rollback** — if `batch()` throws, all mutations are rolled back by reference (no cloning needed). Zero notifications fire.
- **Readonly handles** — `slice()` returns a runtime-frozen object with no write methods.
- **Listener isolation** — one bad listener cannot break others. Errors are caught and logged.
- **Minimal cloning** — `structuredClone` only at boundaries (init, snapshot, restore, reset). Reads and writes use spread + freeze.

## Development

```bash
npm run build        # build with tsup
npm test             # run tests with vitest
npm run test:watch   # watch mode
```

## License

ISC
