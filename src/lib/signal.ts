type Listener<T> = (value: T) => void;

/**
 * Represents a binding to a signal that can be detached.
 */
export interface SignalBinding {
    /** Detach this binding from the signal. Returns true if was attached. */
    detach(): boolean;
    /** Alias for detach(). Useful for dispose patterns. */
    dispose(): void;
}

interface BindingEntry<T> {
    fn: Listener<T>;
    thisArg: unknown;
    once: boolean;
}

/**
 * Lightweight typed signal for pub/sub pattern.
 *
 * @example
 * ```ts
 * const signal = new Signal<number>();
 *
 * // Basic usage
 * const binding = signal.add((value) => console.log(value));
 * signal.emit(42);
 * binding.detach();
 *
 * // With thisArg for class methods
 * signal.add(this.onValueChange, this);
 *
 * // One-time listener
 * signal.once((value) => console.log('First emit only:', value));
 * ```
 */
export class Signal<T = void> {
    private bindings: Set<BindingEntry<T>> = new Set();

    /**
     * Add listener. Returns a SignalBinding to detach later.
     * @param listener The callback function
     * @param thisArg Optional `this` context for the listener
     */
    add(listener: Listener<T>, thisArg?: unknown): SignalBinding {
        const entry: BindingEntry<T> = { fn: listener, thisArg, once: false };
        this.bindings.add(entry);
        return this.createBinding(entry);
    }

    /**
     * Add one-time listener that auto-detaches after first emit.
     * @param listener The callback function
     * @param thisArg Optional `this` context for the listener
     */
    once(listener: Listener<T>, thisArg?: unknown): SignalBinding {
        const entry: BindingEntry<T> = { fn: listener, thisArg, once: true };
        this.bindings.add(entry);
        return this.createBinding(entry);
    }

    /**
     * Remove a specific listener function.
     * Note: If same function added multiple times with different thisArg,
     * this removes the first match.
     */
    remove(listener: Listener<T>): void {
        for (const entry of this.bindings) {
            if (entry.fn === listener) {
                this.bindings.delete(entry);
                return;
            }
        }
    }

    /** Emit value to all listeners */
    emit(value: T): void {
        for (const entry of this.bindings) {
            if (entry.once) {
                this.bindings.delete(entry);
            }
            entry.fn.call(entry.thisArg, value);
        }
    }

    /** Remove all listeners */
    clear(): void {
        this.bindings.clear();
    }

    /** Check if has any listeners */
    get hasListeners(): boolean {
        return this.bindings.size > 0;
    }

    private createBinding(entry: BindingEntry<T>): SignalBinding {
        return {
            detach: () => this.bindings.delete(entry),
            dispose: () => {
                this.bindings.delete(entry);
            },
        };
    }
}

/**
 * A derived signal that tracks a source signal and can be disposed
 * to detach from the source, preventing memory leaks.
 */
export class ComputedSignal<T> extends Signal<T> {
    private _disposeFn: (() => void) | null;
    private _disposed = false;

    constructor(disposeFn: () => void) {
        super();
        this._disposeFn = disposeFn;
    }

    get isDisposed(): boolean {
        return this._disposed;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        if (this._disposeFn) {
            this._disposeFn();
            this._disposeFn = null;
        }
        this.clear();
    }
}
