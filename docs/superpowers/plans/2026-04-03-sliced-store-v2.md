# sliced-store v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete rewrite of sliced-store with full type inference, freeze-on-write safety, and clean API.

**Architecture:** Single-file library. `defineSlice(defaults)` creates pure definitions. `createStore(defs)` takes a registry object and returns a fully typed store. State is deeply frozen on every write (spread + deepFreeze). `structuredClone` only at boundaries (init, snapshot, restore, reset). SliceHandle class holds per-slice state and subscriptions. Store is a closure over handles map and batch context.

**Tech Stack:** TypeScript 5.9, tsup (bundler), vitest (tests)

---

## File Structure

- Rewrite: `src/index.ts` — all implementation (~250 lines)
- Rewrite: `src/index.test.ts` — all tests
- Keep unchanged: `package.json`, `tsconfig.json`, `tsup.config.ts`

---

### Task 1: Foundation — types, deepFreeze, defineSlice, createStore, get/getAll

**Files:**
- Rewrite: `src/index.ts`
- Rewrite: `src/index.test.ts`

- [ ] **Step 1: Write the test file with foundation tests**

```typescript
// src/index.test.ts
import { describe, it, expect } from 'vitest';
import { defineSlice, createStore, deepFreeze } from './index.js';

// ─── Definitions ───

const walletDef = defineSlice({ balance: 1000, bet: 1, currency: 'USD' });
const spinDef = defineSlice({ remaining: 5, total: 10, multiplier: 1 });

// ─── deepFreeze ───

describe('deepFreeze', () => {
    it('freezes a flat object', () => {
        const obj = deepFreeze({ a: 1, b: 'hello' });
        expect(Object.isFrozen(obj)).toBe(true);
    });

    it('freezes nested objects recursively', () => {
        const obj = deepFreeze({ nested: { deep: { a: 1 } } });
        expect(Object.isFrozen(obj.nested)).toBe(true);
        expect(Object.isFrozen(obj.nested.deep)).toBe(true);
    });

    it('freezes arrays and their contents', () => {
        const obj = deepFreeze({ items: [{ id: 1 }] });
        expect(Object.isFrozen(obj.items)).toBe(true);
        expect(Object.isFrozen(obj.items[0])).toBe(true);
    });

    it('returns primitives unchanged', () => {
        expect(deepFreeze(42)).toBe(42);
        expect(deepFreeze('hello')).toBe('hello');
        expect(deepFreeze(null)).toBe(null);
    });
});

// ─── defineSlice ───

describe('defineSlice', () => {
    it('wraps defaults in a SliceDefinition', () => {
        const def = defineSlice({ balance: 1000, bet: 1 });
        expect(def.defaults).toEqual({ balance: 1000, bet: 1 });
    });
});

// ─── createStore + handle.get / getAll ───

describe('createStore', () => {
    it('creates a store from definitions', () => {
        const store = createStore({ wallet: walletDef });
        expect(store).toBeDefined();
    });

    it('clones defaults so mutations to original do not affect store', () => {
        const defaults = { items: [1, 2, 3] };
        const def = defineSlice(defaults);
        const store = createStore({ test: def });
        defaults.items.push(4);
        expect(store.handle('test').get('items')).toEqual([1, 2, 3]);
    });

    it('throws for non-cloneable defaults', () => {
        const def = defineSlice({ fn: (() => {}) as any });
        expect(() => createStore({ bad: def })).toThrow('structuredClone-able');
    });
});

describe('handle.get / getAll', () => {
    it('get reads a single field', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        expect(w.get('balance')).toBe(1000);
        expect(w.get('bet')).toBe(1);
        expect(w.get('currency')).toBe('USD');
    });

    it('getAll returns full state', () => {
        const store = createStore({ wallet: walletDef });
        expect(store.handle('wallet').getAll()).toEqual({ balance: 1000, bet: 1, currency: 'USD' });
    });

    it('state is deeply frozen', () => {
        const def = defineSlice({ obj: { a: 1 }, arr: [1, 2] });
        const store = createStore({ test: def });
        const h = store.handle('test');
        expect(Object.isFrozen(h.getAll())).toBe(true);
        expect(Object.isFrozen(h.get('obj'))).toBe(true);
        expect(Object.isFrozen(h.get('arr'))).toBe(true);
    });

    it('mutating get() result throws TypeError', () => {
        const def = defineSlice({ obj: { a: 1 } });
        const store = createStore({ test: def });
        const obj = store.handle('test').get('obj');
        expect(() => { (obj as any).a = 999; }).toThrow(TypeError);
    });

    it('handle is cached — same instance each call', () => {
        const store = createStore({ wallet: walletDef });
        expect(store.handle('wallet')).toBe(store.handle('wallet'));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `./index.js` does not exist yet (or has v1 exports)

- [ ] **Step 3: Write the source file with foundation implementation**

```typescript
// src/index.ts

// ─── Types ───

export interface SliceDefinition<T extends Record<string, unknown>> {
    readonly defaults: T;
}

export type InferState<D> = D extends SliceDefinition<infer T> ? T : never;

export type ReadonlySlice<T extends Record<string, unknown>> = {
    get<K extends keyof T & string>(key: K): T[K];
    getAll(): Readonly<T>;
    on<K extends keyof T & string>(key: K, listener: (value: T[K], prev: T[K]) => void): () => void;
    onChange(listener: (state: Readonly<T>) => void): () => void;
};

type FieldListener<V> = (value: V, prev: V) => void;
type SliceListener<T> = (state: Readonly<T>) => void;
type Unsubscribe = () => void;

interface BatchContext {
    active: boolean;
    snapshots: Map<string, Record<string, unknown>>;
    dirtySlices: Set<string>;
    pendingFields: Map<string, Map<string, { prev: unknown; value: unknown }>>;
}

// ─── Utilities ───

export function deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const val of Object.values(obj as Record<string, unknown>)) {
        if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    }
    return obj;
}

// ─── defineSlice ───

export function defineSlice<T extends Record<string, unknown>>(
    defaults: T,
): SliceDefinition<T> {
    return { defaults };
}

// ─── SliceHandle ───

export class SliceHandle<T extends Record<string, unknown>> {
    /** @internal */ readonly _fieldListeners = new Map<string, Set<FieldListener<unknown>>>();
    /** @internal */ readonly _sliceListeners = new Set<SliceListener<T>>();

    /** @internal */
    constructor(
        private readonly _name: string,
        private _state: T,
        private readonly _defaults: T,
        private readonly _batch: BatchContext,
    ) {}

    get<K extends keyof T & string>(key: K): T[K] {
        return this._state[key];
    }

    getAll(): Readonly<T> {
        return this._state;
    }

    /** @internal */ _getState(): T { return this._state; }
    /** @internal */ _setState(state: T): void { this._state = state; }
    /** @internal */ _getDefaults(): T { return this._defaults; }
}

// ─── createStore ───

export function createStore<D extends Record<string, SliceDefinition<any>>>(defs: D) {
    const batch: BatchContext = {
        active: false,
        snapshots: new Map(),
        dirtySlices: new Set(),
        pendingFields: new Map(),
    };

    const handles = new Map<string, SliceHandle<any>>();

    for (const [name, def] of Object.entries(defs)) {
        let clonedDefaults: Record<string, unknown>;
        try {
            clonedDefaults = structuredClone(def.defaults);
        } catch (err) {
            throw new Error(
                `Slice "${name}": defaults must be structuredClone-able`,
                { cause: err },
            );
        }
        const state = deepFreeze(structuredClone(clonedDefaults));
        handles.set(name, new SliceHandle(name, state, deepFreeze(clonedDefaults), batch));
    }

    return {
        handle<K extends keyof D & string>(name: K): SliceHandle<InferState<D[K]>> {
            return handles.get(name)! as SliceHandle<InferState<D[K]>>;
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: v2 foundation — types, deepFreeze, defineSlice, createStore, get/getAll"
```

---

### Task 2: Write + Subscribe — set, on, onChange

**Files:**
- Modify: `src/index.ts` (add methods to SliceHandle)
- Modify: `src/index.test.ts` (add test groups)

- [ ] **Step 1: Write failing tests for set, on, onChange**

Append to `src/index.test.ts` before the closing (at end of file):

```typescript
// ─── handle.set ───

describe('handle.set', () => {
    it('updates a single field', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 10);
        expect(w.get('bet')).toBe(10);
    });

    it('no-op when setting same value', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.set('bet', 1);
        expect(fn).not.toHaveBeenCalled();
    });

    it('state is frozen after set', () => {
        const store = createStore({ test: defineSlice({ obj: { a: 1 } }) });
        const h = store.handle('test');
        h.set('obj', { a: 2 });
        expect(Object.isFrozen(h.get('obj'))).toBe(true);
        expect(() => { (h.get('obj') as any).a = 999; }).toThrow(TypeError);
    });

    it('getAll returns new frozen reference after set', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const before = w.getAll();
        w.set('bet', 10);
        const after = w.getAll();
        expect(before).not.toBe(after);
        expect(Object.isFrozen(after)).toBe(true);
        expect(after).toMatchObject({ bet: 10, balance: 1000 });
    });
});

// ─── handle.on (field signals) ───

describe('handle.on (field signals)', () => {
    it('fires with value and prev', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.on('balance', fn);
        w.set('balance', 500);
        expect(fn).toHaveBeenCalledWith(500, 1000);
    });

    it('does not fire for unrelated fields', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.on('balance', fn);
        w.set('bet', 10);
        expect(fn).not.toHaveBeenCalled();
    });

    it('unsubscribe works', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        const unsub = w.on('balance', fn);
        unsub();
        w.set('balance', 500);
        expect(fn).not.toHaveBeenCalled();
    });

    it('multiple listeners on same field', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        w.on('bet', fn1);
        w.on('bet', fn2);
        w.set('bet', 5);
        expect(fn1).toHaveBeenCalledWith(5, 1);
        expect(fn2).toHaveBeenCalledWith(5, 1);
    });
});

// ─── handle.onChange (slice signal) ───

describe('handle.onChange (slice signal)', () => {
    it('fires on any field change', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.set('bet', 10);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ bet: 10, balance: 1000 });
    });

    it('does not fire when no actual change', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.set('bet', 1);
        expect(fn).not.toHaveBeenCalled();
    });

    it('notification order: field then slice', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const order: string[] = [];
        w.on('bet', () => order.push('field'));
        w.onChange(() => order.push('slice'));
        w.set('bet', 10);
        expect(order).toEqual(['field', 'slice']);
    });
});
```

Also update the import line at the top of the test file:

```typescript
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run`
Expected: FAIL — `set`, `on`, `onChange` not defined on SliceHandle

- [ ] **Step 3: Implement set, on, onChange, _flushField, _flushSlice on SliceHandle**

Add the following methods to the `SliceHandle` class in `src/index.ts`, between `getAll()` and the internal methods:

```typescript
    set<K extends keyof T & string>(key: K, value: T[K]): void {
        const prev = this._state[key];
        if (Object.is(prev, value)) return;

        const newState = deepFreeze({ ...this._state, [key]: value } as T);

        if (this._batch.active) {
            if (!this._batch.snapshots.has(this._name)) {
                this._batch.snapshots.set(this._name, this._state as Record<string, unknown>);
            }
            this._batch.dirtySlices.add(this._name);
            let fields = this._batch.pendingFields.get(this._name);
            if (!fields) {
                fields = new Map();
                this._batch.pendingFields.set(this._name, fields);
            }
            const existing = fields.get(key);
            if (existing) {
                existing.value = newState[key];
            } else {
                fields.set(key, { prev, value: newState[key] });
            }
            this._state = newState;
            return;
        }

        this._state = newState;
        this._flushField(key, newState[key], prev);
        this._flushSlice();
    }

    on<K extends keyof T & string>(key: K, listener: FieldListener<T[K]>): Unsubscribe {
        let subs = this._fieldListeners.get(key);
        if (!subs) {
            subs = new Set();
            this._fieldListeners.set(key, subs);
        }
        subs.add(listener as FieldListener<unknown>);
        return () => subs!.delete(listener as FieldListener<unknown>);
    }

    onChange(listener: SliceListener<T>): Unsubscribe {
        this._sliceListeners.add(listener);
        return () => this._sliceListeners.delete(listener);
    }

    /** @internal */
    _flushField(key: string, value: unknown, prev: unknown): void {
        const subs = this._fieldListeners.get(key);
        if (subs) {
            for (const fn of subs) fn(value, prev);
        }
    }

    /** @internal */
    _flushSlice(): void {
        for (const fn of this._sliceListeners) fn(this._state);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add set, on, onChange with field/slice notifications"
```

---

### Task 3: Multi-field write — merge

**Files:**
- Modify: `src/index.ts` (add merge to SliceHandle)
- Modify: `src/index.test.ts` (add merge tests)

- [ ] **Step 1: Write failing tests for merge**

Append to `src/index.test.ts`:

```typescript
// ─── handle.merge ───

describe('handle.merge', () => {
    it('updates multiple fields at once', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.merge({ balance: 500, bet: 5 });
        expect(w.get('balance')).toBe(500);
        expect(w.get('bet')).toBe(5);
        expect(w.get('currency')).toBe('USD');
    });

    it('fires field listeners for each changed field', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const balFn = vi.fn();
        const betFn = vi.fn();
        w.on('balance', balFn);
        w.on('bet', betFn);
        w.merge({ balance: 500, bet: 5 });
        expect(balFn).toHaveBeenCalledWith(500, 1000);
        expect(betFn).toHaveBeenCalledWith(5, 1);
    });

    it('fires slice onChange exactly once', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.merge({ balance: 500, bet: 5 });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ balance: 500, bet: 5 });
    });

    it('notification order: all fields then slice', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const order: string[] = [];
        w.on('balance', () => order.push('field:balance'));
        w.on('bet', () => order.push('field:bet'));
        w.onChange(() => order.push('slice'));
        w.merge({ balance: 500, bet: 5 });
        expect(order).toEqual(['field:balance', 'field:bet', 'slice']);
    });

    it('no-op on empty partial', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.merge({});
        expect(fn).not.toHaveBeenCalled();
    });

    it('no-op when all values are same', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        w.merge({ balance: 1000, bet: 1 });
        expect(fn).not.toHaveBeenCalled();
    });

    it('only fires for actually changed fields', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const balFn = vi.fn();
        w.on('balance', balFn);
        w.merge({ balance: 1000, bet: 5 }); // balance unchanged
        expect(balFn).not.toHaveBeenCalled();
    });

    it('state is frozen after merge', () => {
        const store = createStore({ test: defineSlice({ obj: { a: 1 }, num: 0 }) });
        const h = store.handle('test');
        h.merge({ obj: { a: 2 }, num: 5 });
        expect(Object.isFrozen(h.getAll())).toBe(true);
        expect(Object.isFrozen(h.get('obj'))).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run`
Expected: FAIL — `merge` not defined on SliceHandle

- [ ] **Step 3: Implement merge on SliceHandle**

Add the following method to the `SliceHandle` class in `src/index.ts`, after the `set` method:

```typescript
    merge(partial: Partial<T>): void {
        const changes: Array<{ key: string; prev: unknown }> = [];
        for (const key of Object.keys(partial)) {
            const prev = this._state[key as keyof T];
            const next = partial[key as keyof T];
            if (!Object.is(prev, next)) {
                changes.push({ key, prev });
            }
        }
        if (changes.length === 0) return;

        const update: Record<string, unknown> = {};
        for (const { key } of changes) {
            update[key] = partial[key as keyof T];
        }
        const newState = deepFreeze({ ...this._state, ...update } as T);

        if (this._batch.active) {
            if (!this._batch.snapshots.has(this._name)) {
                this._batch.snapshots.set(this._name, this._state as Record<string, unknown>);
            }
            this._batch.dirtySlices.add(this._name);
            let fields = this._batch.pendingFields.get(this._name);
            if (!fields) {
                fields = new Map();
                this._batch.pendingFields.set(this._name, fields);
            }
            for (const { key, prev } of changes) {
                const existing = fields.get(key);
                if (existing) {
                    existing.value = newState[key as keyof T];
                } else {
                    fields.set(key, { prev, value: newState[key as keyof T] });
                }
            }
            this._state = newState;
            return;
        }

        this._state = newState;
        for (const { key, prev } of changes) {
            this._flushField(key, newState[key as keyof T], prev);
        }
        this._flushSlice();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add merge for atomic multi-field updates"
```

---

### Task 4: Readonly access — store.slice

**Files:**
- Modify: `src/index.ts` (add slice method to createStore return)
- Modify: `src/index.test.ts` (add slice tests)

- [ ] **Step 1: Write failing tests for store.slice**

Append to `src/index.test.ts`:

```typescript
// ─── store.slice (readonly) ───

describe('store.slice (readonly)', () => {
    it('can read state via get', () => {
        const store = createStore({ wallet: walletDef });
        const ro = store.slice('wallet');
        expect(ro.get('balance')).toBe(1000);
    });

    it('can read full state via getAll', () => {
        const store = createStore({ wallet: walletDef });
        const ro = store.slice('wallet');
        expect(ro.getAll()).toEqual({ balance: 1000, bet: 1, currency: 'USD' });
    });

    it('can subscribe to field changes', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const ro = store.slice('wallet');
        const fn = vi.fn();
        ro.on('balance', fn);
        w.set('balance', 500);
        expect(fn).toHaveBeenCalledWith(500, 1000);
    });

    it('can subscribe to slice changes', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const ro = store.slice('wallet');
        const fn = vi.fn();
        ro.onChange(fn);
        w.set('bet', 10);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('has no set or merge methods', () => {
        const store = createStore({ wallet: walletDef });
        const ro = store.slice('wallet') as any;
        expect(ro.set).toBeUndefined();
        expect(ro.merge).toBeUndefined();
    });

    it('is frozen', () => {
        const store = createStore({ wallet: walletDef });
        const ro = store.slice('wallet');
        expect(Object.isFrozen(ro)).toBe(true);
    });

    it('is cached — same instance each call', () => {
        const store = createStore({ wallet: walletDef });
        expect(store.slice('wallet')).toBe(store.slice('wallet'));
    });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run`
Expected: FAIL — `slice` not defined on store

- [ ] **Step 3: Implement store.slice**

In `src/index.ts`, add a `readonlyCache` map inside `createStore` (after `handles` map), and add `slice` to the returned object.

Add after `const handles = new Map<...>()`:

```typescript
    const readonlyCache = new Map<string, ReadonlySlice<any>>();
```

Add `slice` method to the returned object, after `handle`:

```typescript
        slice<K extends keyof D & string>(name: K): ReadonlySlice<InferState<D[K]>> {
            let cached = readonlyCache.get(name);
            if (!cached) {
                const handle = handles.get(name)!;
                cached = Object.freeze({
                    get: handle.get.bind(handle),
                    getAll: handle.getAll.bind(handle),
                    on: handle.on.bind(handle),
                    onChange: handle.onChange.bind(handle),
                });
                readonlyCache.set(name, cached);
            }
            return cached as ReadonlySlice<InferState<D[K]>>;
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add store.slice for readonly cross-slice access"
```

---

### Task 5: Transactions — store.batch

**Files:**
- Modify: `src/index.ts` (add batch method to createStore return)
- Modify: `src/index.test.ts` (add batch tests)

- [ ] **Step 1: Write failing tests for store.batch**

Append to `src/index.test.ts`:

```typescript
// ─── store.batch ───

describe('store.batch', () => {
    it('defers field signals to end of batch', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const balFn = vi.fn();
        const betFn = vi.fn();
        w.on('balance', balFn);
        w.on('bet', betFn);
        store.batch(() => {
            w.set('balance', 500);
            w.set('bet', 10);
            expect(balFn).not.toHaveBeenCalled();
            expect(betFn).not.toHaveBeenCalled();
        });
        expect(balFn).toHaveBeenCalledWith(500, 1000);
        expect(betFn).toHaveBeenCalledWith(10, 1);
    });

    it('defers slice onChange to end of batch', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        store.batch(() => {
            w.set('bet', 10);
            w.set('balance', 500);
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ bet: 10, balance: 500 });
    });

    it('flush order: field then slice, per-slice', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        const order: string[] = [];
        w.on('bet', () => order.push('wallet:field'));
        w.onChange(() => order.push('wallet:slice'));
        s.on('remaining', () => order.push('spin:field'));
        s.onChange(() => order.push('spin:slice'));
        store.batch(() => {
            w.set('bet', 10);
            s.set('remaining', 0);
        });
        expect(order).toEqual([
            'wallet:field', 'wallet:slice',
            'spin:field', 'spin:slice',
        ]);
    });

    it('multiple updates to same field: fires once with final value and original prev', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.on('bet', fn);
        store.batch(() => {
            w.set('bet', 5);
            w.set('bet', 10);
            w.set('bet', 20);
        });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(20, 1);
    });

    it('nested batch runs inline', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        store.batch(() => {
            store.batch(() => {
                w.set('bet', 10);
            });
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('no-op if no changes in batch', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        store.batch(() => {
            // no mutations
        });
        expect(fn).not.toHaveBeenCalled();
    });

    it('rolls back state on error', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        expect(() => {
            store.batch(() => {
                w.set('bet', 99);
                w.set('balance', 0);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(w.get('bet')).toBe(1);
        expect(w.get('balance')).toBe(1000);
    });

    it('rolls back multiple slices on error', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        expect(() => {
            store.batch(() => {
                w.set('bet', 99);
                s.set('remaining', 0);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(w.get('bet')).toBe(1);
        expect(s.get('remaining')).toBe(5);
    });

    it('fires zero signals on rollback', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        w.on('bet', fieldFn);
        w.onChange(sliceFn);
        expect(() => {
            store.batch(() => {
                w.set('bet', 99);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(fieldFn).not.toHaveBeenCalled();
        expect(sliceFn).not.toHaveBeenCalled();
    });

    it('store is usable after rollback', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        expect(() => {
            store.batch(() => {
                w.set('bet', 99);
                throw new Error('abort');
            });
        }).toThrow('abort');
        w.set('bet', 5);
        expect(w.get('bet')).toBe(5);
    });

    it('merge inside batch defers notifications', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        store.batch(() => {
            w.merge({ balance: 500, bet: 10 });
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run`
Expected: FAIL — `batch` not defined on store

- [ ] **Step 3: Implement store.batch**

Add `batch` method to the returned object in `createStore` in `src/index.ts`:

```typescript
        batch(fn: () => void): void {
            if (batch.active) {
                fn();
                return;
            }

            batch.active = true;
            batch.snapshots.clear();
            batch.dirtySlices.clear();
            batch.pendingFields.clear();

            try {
                fn();
            } catch (err) {
                for (const [name, snapshot] of batch.snapshots) {
                    const handle = handles.get(name);
                    if (handle) handle._setState(snapshot as any);
                }
                batch.active = false;
                batch.snapshots.clear();
                batch.dirtySlices.clear();
                batch.pendingFields.clear();
                throw err;
            }

            batch.active = false;

            // Flush: per-slice (fields → slice)
            for (const [name, fields] of batch.pendingFields) {
                const handle = handles.get(name);
                if (handle) {
                    for (const [key, { value, prev }] of fields) {
                        handle._flushField(key, value, prev);
                    }
                    handle._flushSlice();
                }
            }

            batch.snapshots.clear();
            batch.dirtySlices.clear();
            batch.pendingFields.clear();
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add store.batch with deferred notifications and rollback"
```

---

### Task 6: Persistence — snapshot, restore, reset

**Files:**
- Modify: `src/index.ts` (add snapshot, restore, reset, notifySliceChanges helper)
- Modify: `src/index.test.ts` (add persistence tests)

- [ ] **Step 1: Write failing tests for snapshot, restore, reset**

Append to `src/index.test.ts`:

```typescript
// ─── store.snapshot / restore ───

describe('store.snapshot / restore', () => {
    it('snapshot returns deep cloned state', () => {
        const store = createStore({ test: defineSlice({ items: [1, 2] }) });
        const h = store.handle('test');
        const snap = store.snapshot();
        h.set('items', [3, 4]);
        expect((snap as any).test.items).toEqual([1, 2]);
    });

    it('snapshot is not frozen (for serialization)', () => {
        const store = createStore({ wallet: walletDef });
        const snap = store.snapshot();
        expect(Object.isFrozen(snap)).toBe(false);
    });

    it('restore round-trips through snapshot', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 50);
        const snap = store.snapshot();
        w.set('bet', 99);
        store.restore(snap);
        expect(w.get('bet')).toBe(50);
    });

    it('restore fires field signals', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.on('bet', fn);
        store.restore({ wallet: { balance: 1000, bet: 50, currency: 'USD' } });
        expect(fn).toHaveBeenCalledWith(50, 1);
    });

    it('restore fires slice onChange', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn = vi.fn();
        w.onChange(fn);
        store.restore({ wallet: { balance: 500 } });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('restore state is frozen', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        store.restore({ wallet: { balance: 500, bet: 10, currency: 'EUR' } });
        expect(Object.isFrozen(w.getAll())).toBe(true);
    });

    it('restore skips unknown slice keys', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        store.restore({ unknown: { x: 1 } } as any);
        expect(w.get('balance')).toBe(1000); // unchanged
    });

    it('restore merges with defaults (forward compatible)', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        store.restore({ wallet: { bet: 50 } }); // only bet, rest from defaults
        expect(w.get('bet')).toBe(50);
        expect(w.get('balance')).toBe(1000); // from defaults
        expect(w.get('currency')).toBe('USD'); // from defaults
    });

    it('restore throws for non-cloneable data', () => {
        const store = createStore({ wallet: walletDef });
        expect(() => {
            store.restore({ wallet: { balance: 1, bet: 1, currency: 'X', bad: () => {} } } as any);
        }).toThrow('structuredClone-able');
    });

    it('restore is batch-aware — defers signals', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        w.on('bet', fieldFn);
        w.onChange(sliceFn);
        store.batch(() => {
            store.restore({ wallet: { balance: 500, bet: 50, currency: 'EUR' } });
            expect(fieldFn).not.toHaveBeenCalled();
            expect(sliceFn).not.toHaveBeenCalled();
        });
        expect(fieldFn).toHaveBeenCalled();
        expect(sliceFn).toHaveBeenCalledTimes(1);
    });

    it('restore rolls back on error when inside batch', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        expect(() => {
            store.batch(() => {
                store.restore({ wallet: { balance: 0, bet: 0, currency: 'X' } });
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(w.get('balance')).toBe(1000);
        expect(w.get('bet')).toBe(1);
    });
});

// ─── store.reset ───

describe('store.reset', () => {
    it('resets all slices to defaults', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        w.set('bet', 99);
        s.set('remaining', 0);
        store.reset();
        expect(w.get('bet')).toBe(1);
        expect(s.get('remaining')).toBe(5);
    });

    it('keeps subscriptions', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 99);
        const fn = vi.fn();
        w.onChange(fn);
        store.reset();
        expect(fn).toHaveBeenCalledTimes(1);
        // Subscription still active after reset
        w.set('bet', 5);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('fires field signals on reset', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 50);
        const fn = vi.fn();
        w.on('bet', fn);
        fn.mockClear();
        store.reset();
        expect(fn).toHaveBeenCalledWith(1, 50);
    });

    it('state is frozen after reset', () => {
        const store = createStore({ test: defineSlice({ obj: { a: 1 } }) });
        const h = store.handle('test');
        h.set('obj', { a: 99 });
        store.reset();
        expect(Object.isFrozen(h.getAll())).toBe(true);
        expect(Object.isFrozen(h.get('obj'))).toBe(true);
    });

    it('is batch-aware — defers signals', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 50);
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        w.on('bet', fieldFn);
        w.onChange(sliceFn);
        fieldFn.mockClear();
        sliceFn.mockClear();
        store.batch(() => {
            store.reset();
            expect(fieldFn).not.toHaveBeenCalled();
            expect(sliceFn).not.toHaveBeenCalled();
        });
        expect(fieldFn).toHaveBeenCalledWith(1, 50);
        expect(sliceFn).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run`
Expected: FAIL — `snapshot`, `restore`, `reset` not defined on store

- [ ] **Step 3: Implement snapshot, restore, reset**

In `src/index.ts`, add a `notifySliceChanges` helper inside `createStore` (after the handles initialization loop, before the return statement):

```typescript
    function notifySliceChanges(
        name: string,
        handle: SliceHandle<any>,
        oldState: Record<string, unknown>,
    ): void {
        const newState = handle._getState() as Record<string, unknown>;
        const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

        if (batch.active) {
            batch.dirtySlices.add(name);
            let fields = batch.pendingFields.get(name);
            if (!fields) {
                fields = new Map();
                batch.pendingFields.set(name, fields);
            }
            for (const key of allKeys) {
                if (!Object.is(oldState[key], newState[key])) {
                    const existing = fields.get(key);
                    if (existing) {
                        existing.value = newState[key];
                    } else {
                        fields.set(key, { prev: oldState[key], value: newState[key] });
                    }
                }
            }
        } else {
            for (const key of allKeys) {
                if (!Object.is(oldState[key], newState[key])) {
                    handle._flushField(key, newState[key], oldState[key]);
                }
            }
            handle._flushSlice();
        }
    }
```

Then add `snapshot`, `restore`, `reset` to the returned object:

```typescript
        snapshot(): { [K in keyof D & string]: InferState<D[K]> } {
            const result: Record<string, unknown> = {};
            for (const [name, handle] of handles) {
                result[name] = structuredClone(handle._getState());
            }
            return result as { [K in keyof D & string]: InferState<D[K]> };
        },

        restore(data: Partial<{ [K in keyof D & string]: Partial<InferState<D[K]>> }>): void {
            for (const [name, sliceData] of Object.entries(data)) {
                const handle = handles.get(name);
                if (!handle || typeof sliceData !== 'object' || sliceData === null) continue;

                const oldState = handle._getState() as Record<string, unknown>;

                if (batch.active && !batch.snapshots.has(name)) {
                    batch.snapshots.set(name, oldState);
                }

                let clonedData: Record<string, unknown>;
                try {
                    clonedData = structuredClone(sliceData) as Record<string, unknown>;
                } catch (err) {
                    throw new Error(
                        `Slice "${name}": restore data must be structuredClone-able`,
                        { cause: err },
                    );
                }

                const newState = deepFreeze({
                    ...structuredClone(handle._getDefaults()),
                    ...clonedData,
                });
                handle._setState(newState as any);
                notifySliceChanges(name, handle, oldState);
            }
        },

        reset(): void {
            for (const [name, handle] of handles) {
                const oldState = handle._getState() as Record<string, unknown>;

                if (batch.active && !batch.snapshots.has(name)) {
                    batch.snapshots.set(name, oldState);
                }

                const newState = deepFreeze(structuredClone(handle._getDefaults()));
                handle._setState(newState as any);
                notifySliceChanges(name, handle, oldState);
            }
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add snapshot, restore, reset for persistence"
```

---

### Task 7: Hardening — listener error isolation + edge cases

**Files:**
- Modify: `src/index.ts` (add try/catch in _flushField, _flushSlice)
- Modify: `src/index.test.ts` (add error isolation and edge case tests)

- [ ] **Step 1: Write failing tests for error isolation and edge cases**

Append to `src/index.test.ts`:

```typescript
// ─── Listener error isolation ───

describe('listener error isolation', () => {
    it('bad field listener does not break other field listeners', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn1 = vi.fn(() => { throw new Error('boom'); });
        const fn2 = vi.fn();
        w.on('bet', fn1);
        w.on('bet', fn2);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        w.set('bet', 10);
        expect(fn1).toHaveBeenCalled();
        expect(fn2).toHaveBeenCalledWith(10, 1);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('bad field listener does not break slice listener', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.on('bet', () => { throw new Error('boom'); });
        const sliceFn = vi.fn();
        w.onChange(sliceFn);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        w.set('bet', 10);
        expect(sliceFn).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('bad slice listener does not break other slice listeners', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const fn1 = vi.fn(() => { throw new Error('boom'); });
        const fn2 = vi.fn();
        w.onChange(fn1);
        w.onChange(fn2);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        w.set('bet', 10);
        expect(fn1).toHaveBeenCalled();
        expect(fn2).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

// ─── Edge cases ───

describe('edge cases', () => {
    it('batch + restore + additional mutations', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        const walletFn = vi.fn();
        const spinFn = vi.fn();
        w.on('bet', walletFn);
        s.on('remaining', spinFn);
        store.batch(() => {
            store.restore({ wallet: { balance: 200, bet: 20, currency: 'EUR' } });
            s.set('remaining', 1);
        });
        expect(w.get('bet')).toBe(20);
        expect(s.get('remaining')).toBe(1);
        expect(walletFn).toHaveBeenCalledWith(20, 1);
        expect(spinFn).toHaveBeenCalledWith(1, 5);
    });

    it('readonly slice updates when handle writes', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        const ro = store.slice('wallet');
        const fn = vi.fn();
        ro.on('bet', fn);
        w.set('bet', 100);
        expect(ro.get('bet')).toBe(100);
        expect(fn).toHaveBeenCalledWith(100, 1);
    });

    it('multiple slices in batch with field listeners', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        const wBet = vi.fn();
        const sRem = vi.fn();
        w.on('bet', wBet);
        s.on('remaining', sRem);
        store.batch(() => {
            w.set('bet', 10);
            s.set('remaining', 0);
        });
        expect(wBet).toHaveBeenCalledWith(10, 1);
        expect(sRem).toHaveBeenCalledWith(0, 5);
    });

    it('deep rollback for nested objects', () => {
        const store = createStore({ test: defineSlice({ obj: { a: 1, b: 2 } }) });
        const h = store.handle('test');
        expect(() => {
            store.batch(() => {
                h.set('obj', { a: 99, b: 99 });
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(h.get('obj')).toEqual({ a: 1, b: 2 });
    });

    it('merge inside batch with rollback', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        expect(() => {
            store.batch(() => {
                w.merge({ balance: 0, bet: 99 });
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(w.get('balance')).toBe(1000);
        expect(w.get('bet')).toBe(1);
    });

    it('set after reset works normally', () => {
        const store = createStore({ wallet: walletDef });
        const w = store.handle('wallet');
        w.set('bet', 99);
        store.reset();
        w.set('bet', 5);
        expect(w.get('bet')).toBe(5);
    });

    it('restore with partial data preserves other defaults', () => {
        const store = createStore({ wallet: walletDef, spin: spinDef });
        const w = store.handle('wallet');
        const s = store.handle('spin');
        w.set('bet', 50);
        s.set('remaining', 0);
        store.restore({ wallet: { balance: 999 } });
        // wallet: restored with partial (bet from defaults, balance from restore)
        expect(w.get('balance')).toBe(999);
        expect(w.get('bet')).toBe(1); // from defaults
        // spin: untouched
        expect(s.get('remaining')).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify error isolation tests fail**

Run: `npx vitest run`
Expected: FAIL — listener errors propagate and break chain (no try/catch yet)

- [ ] **Step 3: Add try/catch to _flushField and _flushSlice**

In `src/index.ts`, modify the `_flushField` method in the `SliceHandle` class:

Replace:
```typescript
    _flushField(key: string, value: unknown, prev: unknown): void {
        const subs = this._fieldListeners.get(key);
        if (subs) {
            for (const fn of subs) fn(value, prev);
        }
    }
```

With:
```typescript
    _flushField(key: string, value: unknown, prev: unknown): void {
        const subs = this._fieldListeners.get(key);
        if (subs) {
            for (const fn of subs) {
                try { fn(value, prev); } catch (e) { console.error(e); }
            }
        }
    }
```

Modify the `_flushSlice` method:

Replace:
```typescript
    _flushSlice(): void {
        for (const fn of this._sliceListeners) fn(this._state);
    }
```

With:
```typescript
    _flushSlice(): void {
        for (const fn of this._sliceListeners) {
            try { fn(this._state); } catch (e) { console.error(e); }
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 5: Build and verify the package compiles**

Run: `npx tsup`
Expected: Build succeeds, outputs `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: v2 complete — listener error isolation and edge cases"
```
