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

    on<K extends keyof T & string>(key: K, listener: (value: T[K], prev: T[K]) => void): Unsubscribe {
        let subs = this._fieldListeners.get(key);
        if (!subs) {
            subs = new Set();
            this._fieldListeners.set(key, subs);
        }
        subs.add(listener as FieldListener<unknown>);
        return () => subs!.delete(listener as FieldListener<unknown>);
    }

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

    onChange(listener: SliceListener<T>): Unsubscribe {
        this._sliceListeners.add(listener);
        return () => this._sliceListeners.delete(listener);
    }

    /** @internal */
    _flushField(key: string, value: unknown, prev: unknown): void {
        const subs = this._fieldListeners.get(key);
        if (subs) {
            for (const fn of subs) {
                try { fn(value, prev); } catch (e) { console.error(e); }
            }
        }
    }

    /** @internal */
    _flushSlice(): void {
        for (const fn of this._sliceListeners) {
            try { fn(this._state); } catch (e) { console.error(e); }
        }
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
    const readonlyCache = new Map<string, ReadonlySlice<any>>();

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

    return {
        handle<K extends keyof D & string>(name: K): SliceHandle<InferState<D[K]>> {
            return handles.get(name)! as SliceHandle<InferState<D[K]>>;
        },
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
    };
}
