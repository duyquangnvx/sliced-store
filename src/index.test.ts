import { describe, it, expect, vi } from 'vitest';
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
