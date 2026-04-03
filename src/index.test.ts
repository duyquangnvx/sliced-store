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
