// ─── Types ───────────────────────────────────────────────────────────

/** Pipeline middleware: transform incoming partial, return null to reject. */
export type Middleware<T extends Record<string, unknown>> = (
    state: Readonly<T>,
    incoming: Partial<T>,
) => Partial<T> | null;

export interface SliceDefinition<
    Name extends string = string,
    T extends Record<string, unknown> = Record<string, unknown>,
> {
    name: Name;
    defaults: T;
    middleware?: Middleware<T>[];
}

export interface ComputedHandle<R> {
    readonly value: R;
    onChange(cb: (value: R) => void): () => void;
    dispose(): void;
    readonly isDisposed: boolean;
}

type FieldListener<V> = (value: V, prev: V) => void;
type SliceListener<T> = (state: Readonly<T>) => void;
type StoreListener = (state: Readonly<Record<string, Record<string, unknown>>>) => void;
type Unsubscribe = () => void;

interface BatchContext {
    active: boolean;
    /** Pre-batch state snapshots for rollback */
    slices: Map<string, Record<string, unknown>>;
    /** Slices that were mutated */
    dirtySlices: Set<string>;
    /** Pending field notifications: sliceName → key → { prev, value } */
    pendingFields: Map<string, Map<string, { prev: unknown; value: unknown }>>;
}

// ─── SliceHandle ─────────────────────────────────────────────────────

export class SliceHandle<T extends Record<string, unknown>> {
    /** @internal */ readonly _fieldListeners = new Map<keyof T, Set<FieldListener<unknown>>>();
    /** @internal */ readonly _sliceListeners = new Set<SliceListener<T>>();
    /** @internal */ readonly _computedHandles = new Set<ComputedHandle<unknown>>();

    /** @internal */
    constructor(
        private readonly _name: string,
        private _state: T,
        private readonly _defaults: T,
        private readonly _middleware: Middleware<T>[],
        private readonly _batch: BatchContext,
        private readonly _notifyStore: () => void,
    ) {}

    get name(): string { return this._name; }

    // ── Read ──

    get<K extends keyof T & string>(key: K): T[K] {
        return this._state[key];
    }

    getAll(): Readonly<T> {
        return structuredClone(this._state);
    }

    // ── Write ──

    set<K extends keyof T & string>(key: K, value: T[K]): boolean {
        const prev = this._state[key];
        if (Object.is(prev, value)) return true;

        let incoming: Partial<T> = { [key]: value } as unknown as Partial<T>;
        for (const mw of this._middleware) {
            const result = mw(this._state, incoming);
            if (result === null) return false;
            incoming = result;
        }

        const finalValue = incoming[key] as T[K];
        if (Object.is(prev, finalValue)) return true;

        // Snapshot before first mutation per slice in batch
        if (this._batch.active && !this._batch.slices.has(this._name)) {
            this._batch.slices.set(this._name, structuredClone(this._state));
        }

        this._state = { ...this._state, [key]: finalValue };

        if (this._batch.active) {
            this._batch.dirtySlices.add(this._name);
            let fields = this._batch.pendingFields.get(this._name);
            if (!fields) {
                fields = new Map();
                this._batch.pendingFields.set(this._name, fields);
            }
            const existing = fields.get(key);
            if (existing) {
                existing.value = finalValue;
            } else {
                fields.set(key, { prev, value: finalValue });
            }
            return true;
        }

        // Immediate notifications
        this._flushField(key, finalValue, prev);
        this._flushSlice();
        this._notifyStore();
        return true;
    }

    /** Batch-set multiple fields. Returns keys that were rejected. */
    batch(updates: Partial<T>): (keyof T & string)[] {
        const rejected: (keyof T & string)[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (!this.set(key as keyof T & string, value as T[keyof T & string])) {
                rejected.push(key as keyof T & string);
            }
        }
        return rejected;
    }

    /** Reset all fields to their defaults via set(). */
    reset(): void {
        for (const key of Object.keys(this._defaults) as (keyof T & string)[]) {
            this.set(key, this._defaults[key]);
        }
    }

    // ── Subscribe ──

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

    computed<R>(fn: (state: Readonly<T>) => R): ComputedHandle<R> {
        let lastValue = fn(this._state);
        let disposed = false;
        const listeners = new Set<(value: R) => void>();
        const handles = this._computedHandles;

        const unsub = this.onChange((state) => {
            if (disposed) return;
            const next = fn(state);
            if (!Object.is(next, lastValue)) {
                lastValue = next;
                for (const cb of listeners) cb(next);
            }
        });

        const handle: ComputedHandle<R> = {
            get value() { return lastValue; },
            onChange(cb: (value: R) => void): Unsubscribe {
                if (disposed) throw new Error('Cannot add listener to a disposed computed');
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                unsub();
                listeners.clear();
                handles.delete(handle as ComputedHandle<unknown>);
            },
            get isDisposed() { return disposed; },
        };

        this._computedHandles.add(handle as ComputedHandle<unknown>);
        return handle;
    }

    // ── Internal ──

    /** @internal */ _flushField(key: string, value: unknown, prev: unknown): void {
        const subs = this._fieldListeners.get(key as keyof T);
        if (subs) {
            for (const fn of subs) fn(value, prev);
        }
    }

    /** @internal */ _flushSlice(): void {
        for (const fn of this._sliceListeners) fn(this._state);
    }

    /** @internal */ _getState(): Readonly<T> { return this._state; }

    /** @internal */ _setState(state: T): void { this._state = state; }

    /** @internal */ _getDefaults(): Readonly<T> { return this._defaults; }

    /** @internal */ _disposeAllComputed(): void {
        for (const c of this._computedHandles) c.dispose();
        this._computedHandles.clear();
    }

    /** @internal */ _clearSubscriptions(): void {
        this._fieldListeners.clear();
        this._sliceListeners.clear();
        this._disposeAllComputed();
    }
}

// ─── defineSlice ─────────────────────────────────────────────────────

export function defineSlice<
    Name extends string,
    T extends Record<string, unknown>,
>(
    name: Name,
    opts: { defaults: T; middleware?: Middleware<T>[] },
): SliceDefinition<Name, T> {
    return { name, defaults: opts.defaults, middleware: opts.middleware };
}

// ─── SlicedStore ─────────────────────────────────────────────────────

export class SlicedStore {
    private readonly _slices = new Map<string, SliceHandle<any>>();
    private readonly _storeListeners = new Set<StoreListener>();
    private readonly _batch: BatchContext = {
        active: false,
        slices: new Map(),
        dirtySlices: new Set(),
        pendingFields: new Map(),
    };

    /** Register a slice definition and get back a typed handle. */
    register<Name extends string, T extends Record<string, unknown>>(
        definition: SliceDefinition<Name, T>,
    ): SliceHandle<T> {
        if (this._slices.has(definition.name)) {
            throw new Error(`Slice "${definition.name}" is already registered`);
        }

        let clonedDefaults: T;
        try {
            clonedDefaults = structuredClone(definition.defaults);
        } catch (err) {
            throw new Error(
                `Slice "${definition.name}": defaults must be structuredClone-able`,
                { cause: err },
            );
        }

        const handle = new SliceHandle<T>(
            definition.name,
            structuredClone(clonedDefaults),
            clonedDefaults,
            (definition.middleware ?? []) as Middleware<T>[],
            this._batch,
            () => this._notifyStoreListeners(),
        );

        this._slices.set(definition.name, handle);
        return handle;
    }

    /** Read-only access to another feature's slice. */
    slice<T extends Record<string, unknown>>(
        name: string,
    ): Readonly<Pick<SliceHandle<T>, 'get' | 'getAll' | 'on' | 'onChange' | 'computed' | 'name'>> {
        const handle = this._slices.get(name);
        if (!handle) throw new Error(`Slice "${name}" is not registered`);
        return Object.freeze({
            name: handle.name,
            get: handle.get.bind(handle),
            getAll: handle.getAll.bind(handle),
            on: handle.on.bind(handle),
            onChange: handle.onChange.bind(handle),
            computed: handle.computed.bind(handle),
        });
    }

    /** Subscribe to changes across all slices. */
    onChange(listener: StoreListener): Unsubscribe {
        this._storeListeners.add(listener);
        return () => this._storeListeners.delete(listener);
    }

    /** Batch updates across slices. Signals fire once at end. Nested = inline. */
    batch(fn: () => void): void {
        if (this._batch.active) {
            fn();
            return;
        }

        this._batch.active = true;
        this._batch.slices.clear();
        this._batch.dirtySlices.clear();
        this._batch.pendingFields.clear();

        try {
            fn();
        } catch (err) {
            for (const [name, snapshot] of this._batch.slices) {
                const handle = this._slices.get(name);
                if (handle) handle._setState(snapshot as any);
            }
            this._batch.active = false;
            this._batch.slices.clear();
            this._batch.dirtySlices.clear();
            this._batch.pendingFields.clear();
            throw err;
        }

        this._batch.active = false;

        // Flush order: field signals → slice signals → store signal
        for (const [name, fields] of this._batch.pendingFields) {
            const handle = this._slices.get(name);
            if (handle) {
                for (const [key, { value, prev }] of fields) {
                    handle._flushField(key, value, prev);
                }
            }
        }

        for (const name of this._batch.dirtySlices) {
            const handle = this._slices.get(name);
            if (handle) handle._flushSlice();
        }

        if (this._batch.dirtySlices.size > 0) {
            this._notifyStoreListeners();
        }

        this._batch.slices.clear();
        this._batch.dirtySlices.clear();
        this._batch.pendingFields.clear();
    }

    /** Snapshot of the full store state (all slices, deep cloned + frozen). */
    getState(): Readonly<Record<string, Record<string, unknown>>> {
        const state: Record<string, Record<string, unknown>> = {};
        for (const [name, handle] of this._slices) {
            state[name] = structuredClone(handle._getState() as Record<string, unknown>);
        }
        return Object.freeze(state);
    }

    /** Snapshot for save/load. */
    snapshot(): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [name, handle] of this._slices) {
            result[name] = structuredClone(handle._getState());
        }
        return result;
    }

    /** Restore from snapshot. Batch-aware. */
    restore(data: Record<string, unknown>): void {
        let anyRestored = false;
        for (const [name, sliceData] of Object.entries(data)) {
            const handle = this._slices.get(name);
            if (handle && typeof sliceData === 'object' && sliceData !== null) {
                const oldState = handle._getState() as Record<string, unknown>;

                if (this._batch.active && !this._batch.slices.has(name)) {
                    this._batch.slices.set(name, structuredClone(oldState));
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

                const newState = { ...structuredClone(handle._getDefaults()), ...clonedData };
                handle._setState(newState as any);
                this._notifySliceChanges(name, handle, oldState);
                anyRestored = true;
            }
        }
        if (!this._batch.active && anyRestored) {
            this._notifyStoreListeners();
        }
    }

    /** Check if a slice is registered. */
    has(name: string): boolean {
        return this._slices.has(name);
    }

    /** List all registered slice names. */
    get sliceNames(): string[] {
        return [...this._slices.keys()];
    }

    /** Unregister a slice (for dynamic features / cleanup). */
    unregister(name: string): void {
        const handle = this._slices.get(name);
        if (handle) {
            handle._clearSubscriptions();
            this._slices.delete(name);
        }
    }

    /** Reset all slices to defaults and clear all subscriptions. */
    reset(): void {
        for (const handle of this._slices.values()) {
            handle._setState(structuredClone(handle._getDefaults()) as any);
            handle._clearSubscriptions();
        }
        this._storeListeners.clear();
    }

    /** Reset all slices to defaults, keep subscriptions, notify. */
    resetState(): void {
        let anyReset = false;
        for (const [name, handle] of this._slices) {
            const oldState = handle._getState() as Record<string, unknown>;

            if (this._batch.active && !this._batch.slices.has(name)) {
                this._batch.slices.set(name, structuredClone(oldState));
            }

            handle._setState(structuredClone(handle._getDefaults()) as any);
            this._notifySliceChanges(name, handle, oldState);
            anyReset = true;
        }
        if (!this._batch.active && anyReset) {
            this._notifyStoreListeners();
        }
    }

    // ── Private ──

    private _notifyStoreListeners(): void {
        const snapshot = this.getState();
        for (const fn of this._storeListeners) fn(snapshot);
    }

    private _notifySliceChanges(
        name: string,
        handle: SliceHandle<any>,
        oldState: Record<string, unknown>,
    ): void {
        const newState = handle._getState() as Record<string, unknown>;
        const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

        if (this._batch.active) {
            this._batch.dirtySlices.add(name);
            let fields = this._batch.pendingFields.get(name);
            if (!fields) {
                fields = new Map();
                this._batch.pendingFields.set(name, fields);
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
}
