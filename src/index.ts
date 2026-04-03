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

    onChange(listener: SliceListener<T>): Unsubscribe {
        this._sliceListeners.add(listener);
        return () => this._sliceListeners.delete(listener);
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
