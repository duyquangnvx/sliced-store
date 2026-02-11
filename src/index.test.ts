import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlicedStore, defineSlice, type Middleware } from './index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type WalletState = { balance: number; bet: number; currency: string };
type SpinState = { remaining: number; total: number; multiplier: number };

function walletDef(mw?: Middleware<WalletState>[]) {
    return defineSlice('wallet', {
        defaults: { balance: 1000, bet: 1, currency: 'USD' },
        middleware: mw,
    });
}

function spinDef() {
    return defineSlice('spin', {
        defaults: { remaining: 5, total: 10, multiplier: 1 },
    });
}

let store: SlicedStore;

beforeEach(() => {
    store = new SlicedStore();
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('register', () => {
    it('returns a handle with the slice name', () => {
        const handle = store.register(walletDef());
        expect(handle.name).toBe('wallet');
    });

    it('initializes state from defaults', () => {
        const handle = store.register(walletDef());
        expect(handle.get('balance')).toBe(1000);
        expect(handle.get('bet')).toBe(1);
        expect(handle.get('currency')).toBe('USD');
    });

    it('clones defaults so mutations to the original do not affect the store', () => {
        const defaults = { items: [1, 2, 3] };
        const def = defineSlice('test', { defaults });
        const handle = store.register(def);
        defaults.items.push(4);
        expect(handle.get('items')).toEqual([1, 2, 3]);
    });

    it('throws on duplicate name', () => {
        store.register(walletDef());
        expect(() => store.register(walletDef())).toThrow('already registered');
    });

    it('throws descriptive error for non-cloneable defaults', () => {
        const def = defineSlice('bad', { defaults: { fn: () => { } } as any });
        expect(() => store.register(def)).toThrow('structuredClone-able');
    });
});

// ─── get / getAll / set / batch ──────────────────────────────────────────────

describe('get / set / batch', () => {
    it('set updates a single field', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 10);
        expect(handle.get('bet')).toBe(10);
    });

    it('batch merges partial state', () => {
        const handle = store.register(walletDef());
        handle.batch({ balance: 500, bet: 5 });
        expect(handle.get('balance')).toBe(500);
        expect(handle.get('bet')).toBe(5);
        expect(handle.get('currency')).toBe('USD');
    });

    it('getAll returns full snapshot', () => {
        const handle = store.register(walletDef());
        const state = handle.getAll();
        expect(state).toEqual({ balance: 1000, bet: 1, currency: 'USD' });
    });

    it('no-op when setting same value', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        handle.set('bet', 1); // same as default
        expect(fn).not.toHaveBeenCalled();
    });

    // ── Defensive cloning ────────────────────────────────────────────────

    it('getAll() returns a deep clone', () => {
        const def = defineSlice('nested', { defaults: { obj: { a: 1 } } });
        const handle = store.register(def);
        const state = handle.getAll();
        (state as any).obj.a = 999;
        expect(handle.get('obj')).toEqual({ a: 1 }); // unaffected
    });
});

// ─── Field-level signals (on) ────────────────────────────────────────────────

describe('on (field signals)', () => {
    it('fires callback with value and prev on change', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.on('balance', fn);
        handle.set('balance', 500);
        expect(fn).toHaveBeenCalledWith(500, 1000);
    });

    it('does not fire when field is not changed', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.on('balance', fn);
        handle.set('bet', 10); // different field
        expect(fn).not.toHaveBeenCalled();
    });

    it('unsubscribe function works', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        const unsub = handle.on('balance', fn);
        unsub();
        handle.set('balance', 500);
        expect(fn).not.toHaveBeenCalled();
    });

    it('multiple listeners on same field', () => {
        const handle = store.register(walletDef());
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        handle.on('bet', fn1);
        handle.on('bet', fn2);
        handle.set('bet', 5);
        expect(fn1).toHaveBeenCalledWith(5, 1);
        expect(fn2).toHaveBeenCalledWith(5, 1);
    });
});

// ─── Slice-level onChange ────────────────────────────────────────────────────

describe('onChange (slice signal)', () => {
    it('fires on any field change', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        handle.set('bet', 10);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ bet: 10, balance: 1000 });
    });

    it('does not fire when no actual change', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        handle.set('bet', 1); // same value
        expect(fn).not.toHaveBeenCalled();
    });
});

// ─── Global onChange ─────────────────────────────────────────────────────────

describe('global onChange', () => {
    it('fires when any slice changes', () => {
        const wallet = store.register(walletDef());
        const spin = store.register(spinDef());
        const fn = vi.fn();
        store.onChange(fn);
        wallet.set('bet', 5);
        expect(fn).toHaveBeenCalledTimes(1);
        spin.set('remaining', 4);
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

// ─── Cross-feature readonly handle (slice) ───────────────────────────────────

describe('slice() readonly handle', () => {
    it('can read state', () => {
        store.register(walletDef());
        const ro = store.slice<WalletState>('wallet');
        expect(ro.get('balance')).toBe(1000);
        expect(ro.getAll()).toMatchObject({ balance: 1000, bet: 1 });
    });

    it('can subscribe to field changes', () => {
        const handle = store.register(walletDef());
        const ro = store.slice<WalletState>('wallet');
        const fn = vi.fn();
        ro.on('balance', fn);
        handle.set('balance', 500);
        expect(fn).toHaveBeenCalledWith(500, 1000);
    });

    it('has no set or batch methods at runtime', () => {
        store.register(walletDef());
        const ro = store.slice('wallet') as any;
        expect(ro.set).toBeUndefined();
        expect(ro.batch).toBeUndefined();
    });

    it('is frozen', () => {
        store.register(walletDef());
        const ro = store.slice('wallet') as any;
        expect(Object.isFrozen(ro)).toBe(true);
    });

    it('throws for unregistered slice', () => {
        expect(() => store.slice('nope')).toThrow('not registered');
    });
});

// ─── Computed ────────────────────────────────────────────────────────────────

describe('computed', () => {
    it('has correct initial value', () => {
        const handle = store.register(walletDef());
        const totalBet = handle.computed((s) => s.balance * s.bet);
        expect(totalBet.value).toBe(1000);
    });

    it('updates when source state changes', () => {
        const handle = store.register(walletDef());
        const totalBet = handle.computed((s) => s.balance * s.bet);
        const fn = vi.fn();
        totalBet.onChange(fn);
        handle.set('bet', 10);
        expect(fn).toHaveBeenCalledWith(10000);
        expect(totalBet.value).toBe(10000);
    });

    it('does not emit when computed value is unchanged', () => {
        const handle = store.register(walletDef());
        const isRich = handle.computed((s) => s.balance > 500);
        const fn = vi.fn();
        isRich.onChange(fn);
        handle.set('bet', 5); // balance still 1000, isRich still true
        expect(fn).not.toHaveBeenCalled();
    });

    it('dispose detaches from source', () => {
        const handle = store.register(walletDef());
        const totalBet = handle.computed((s) => s.balance * s.bet);
        const fn = vi.fn();
        totalBet.onChange(fn);
        totalBet.dispose();
        handle.set('bet', 10);
        expect(fn).not.toHaveBeenCalled();
        expect(totalBet.isDisposed).toBe(true);
    });

    it('computed from readonly handle works', () => {
        store.register(walletDef());
        const ro = store.slice<WalletState>('wallet');
        const c = ro.computed((s) => s.balance + s.bet);
        expect(c.value).toBe(1001);
    });
});

// ─── Middleware ───────────────────────────────────────────────────────────────

describe('middleware', () => {
    it('transforms incoming values', () => {
        const clampBet: Middleware<WalletState> = (_state, incoming) => {
            if (incoming.bet !== undefined && incoming.bet > 100) {
                return { ...incoming, bet: 100 };
            }
            return incoming;
        };
        const handle = store.register(walletDef([clampBet]));
        handle.set('bet', 500);
        expect(handle.get('bet')).toBe(100);
    });

    it('returning null blocks the update', () => {
        const blockAll: Middleware<WalletState> = () => null;
        const handle = store.register(walletDef([blockAll]));
        handle.set('bet', 10);
        expect(handle.get('bet')).toBe(1); // unchanged
    });

    it('middleware pipeline runs in order', () => {
        const double: Middleware<WalletState> = (_state, incoming) => {
            if (incoming.bet !== undefined) {
                return { ...incoming, bet: incoming.bet * 2 };
            }
            return incoming;
        };
        const addOne: Middleware<WalletState> = (_state, incoming) => {
            if (incoming.bet !== undefined) {
                return { ...incoming, bet: incoming.bet + 1 };
            }
            return incoming;
        };
        // double first: 5*2=10, then addOne: 10+1=11
        const handle = store.register(walletDef([double, addOne]));
        handle.set('bet', 5);
        expect(handle.get('bet')).toBe(11);
    });

    it('middleware errors propagate directly', () => {
        function badMiddleware() {
            throw new Error('mw error');
        }
        const handle = store.register(walletDef([badMiddleware as any]));
        expect(() => handle.set('bet', 10)).toThrow('mw error');
    });

    it('anonymous middleware errors propagate directly', () => {
        const handle = store.register(walletDef([
            () => { throw new Error('fail'); }
        ] as any));
        expect(() => handle.set('bet', 10)).toThrow('fail');
    });

    it('error is the original error', () => {
        const cause = new Error('root');
        const failMw: Middleware<WalletState> = () => { throw cause; };
        const handle = store.register(walletDef([failMw]));
        try {
            handle.set('bet', 10);
        } catch (err: any) {
            expect(err).toBe(cause);
        }
    });
});

// ─── Batch ───────────────────────────────────────────────────────────────────

describe('batch', () => {
    it('defers slice onChange to end of batch', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        store.batch(() => {
            handle.set('bet', 10);
            handle.set('balance', 500);
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ bet: 10, balance: 500 });
    });

    it('defers global onChange to end of batch', () => {
        const wallet = store.register(walletDef());
        const spin = store.register(spinDef());
        const fn = vi.fn();
        store.onChange(fn);
        store.batch(() => {
            wallet.set('bet', 10);
            spin.set('remaining', 3);
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('defers field signals to end of batch', () => {
        const handle = store.register(walletDef());
        const balanceFn = vi.fn();
        const betFn = vi.fn();
        handle.on('balance', balanceFn);
        handle.on('bet', betFn);
        store.batch(() => {
            handle.set('balance', 500);
            handle.set('bet', 10);
            expect(balanceFn).not.toHaveBeenCalled();
            expect(betFn).not.toHaveBeenCalled();
        });
        expect(balanceFn).toHaveBeenCalledWith(500, 1000);
        expect(betFn).toHaveBeenCalledWith(10, 1);
    });

    it('field signals fire before slice signals in batch', () => {
        const handle = store.register(walletDef());
        const order: string[] = [];
        handle.on('bet', () => order.push('field'));
        handle.onChange(() => order.push('slice'));
        store.onChange(() => order.push('global'));
        store.batch(() => {
            handle.set('bet', 10);
        });
        expect(order).toEqual(['field', 'slice', 'global']);
    });

    it('multiple updates to same field show original prev', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.on('bet', fn);
        store.batch(() => {
            handle.set('bet', 5);
            handle.set('bet', 10);
            handle.set('bet', 20);
        });
        // Should see prev=1 (original) and value=20 (final)
        expect(fn).toHaveBeenCalledWith(20, 1);
    });

    it('nested batch just runs inline', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        store.batch(() => {
            store.batch(() => {
                handle.set('bet', 10);
            });
            // Still inside outer batch, no signal yet
            expect(fn).not.toHaveBeenCalled();
        });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not emit if no changes in batch', () => {
        store.register(walletDef());
        const fn = vi.fn();
        store.onChange(fn);
        store.batch(() => {
            // no mutations
        });
        expect(fn).not.toHaveBeenCalled();
    });

    // ── Rollback on error ────────────────────────────────────────────────

    it('rolls back state on error', () => {
        const handle = store.register(walletDef());
        expect(() => {
            store.batch(() => {
                handle.set('bet', 99);
                handle.set('balance', 0);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(handle.get('bet')).toBe(1);
        expect(handle.get('balance')).toBe(1000);
    });

    it('rolls back multiple slices on error', () => {
        const wallet = store.register(walletDef());
        const spin = store.register(spinDef());
        expect(() => {
            store.batch(() => {
                wallet.set('bet', 99);
                spin.set('remaining', 0);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(wallet.get('bet')).toBe(1);
        expect(spin.get('remaining')).toBe(5);
    });

    it('does not emit signals on rollback', () => {
        const handle = store.register(walletDef());
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        const globalFn = vi.fn();
        handle.on('bet', fieldFn);
        handle.onChange(sliceFn);
        store.onChange(globalFn);
        expect(() => {
            store.batch(() => {
                handle.set('bet', 99);
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(fieldFn).not.toHaveBeenCalled();
        expect(sliceFn).not.toHaveBeenCalled();
        expect(globalFn).not.toHaveBeenCalled();
    });

    it('deep rollback for nested objects', () => {
        const def = defineSlice('nested', { defaults: { obj: { a: 1, b: 2 } } });
        const handle = store.register(def);
        expect(() => {
            store.batch(() => {
                handle.set('obj', { a: 99, b: 99 });
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(handle.get('obj')).toEqual({ a: 1, b: 2 });
    });

    it('store is usable after rollback', () => {
        const handle = store.register(walletDef());
        expect(() => {
            store.batch(() => {
                handle.set('bet', 99);
                throw new Error('abort');
            });
        }).toThrow('abort');
        // Should work normally after rollback
        handle.set('bet', 5);
        expect(handle.get('bet')).toBe(5);
    });
});

// ─── restore / resetState batch-awareness ────────────────────────────────────

describe('restore', () => {
    it('restores state from snapshot', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 50);
        const snap = store.snapshot();
        handle.set('bet', 99);
        store.restore(snap);
        expect(handle.get('bet')).toBe(50);
    });

    it('fires field signals on restore', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.on('bet', fn);
        store.restore({ wallet: { balance: 1000, bet: 50, currency: 'USD' } });
        expect(fn).toHaveBeenCalledWith(50, 1);
    });

    it('fires slice onChange on restore', () => {
        const handle = store.register(walletDef());
        const fn = vi.fn();
        handle.onChange(fn);
        store.restore({ wallet: { balance: 500, bet: 1, currency: 'USD' } });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('fires global onChange on restore', () => {
        store.register(walletDef());
        const fn = vi.fn();
        store.onChange(fn);
        store.restore({ wallet: { balance: 500, bet: 1, currency: 'USD' } });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not fire global onChange when no slices matched', () => {
        store.register(walletDef());
        const fn = vi.fn();
        store.onChange(fn);
        store.restore({ unknown: { x: 1 } });
        expect(fn).not.toHaveBeenCalled();
    });

    it('defers signals when called inside batch', () => {
        const handle = store.register(walletDef());
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        const globalFn = vi.fn();
        handle.on('bet', fieldFn);
        handle.onChange(sliceFn);
        store.onChange(globalFn);
        store.batch(() => {
            store.restore({ wallet: { balance: 500, bet: 50, currency: 'EUR' } });
            expect(fieldFn).not.toHaveBeenCalled();
            expect(sliceFn).not.toHaveBeenCalled();
            expect(globalFn).not.toHaveBeenCalled();
        });
        expect(fieldFn).toHaveBeenCalled();
        expect(sliceFn).toHaveBeenCalledTimes(1);
        expect(globalFn).toHaveBeenCalledTimes(1);
    });

    it('rolls back on error when restore is inside batch', () => {
        const handle = store.register(walletDef());
        expect(() => {
            store.batch(() => {
                store.restore({ wallet: { balance: 0, bet: 0, currency: 'X' } });
                throw new Error('abort');
            });
        }).toThrow('abort');
        expect(handle.get('balance')).toBe(1000);
        expect(handle.get('bet')).toBe(1);
    });

    it('throws descriptive error for non-cloneable restore data', () => {
        store.register(walletDef());
        expect(() => {
            store.restore({ wallet: { balance: 1, bet: 1, currency: 'X', bad: () => { } } });
        }).toThrow('structuredClone-able');
    });
});

describe('resetState', () => {
    it('resets all slices to defaults keeping subscriptions', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 99);
        handle.set('balance', 0);
        const fn = vi.fn();
        handle.onChange(fn);
        store.resetState();
        expect(handle.get('bet')).toBe(1);
        expect(handle.get('balance')).toBe(1000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('fires field signals on resetState', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 50);
        const fn = vi.fn();
        handle.on('bet', fn);
        fn.mockClear();
        store.resetState();
        expect(fn).toHaveBeenCalledWith(1, 50);
    });

    it('defers signals when called inside batch', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 50);
        const fieldFn = vi.fn();
        const sliceFn = vi.fn();
        handle.on('bet', fieldFn);
        handle.onChange(sliceFn);
        // clear call counts from the set above
        fieldFn.mockClear();
        sliceFn.mockClear();
        store.batch(() => {
            store.resetState();
            expect(fieldFn).not.toHaveBeenCalled();
            expect(sliceFn).not.toHaveBeenCalled();
        });
        expect(fieldFn).toHaveBeenCalledWith(1, 50);
        expect(sliceFn).toHaveBeenCalledTimes(1);
    });
});

// ─── Full state / snapshot / reset ───────────────────────────────────────────

describe('full state operations', () => {
    it('getState returns all slices', () => {
        store.register(walletDef());
        store.register(spinDef());
        const state = store.getState();
        expect(state).toHaveProperty('wallet');
        expect(state).toHaveProperty('spin');
        expect(Object.isFrozen(state)).toBe(true);
    });

    it('snapshot returns deep cloned state', () => {
        const def = defineSlice('arr', { defaults: { items: [1, 2] } });
        const handle = store.register(def);
        const snap = store.snapshot();
        handle.set('items', [3, 4]);
        expect((snap.arr as any).items).toEqual([1, 2]); // unaffected
    });

    it('reset clears state and subscriptions', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 99);
        const fn = vi.fn();
        handle.onChange(fn);
        store.reset();
        expect(handle.get('bet')).toBe(1);
        // Listener was cleared
        handle.set('bet', 10);
        expect(fn).not.toHaveBeenCalled();
    });

    it('sliceNames returns registered names', () => {
        store.register(walletDef());
        store.register(spinDef());
        expect(store.sliceNames).toEqual(expect.arrayContaining(['wallet', 'spin']));
    });

    it('has checks registration', () => {
        store.register(walletDef());
        expect(store.has('wallet')).toBe(true);
        expect(store.has('nope')).toBe(false);
    });

    it('unregister removes slice', () => {
        store.register(walletDef());
        store.unregister('wallet');
        expect(store.has('wallet')).toBe(false);
        expect(() => store.slice('wallet')).toThrow('not registered');
    });
});

// ─── Computed signal cleanup ─────────────────────────────────────────────────

describe('computed cleanup', () => {
    it('unregister() disposes all computed', () => {
        const handle = store.register(walletDef());
        const c1 = handle.computed((s) => s.balance * s.bet);
        const c2 = handle.computed((s) => s.balance > 500);
        expect(c1.isDisposed).toBe(false);
        expect(c2.isDisposed).toBe(false);
        store.unregister('wallet');
        expect(c1.isDisposed).toBe(true);
        expect(c2.isDisposed).toBe(true);
    });

    it('reset() disposes all computed', () => {
        const handle = store.register(walletDef());
        const c = handle.computed((s) => s.bet * 2);
        expect(c.isDisposed).toBe(false);
        store.reset();
        expect(c.isDisposed).toBe(true);
    });

    it('resetState() keeps computed alive', () => {
        const handle = store.register(walletDef());
        handle.set('bet', 50);
        const c = handle.computed((s) => s.bet * 2);
        expect(c.value).toBe(100);
        const fn = vi.fn();
        c.onChange(fn);
        store.resetState();
        // bet resets to 1, computed should update to 2
        expect(c.isDisposed).toBe(false);
        expect(c.value).toBe(2);
        expect(fn).toHaveBeenCalledWith(2);
    });

    it('manually disposed computed is removed from tracking set', () => {
        const handle = store.register(walletDef());
        const c = handle.computed((s) => s.bet);
        c.dispose();
        // unregister should not throw even though c is already disposed
        expect(() => store.unregister('wallet')).not.toThrow();
        expect(c.isDisposed).toBe(true);
    });

    it('computed from readonly handle is cleaned up on unregister', () => {
        store.register(walletDef());
        const ro = store.slice<WalletState>('wallet');
        const c = ro.computed((s) => s.balance + s.bet);
        expect(c.isDisposed).toBe(false);
        store.unregister('wallet');
        expect(c.isDisposed).toBe(true);
    });

    it('throws when adding listener to disposed computed', () => {
        const handle = store.register(walletDef());
        const c = handle.computed((s) => s.bet);
        c.dispose();
        expect(() => c.onChange(() => {})).toThrow('disposed');
    });

    it('dispose is idempotent', () => {
        const handle = store.register(walletDef());
        const c = handle.computed((s) => s.bet);
        c.dispose();
        expect(() => c.dispose()).not.toThrow();
        expect(c.isDisposed).toBe(true);
    });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('batch + restore + additional mutations', () => {
        const wallet = store.register(walletDef());
        const spin = store.register(spinDef());
        const walletFn = vi.fn();
        const spinFn = vi.fn();
        wallet.on('bet', walletFn);
        spin.on('remaining', spinFn);

        store.batch(() => {
            store.restore({ wallet: { balance: 200, bet: 20, currency: 'EUR' } });
            spin.set('remaining', 1);
        });

        expect(wallet.get('bet')).toBe(20);
        expect(spin.get('remaining')).toBe(1);
        expect(walletFn).toHaveBeenCalledWith(20, 1);
        expect(spinFn).toHaveBeenCalledWith(1, 5);
    });

    it('computed on readonly handle updates correctly', () => {
        const handle = store.register(walletDef());
        const ro = store.slice<WalletState>('wallet');
        const totalBet = ro.computed((s) => s.balance - s.bet);
        const fn = vi.fn();
        totalBet.onChange(fn);
        handle.set('bet', 100);
        expect(totalBet.value).toBe(900);
        expect(fn).toHaveBeenCalledWith(900);
    });

    it('computed dispose stops further updates', () => {
        const handle = store.register(walletDef());
        const c = handle.computed((s) => s.bet * 2);
        c.dispose();
        handle.set('bet', 50);
        expect(c.value).toBe(2); // initial value, never updated
    });

    it('multiple field listeners on different slices during batch', () => {
        const wallet = store.register(walletDef());
        const spin = store.register(spinDef());
        const wBet = vi.fn();
        const sRem = vi.fn();
        wallet.on('bet', wBet);
        spin.on('remaining', sRem);

        store.batch(() => {
            wallet.set('bet', 10);
            spin.set('remaining', 0);
        });

        expect(wBet).toHaveBeenCalledWith(10, 1);
        expect(sRem).toHaveBeenCalledWith(0, 5);
    });

    it('set returns false when rejected by middleware', () => {
        const blockBet: Middleware<WalletState> = (_state, incoming) => {
            if (incoming.bet !== undefined) return null;
            return incoming;
        };
        const handle = store.register(walletDef([blockBet]));
        expect(handle.set('bet', 10)).toBe(false);
        expect(handle.set('balance', 500)).toBe(true);
    });

    it('batch on handle returns rejected keys', () => {
        const blockBet: Middleware<WalletState> = (_state, incoming) => {
            if (incoming.bet !== undefined) return null;
            return incoming;
        };
        const handle = store.register(walletDef([blockBet]));
        const rejected = handle.batch({ balance: 500, bet: 10 });
        expect(rejected).toEqual(['bet']);
        expect(handle.get('balance')).toBe(500);
        expect(handle.get('bet')).toBe(1);
    });
});
