# sliced-store

Centralized state management with feature-owned slices. Each feature declares its own typed state shape, defaults, and optional middleware. The central store merges everything but each feature only accesses its own scoped handle.

```
┌─────────────────────────────────────────────────┐
│                  SlicedStore                     │
│  ┌───────────┐ ┌───────────┐ ┌───────────────┐  │
│  │  wallet   │ │ freeSpin  │ │  bonusPick    │  │
│  │ ───────── │ │ ───────── │ │ ───────────── │  │
│  │ balance   │ │ remaining │ │ picks         │  │
│  │ currency  │ │ total     │ │ revealed      │  │
│  │ bet       │ │ multiplier│ │ totalWin      │  │
│  └───────────┘ └───────────┘ └───────────────┘  │
│                                                  │
│  onChange ──→ full state (all slices)            │
│  slice.onChange ──→ only that slice's data       │
└─────────────────────────────────────────────────┘
```

## Install

```bash
npm install @duyquangnvx/sliced-store
```

## Quick start

```ts
import { SlicedStore, defineSlice } from '@duyquangnvx/sliced-store';

// 1. Define slices (each feature owns its shape)
const walletSlice = defineSlice('wallet', {
    defaults: { balance: 1000, bet: 1 },
});

const spinSlice = defineSlice('spin', {
    defaults: { remaining: 5, multiplier: 1 },
});

// 2. Create store and register
const store = new SlicedStore();
const wallet = store.register(walletSlice);
const spin = store.register(spinSlice);

// 3. Read and write through typed handles
wallet.get('balance');    // 1000 (typed as number)
wallet.set('bet', 10);
wallet.batch({ balance: 500, bet: 5 });
wallet.getAll();          // { balance: 500, bet: 5 }
```

## API

### `defineSlice(name, config)`

Pure data declaration for a slice. No side effects.

```ts
const slice = defineSlice('wallet', {
    defaults: { balance: 1000, bet: 1 },
    middleware: [balanceGuard],  // optional
});
```

All `defaults` values must be `structuredClone`-able (no functions, Symbols, DOM nodes, etc.).

### `SlicedStore`

#### `register(definition)`

Register a slice and get back a typed `SliceHandle`.

```ts
const wallet = store.register(walletSlice);
```

Throws if a slice with the same name is already registered.

#### `slice(name)`

Get a **readonly** handle to another slice. The returned object is `Object.freeze`d with read and subscribe methods only (`get`, `getAll`, `on`, `onChange`, `computed`, `name`) — no `set` or `batch`.

```ts
const walletView = store.slice<WalletState>('wallet');
walletView.get('balance');  // works
walletView.set('bet', 10);  // TypeError — property doesn't exist
```

#### `batch(fn)`

Batch multiple updates. All notifications (field, slice, global) fire once at the end.

```ts
store.batch(() => {
    wallet.set('bet', 10);
    wallet.set('balance', 500);
    spin.set('remaining', 0);
});
// One set of notifications fires here, not three
```

If `fn` throws, all state mutations are **rolled back** and no notifications fire:

```ts
store.batch(() => {
    wallet.set('bet', 99);
    throw new Error('abort');
});
wallet.get('bet'); // still 1 — rolled back
```

Nested `batch()` calls run inline within the outer batch.

#### `getState()`

Returns a frozen, deep-cloned object with all slices namespaced by name.

```ts
store.getState();
// { wallet: { balance: 1000, bet: 1 }, spin: { remaining: 5, ... } }
```

#### `snapshot()` / `restore(data)`

Deep clone state for save/load. `restore` fires field and slice notifications.

```ts
const saved = store.snapshot();
// ... later
store.restore(saved);
```

Both methods are batch-aware — calling `restore` inside `batch()` defers notifications.

#### `resetState()`

Reset all slices to their defaults. Subscriptions are preserved. Batch-aware.

#### `reset()`

Reset all slices to defaults **and** clear all subscriptions (including store-level listeners).

#### `unregister(name)`

Remove a slice and clear its subscriptions.

#### `has(name)`

Check if a slice is registered. Returns `boolean`.

#### `sliceNames`

Getter that returns an array of all registered slice names.

```ts
store.sliceNames; // ['wallet', 'spin']
```

#### `onChange(listener)`

Subscribe to changes across all slices. Callback receives the full merged state. Returns an unsubscribe function.

```ts
const unsub = store.onChange((fullState) => {
    console.log('Something changed:', fullState);
});

// Later
unsub();
```

### `SliceHandle`

The typed handle returned by `register()`.

| Method | Description |
|--------|-------------|
| `get(key)` | Get a single field value |
| `getAll()` | Get full slice state snapshot (deep clone) |
| `set(key, value)` | Set a single field. Returns `false` if rejected by middleware |
| `batch(partial)` | Set multiple fields. Returns array of rejected keys |
| `reset()` | Reset all fields to their defaults via `set()` |
| `on(key, callback)` | Subscribe to a field. Returns unsubscribe fn. Callback receives `(value, prev)` |
| `onChange(callback)` | Subscribe to any field change in this slice. Returns unsubscribe fn |
| `computed(fn)` | Create a derived value (see below) |
| `name` | The slice name |

### Field subscriptions

```ts
const unsub = wallet.on('balance', (value, prev) => {
    console.log(`Balance changed: ${prev} → ${value}`);
});

// Later
unsub();
```

### Computed values

Derived values that only notify when the computed result actually changes.

```ts
const isRich = wallet.computed((state) => state.balance > 500);

isRich.value;  // current value: true

const unsub = isRich.onChange((val) => console.log('Rich status:', val));

// Clean up when done
isRich.dispose();
```

`dispose()` detaches from the source and clears all listeners. After disposal, `onChange()` throws and `isDisposed` returns `true`.

### Middleware

Middleware intercepts updates before they are applied. Each middleware receives the current state and incoming partial, and can transform or block the update.

```ts
const balanceGuard: Middleware<WalletState> = (current, incoming) => {
    // Prevent negative balance
    if (incoming.balance !== undefined && incoming.balance < 0) {
        return { ...incoming, balance: 0 };
    }
    return incoming;
};

// Return null to block the update entirely
const freezeBet: Middleware<WalletState> = (current, incoming) => {
    if (incoming.bet !== undefined) return null;
    return incoming;
};

const slice = defineSlice('wallet', {
    defaults: { balance: 1000, bet: 1 },
    middleware: [balanceGuard, freezeBet],  // runs in order
});
```

Middleware errors are wrapped with context (middleware name, slice name, original error as `cause`).

## Safety guarantees

- **Defensive cloning** — defaults are `structuredClone`d at registration. `getAll()`, `getState()`, `snapshot()`, `restore()`, and `resetState()` deep-clone at boundaries. External code cannot silently mutate internal store state through these methods.
- **Batch rollback** — if `batch()` throws, all mutations are rolled back using deep snapshots. No notifications fire.
- **Readonly handles** — `slice()` returns a runtime-frozen object with no write methods.
- **Middleware isolation** — errors include middleware name/index, slice name, and the original error as `cause`.
- **Computed guards** — `onChange()` throws after disposal, `isDisposed` indicates state.

## Development

```bash
npm run build        # build with tsup
npm test             # run tests with vitest
npm run test:watch   # watch mode
```

## License

ISC
