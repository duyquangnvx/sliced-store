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
npm install sliced-store
```

## Quick start

```ts
import { SlicedStore, defineSlice } from 'sliced-store';

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
wallet.update({ balance: 500, bet: 5 });
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

Get a **readonly** handle to another slice for cross-feature reads. The returned object is `Object.freeze`d with no `set` or `update` methods.

```ts
const walletView = store.slice<WalletState>('wallet');
walletView.get('balance');  // works
walletView.set('bet', 10);  // TypeError — property doesn't exist
```

#### `batch(fn)`

Batch multiple updates. All signals (field, slice, global) fire once at the end.

```ts
store.batch(() => {
    wallet.set('bet', 10);
    wallet.set('balance', 500);
    spin.set('remaining', 0);
});
// One set of signals fires here, not three
```

If `fn` throws, all state mutations are **rolled back** and no signals fire:

```ts
store.batch(() => {
    wallet.set('bet', 99);
    throw new Error('abort');
});
wallet.get('bet'); // still 1 — rolled back
```

Nested `batch()` calls run inline within the outer batch.

#### `getFullState()`

Returns a frozen object with all slices namespaced by name.

```ts
store.getFullState();
// { wallet: { balance: 1000, bet: 1 }, spin: { remaining: 5, ... } }
```

#### `snapshot()` / `restore(data)`

Deep clone state for save/load. `restore` fires field and slice signals.

```ts
const saved = store.snapshot();
// ... later
store.restore(saved);
```

Both methods are batch-aware — calling `restore` inside `batch()` defers signals.

#### `resetState()`

Reset all slices to their defaults. Subscriptions are preserved. Batch-aware.

#### `reset()`

Reset all slices to defaults **and** clear all subscriptions.

#### `unregister(name)`

Remove a slice and clear its subscriptions.

#### `onChange`

Global signal that fires when any slice changes. Payload is the full merged state.

```ts
store.onChange.add((fullState) => {
    console.log('Something changed:', fullState);
});
```

### `SliceHandle`

The typed handle returned by `register()`.

| Method | Description |
|--------|-------------|
| `get(key)` | Get a single field value (cloned for objects) |
| `getAll()` | Get full slice state snapshot (deep clone) |
| `set(key, value)` | Set a single field |
| `update(partial)` | Merge partial state |
| `on(key, callback)` | Subscribe to a field. Returns unsubscribe fn. Callback receives `(value, prev)` |
| `onChange` | Signal that fires on any field change in this slice |
| `computed(fn)` | Create a derived signal (see below) |
| `name` | The slice name |

### Field subscriptions

```ts
const unsub = wallet.on('balance', (value, prev) => {
    console.log(`Balance changed: ${prev} → ${value}`);
});

// Later
unsub();
```

### Computed signals

Derived values that only emit when the computed result actually changes.

```ts
const isRich = wallet.computed((state) => state.balance > 500);

isRich.value;  // current value: true

isRich.add((val) => console.log('Rich status:', val));

// Clean up when done
isRich.dispose();
```

`dispose()` detaches from the source signal and clears all listeners. After disposal, `add()` and `once()` throw, `emit()` is a no-op.

### Middleware

Middleware intercepts updates before they are applied. Each middleware receives the current state and incoming partial, and can transform or block the update.

```ts
const balanceGuard: SliceMiddleware<WalletState> = (current, incoming) => {
    // Prevent negative balance
    if (incoming.balance !== undefined && incoming.balance < 0) {
        return { ...incoming, balance: 0 };
    }
    return incoming;
};

// Return null to block the update entirely
const freezeBet: SliceMiddleware<WalletState> = (current, incoming) => {
    if (incoming.bet !== undefined) return null;
    return incoming;
};

const slice = defineSlice('wallet', {
    defaults: { balance: 1000, bet: 1 },
    middleware: [balanceGuard, freezeBet],  // runs in order
});
```

Middleware errors are wrapped with context (middleware name, slice name, original error as `cause`).

### Signal

Lightweight pub/sub primitive used internally and exported for direct use.

```ts
import { Signal } from 'sliced-store';

const signal = new Signal<number>();

const binding = signal.add((value) => console.log(value));
signal.once((value) => console.log('First only:', value));
signal.emit(42);

binding.detach();  // or binding.dispose()
signal.clear();    // remove all listeners
```

Error isolation: if a listener throws, all remaining listeners still run. The first error is re-thrown after all listeners have been called.

## Safety guarantees

- **Defensive cloning** — all values are `structuredClone`d at boundaries (register, set, update, get, getAll, restore, snapshot, reset). External code cannot silently mutate internal store state.
- **Batch rollback** — if `batch()` throws, all mutations are rolled back using deep snapshots. No signals fire.
- **Readonly handles** — `slice()` returns a runtime-frozen object with no write methods.
- **Middleware isolation** — errors include middleware name/index, slice name, and the original error as `cause`.
- **Signal error isolation** — one throwing listener does not prevent others from running.
- **ComputedSignal guards** — `add`/`once` throw after disposal, `emit` is a no-op.

## Development

```bash
npm run build        # build with tsup
npm test             # run tests with vitest
npm run test:watch   # watch mode
```

## License

ISC
