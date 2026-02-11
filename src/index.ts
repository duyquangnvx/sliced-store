/**
 * SlicedStore - Centralized store with feature-owned slices
 *
 * Pattern: Each feature declares its own state shape, defaults,
 * and optional middleware. The central store merges everything
 * but each feature only accesses its own typed slice.
 *
 * ┌─────────────────────────────────────────────────┐
 * │                  SlicedStore                     │
 * │  ┌───────────┐ ┌───────────┐ ┌───────────────┐  │
 * │  │  wallet   │ │ freeSpin  │ │  bonusPick    │  │
 * │  │ ───────── │ │ ───────── │ │ ───────────── │  │
 * │  │ balance   │ │ remaining │ │ picks         │  │
 * │  │ currency  │ │ total     │ │ revealed      │  │
 * │  │ bet       │ │ multiplier│ │ totalWin      │  │
 * │  └───────────┘ └───────────┘ └───────────────┘  │
 * │                                                  │
 * │  onChange ──→ full state (all slices)            │
 * │  slice.onChange ──→ only that slice's data       │
 * └─────────────────────────────────────────────────┘
 *
 * @example
 * // Feature defines its slice
 * const walletSlice = defineSlice('wallet', {
 *     defaults: { balance: 1000, bet: 1 },
 *     middleware: [balanceGuard],
 * });
 *
 * // Register into central store
 * const store = new SlicedStore();
 * const wallet = store.register(walletSlice);
 *
 * // Feature uses its own typed handle
 * wallet.get('balance');              // number (typed)
 * wallet.set('bet', 10);             // only wallet keys allowed
 * wallet.on('balance', (v) => ...);  // field-level subscribe
 *
 * // Cross-feature read (explicit)
 * store.slice('freeSpin').get('remaining');
 */

import { Signal, ComputedSignal } from './lib/signal.js';

export { Signal, ComputedSignal } from './lib/signal.js';
export type { SignalBinding } from './lib/signal.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SliceState = Record<string, unknown>;

export type SliceMiddleware<T extends SliceState> = (
    current: Readonly<T>,
    incoming: Partial<T>,
) => Partial<T> | null;

export interface SliceDefinition<N extends string, T extends SliceState> {
    name: N;
    /**
     * Default values for the slice state.
     * Must be structuredClone-able — no functions, Symbols, DOM nodes, etc.
     */
    defaults: T;
    middleware?: SliceMiddleware<T>[];
}

/** Typed handle a feature uses to interact with its own slice */
export interface SliceHandle<T extends SliceState> {
    /** Get a single field */
    get<K extends keyof T & string>(key: K): T[K];

    /** Get full slice state snapshot */
    getAll(): Readonly<T>;

    /** Update with partial values */
    update(partial: Partial<T>): void;

    /** Set a single field */
    set<K extends keyof T & string>(key: K, value: T[K]): void;

    /** Subscribe to a specific field change. Returns unsubscribe fn. */
    on<K extends keyof T & string>(
        key: K,
        callback: (value: T[K], prev: T[K]) => void,
    ): () => void;

    /** Signal that fires when any field in this slice changes */
    readonly onChange: Signal<Readonly<T>>;

    /** Computed derived signal scoped to this slice. Call `.dispose()` to detach. */
    computed<R>(fn: (state: Readonly<T>) => R): ComputedSignal<R>;

    /** Slice name */
    readonly name: string;
}

type FieldSignalPayload<T, K extends keyof T> = { value: T[K]; prev: T[K] };

// ─── Define ──────────────────────────────────────────────────────────────────

/**
 * Define a slice — called by each feature module.
 * This is a pure data declaration, no side effects.
 */
export function defineSlice<N extends string, T extends SliceState>(
    name: N,
    config: Omit<SliceDefinition<N, T>, 'name'>,
): SliceDefinition<N, T> {
    return { name, ...config };
}

// ─── Sliced Store ────────────────────────────────────────────────────────────

// Internal record for a registered slice
interface SliceRecord {
    definition: SliceDefinition<string, SliceState>;
    state: SliceState;
    signal: Signal<Readonly<SliceState>>;
    fieldSignals: Map<string, Signal<unknown>>;
    middleware: SliceMiddleware<SliceState>[];
}

export class SlicedStore {
    private readonly _slices = new Map<string, SliceRecord>();
    private _batching = false;
    private _batchDirtySlices = new Set<string>();
    private _batchPendingFields = new Map<string, Map<string, { value: unknown; prev: unknown }>>();
    private _batchSnapshot = new Map<string, SliceState>();

    /** Fires when ANY slice changes. Payload = full merged state of all slices. */
    readonly onChange = new Signal<Readonly<Record<string, unknown>>>();

    // ─── Register ────────────────────────────────────────────────────────

    /**
     * Register a feature's slice into the store.
     * Returns a typed handle scoped to that slice.
     *
     * @throws if a slice with the same name is already registered
     */
    register<N extends string, T extends SliceState>(
        definition: SliceDefinition<N, T>,
    ): SliceHandle<T> {
        if (this._slices.has(definition.name)) {
            throw new Error(`Slice "${definition.name}" is already registered`);
        }

        let clonedDefaults: SliceState;
        try {
            clonedDefaults = structuredClone(definition.defaults);
        } catch (err) {
            throw new Error(
                `Slice "${definition.name}": defaults must be structuredClone-able (no functions, Symbols, DOM nodes, etc.)`,
                { cause: err },
            );
        }

        const record: SliceRecord = {
            definition: definition as SliceDefinition<string, SliceState>,
            state: clonedDefaults,
            signal: new Signal<Readonly<SliceState>>(),
            fieldSignals: new Map(),
            middleware: (definition.middleware ?? []) as SliceMiddleware<SliceState>[],
        };

        this._slices.set(definition.name, record);

        return this._createHandle<T>(definition.name);
    }

    // ─── Cross-feature access ────────────────────────────────────────────

    /**
     * Get a readonly handle to another slice (for cross-feature reads).
     * The returned handle can read and subscribe but NOT write.
     */
    slice<T extends SliceState = SliceState>(name: string): Readonly<Pick<SliceHandle<T>, 'get' | 'getAll' | 'on' | 'onChange' | 'computed' | 'name'>> {
        const record = this._slices.get(name);
        if (!record) {
            throw new Error(`Slice "${name}" is not registered`);
        }
        return this._createReadonlyHandle<T>(name);
    }

    // ─── Batch ───────────────────────────────────────────────────────────

    /**
     * Batch updates across one or multiple slices.
     * All slice-level and global onChange fire once at the end.
     */
    batch(fn: () => void): void {
        if (this._batching) {
            fn();
            return;
        }

        this._batching = true;
        this._batchDirtySlices.clear();
        this._batchPendingFields.clear();
        this._batchSnapshot.clear();

        try {
            fn();
        } catch (err) {
            // Rollback all snapshotted slices to pre-batch state
            for (const [name, snapshot] of this._batchSnapshot) {
                const record = this._slices.get(name);
                if (record) {
                    record.state = snapshot;
                }
            }
            this._batching = false;
            this._batchDirtySlices.clear();
            this._batchPendingFields.clear();
            this._batchSnapshot.clear();
            throw err;
        }

        this._batching = false;

        // Emit pending field signals first
        for (const [name, fields] of this._batchPendingFields) {
            const record = this._slices.get(name);
            if (record) {
                for (const [key, { value, prev }] of fields) {
                    const signal = record.fieldSignals.get(key);
                    if (signal) {
                        signal.emit({ value, prev });
                    }
                }
            }
        }

        // Emit per-slice signals
        for (const name of this._batchDirtySlices) {
            const record = this._slices.get(name);
            if (record) {
                record.signal.emit({ ...record.state });
            }
        }

        // Emit global signal
        if (this._batchDirtySlices.size > 0) {
            this.onChange.emit(this.getFullState());
        }

        this._batchDirtySlices.clear();
        this._batchPendingFields.clear();
        this._batchSnapshot.clear();
    }

    // ─── Full state ──────────────────────────────────────────────────────

    /** Get merged state of all slices (namespaced by slice name) */
    getFullState(): Readonly<Record<string, unknown>> {
        const result: Record<string, unknown> = {};
        for (const [name, record] of this._slices) {
            result[name] = { ...record.state };
        }
        return Object.freeze(result);
    }

    /** Snapshot for save/load */
    snapshot(): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [name, record] of this._slices) {
            result[name] = structuredClone(record.state);
        }
        return result;
    }

    /** Restore from snapshot */
    restore(data: Record<string, unknown>): void {
        let anyRestored = false;
        for (const [name, sliceData] of Object.entries(data)) {
            const record = this._slices.get(name);
            if (record && typeof sliceData === 'object' && sliceData !== null) {
                const oldState = record.state;
                let clonedData: SliceState;
                try {
                    clonedData = structuredClone(sliceData) as SliceState;
                } catch (err) {
                    throw new Error(
                        `Slice "${name}": restore data must be structuredClone-able (no functions, Symbols, DOM nodes, etc.)`,
                        { cause: err },
                    );
                }
                record.state = clonedData;
                this._notifySliceChange(name, record, oldState);
                anyRestored = true;
            }
        }
        if (!this._batching && anyRestored) {
            this.onChange.emit(this.getFullState());
        }
    }

    /** List all registered slice names */
    get sliceNames(): string[] {
        return [...this._slices.keys()];
    }

    /** Check if a slice is registered */
    has(name: string): boolean {
        return this._slices.has(name);
    }

    /** Reset all slices to defaults and clear subscriptions */
    reset(): void {
        for (const record of this._slices.values()) {
            record.state = structuredClone(record.definition.defaults);
            record.signal.clear();
            record.fieldSignals.forEach((s) => s.clear());
            record.fieldSignals.clear();
        }
        this.onChange.clear();
    }

    /** Reset all slices to defaults but keep subscriptions */
    resetState(): void {
        let anyReset = false;
        for (const [name, record] of this._slices) {
            const oldState = record.state;
            record.state = structuredClone(record.definition.defaults);
            this._notifySliceChange(name, record, oldState);
            anyReset = true;
        }
        if (!this._batching && anyReset) {
            this.onChange.emit(this.getFullState());
        }
    }

    /** Unregister a slice (for dynamic features / cleanup) */
    unregister(name: string): void {
        const record = this._slices.get(name);
        if (record) {
            record.signal.clear();
            record.fieldSignals.forEach((s) => s.clear());
            this._slices.delete(name);
        }
    }

    // ─── Internal ────────────────────────────────────────────────────────

    private _createHandle<T extends SliceState>(name: string): SliceHandle<T> {
        const store = this;

        return {
            name,

            get<K extends keyof T & string>(key: K): T[K] {
                const record = store._getRecord(name);
                const value = record.state[key];
                // Clone non-primitives to prevent external mutation of internal state
                if (typeof value === 'object' && value !== null) {
                    return structuredClone(value) as T[K];
                }
                return value as T[K];
            },

            getAll(): Readonly<T> {
                const record = store._getRecord(name);
                return structuredClone(record.state) as T;
            },

            update(partial: Partial<T>): void {
                store._updateSlice(name, partial as Partial<SliceState>);
            },

            set<K extends keyof T & string>(key: K, value: T[K]): void {
                store._updateSlice(name, { [key]: value } as Partial<SliceState>);
            },

            on<K extends keyof T & string>(
                key: K,
                callback: (value: T[K], prev: T[K]) => void,
            ): () => void {
                const record = store._getRecord(name);
                let signal = record.fieldSignals.get(key);
                if (!signal) {
                    signal = new Signal<unknown>();
                    record.fieldSignals.set(key, signal);
                }

                const wrapper = (payload: unknown) => {
                    const { value, prev } = payload as FieldSignalPayload<T, K>;
                    callback(value, prev);
                };

                signal.add(wrapper);
                return () => signal!.remove(wrapper);
            },

            get onChange(): Signal<Readonly<T>> {
                return store._getRecord(name).signal as unknown as Signal<Readonly<T>>;
            },

            computed<R>(fn: (state: Readonly<T>) => R): ComputedSignal<R> {
                const record = store._getRecord(name);
                let lastValue = fn(record.state as T);
                const derived = new ComputedSignal<R>(lastValue, () => binding.detach());

                const binding = record.signal.add((state) => {
                    const next = fn(state as T);
                    if (!Object.is(next, lastValue)) {
                        lastValue = next;
                        derived.emit(next);
                    }
                });

                return derived;
            },
        };
    }

    private _createReadonlyHandle<T extends SliceState>(
        name: string,
    ): Readonly<Pick<SliceHandle<T>, 'get' | 'getAll' | 'on' | 'onChange' | 'computed' | 'name'>> {
        const full = this._createHandle<T>(name);
        return Object.freeze({
            name: full.name,
            get: full.get,
            getAll: full.getAll,
            on: full.on,
            get onChange() { return full.onChange; },
            computed: full.computed,
        });
    }

    /** Emit field-level signals for all changed keys between old and new state */
    private _emitFieldSignals(
        record: SliceRecord,
        oldState: SliceState,
        newState: SliceState,
    ): void {
        const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);
        for (const key of allKeys) {
            if (!Object.is(oldState[key], newState[key])) {
                const signal = record.fieldSignals.get(key);
                if (signal) {
                    signal.emit({ value: newState[key], prev: oldState[key] });
                }
            }
        }
    }

    /** Handle field/slice signal emission or deferral for a state replacement */
    private _notifySliceChange(
        name: string,
        record: SliceRecord,
        oldState: SliceState,
    ): void {
        if (this._batching) {
            if (!this._batchSnapshot.has(name)) {
                this._batchSnapshot.set(name, oldState);
            }
            // Accumulate field changes for deferred emission
            let pendingFields = this._batchPendingFields.get(name);
            if (!pendingFields) {
                pendingFields = new Map();
                this._batchPendingFields.set(name, pendingFields);
            }
            const allKeys = new Set([...Object.keys(oldState), ...Object.keys(record.state)]);
            for (const key of allKeys) {
                if (!Object.is(oldState[key], record.state[key])) {
                    const existing = pendingFields.get(key);
                    if (existing) {
                        existing.value = record.state[key];
                    } else {
                        pendingFields.set(key, { value: record.state[key], prev: oldState[key] });
                    }
                }
            }
            this._batchDirtySlices.add(name);
        } else {
            this._emitFieldSignals(record, oldState, record.state);
            record.signal.emit({ ...record.state });
        }
    }

    private _getRecord(name: string): SliceRecord {
        const record = this._slices.get(name);
        if (!record) throw new Error(`Slice "${name}" is not registered`);
        return record;
    }

    private _updateSlice(name: string, partial: Partial<SliceState>): void {
        const record = this._getRecord(name);

        // Run slice middleware
        let processed: Partial<SliceState> | null = partial;
        for (let i = 0; i < record.middleware.length; i++) {
            const mw = record.middleware[i];
            try {
                processed = mw(record.state, processed!);
            } catch (err) {
                throw new Error(
                    `Middleware "${mw.name || `index ${i}`}" failed on slice "${name}"`,
                    { cause: err },
                );
            }
            if (processed === null) return;
        }

        // Snapshot pre-batch state on first mutation per slice (deep copy for rollback)
        if (this._batching && !this._batchSnapshot.has(name)) {
            this._batchSnapshot.set(name, structuredClone(record.state));
        }

        // Clone incoming values to prevent external mutation of internal state
        let clonedProcessed: Partial<SliceState>;
        try {
            clonedProcessed = structuredClone(processed!);
        } catch (err) {
            throw new Error(
                `Slice "${name}": update values must be structuredClone-able (no functions, Symbols, DOM nodes, etc.)`,
                { cause: err },
            );
        }

        // Diff
        const prev = { ...record.state };
        const changedKeys: string[] = [];

        for (const key of Object.keys(clonedProcessed)) {
            if (!Object.is(record.state[key], clonedProcessed[key])) {
                changedKeys.push(key);
                record.state[key] = clonedProcessed[key];
            }
        }

        if (changedKeys.length === 0) return;

        // During batch: accumulate field changes, defer all signals
        if (this._batching) {
            let pendingFields = this._batchPendingFields.get(name);
            if (!pendingFields) {
                pendingFields = new Map();
                this._batchPendingFields.set(name, pendingFields);
            }
            for (const key of changedKeys) {
                const existing = pendingFields.get(key);
                if (existing) {
                    // Keep original prev, update value to latest
                    existing.value = record.state[key];
                } else {
                    pendingFields.set(key, { value: record.state[key], prev: prev[key] });
                }
            }
            this._batchDirtySlices.add(name);
            return;
        }

        // Field-level signals (immediate when not batching)
        for (const key of changedKeys) {
            const signal = record.fieldSignals.get(key);
            if (signal) {
                signal.emit({ value: record.state[key], prev: prev[key] });
            }
        }

        // Slice-level signal
        record.signal.emit({ ...record.state });

        // Global signal
        this.onChange.emit(this.getFullState());
    }
}