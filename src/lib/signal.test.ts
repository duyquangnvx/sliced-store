import { describe, it, expect, vi } from 'vitest';
import { Signal, ComputedSignal } from './signal.js';

// ─── Signal ──────────────────────────────────────────────────────────────────

describe('Signal', () => {
    it('emits values to listeners', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        signal.add(fn);
        signal.emit(42);
        expect(fn).toHaveBeenCalledWith(42);
    });

    it('emits to multiple listeners in order', () => {
        const signal = new Signal<number>();
        const order: number[] = [];
        signal.add(() => order.push(1));
        signal.add(() => order.push(2));
        signal.add(() => order.push(3));
        signal.emit(0);
        expect(order).toEqual([1, 2, 3]);
    });

    it('removes a listener by reference', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        signal.add(fn);
        signal.remove(fn);
        signal.emit(42);
        expect(fn).not.toHaveBeenCalled();
    });

    it('detaches via binding.detach()', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        const binding = signal.add(fn);
        binding.detach();
        signal.emit(42);
        expect(fn).not.toHaveBeenCalled();
    });

    it('detaches via binding.dispose()', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        const binding = signal.add(fn);
        binding.dispose();
        signal.emit(42);
        expect(fn).not.toHaveBeenCalled();
    });

    it('once listener fires only once', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        signal.once(fn);
        signal.emit(1);
        signal.emit(2);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(1);
    });

    it('once listener can be detached before firing', () => {
        const signal = new Signal<number>();
        const fn = vi.fn();
        const binding = signal.once(fn);
        binding.detach();
        signal.emit(1);
        expect(fn).not.toHaveBeenCalled();
    });

    it('calls listener with thisArg', () => {
        const signal = new Signal<number>();
        const obj = { value: 0, handler(v: number) { this.value = v; } };
        signal.add(obj.handler, obj);
        signal.emit(99);
        expect(obj.value).toBe(99);
    });

    it('clear removes all listeners', () => {
        const signal = new Signal<number>();
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        signal.add(fn1);
        signal.add(fn2);
        signal.clear();
        signal.emit(1);
        expect(fn1).not.toHaveBeenCalled();
        expect(fn2).not.toHaveBeenCalled();
    });

    it('hasListeners reflects state', () => {
        const signal = new Signal<number>();
        expect(signal.hasListeners).toBe(false);
        const binding = signal.add(() => {});
        expect(signal.hasListeners).toBe(true);
        binding.detach();
        expect(signal.hasListeners).toBe(false);
    });

    // ── Error isolation ──────────────────────────────────────────────────

    it('all listeners run even if one throws', () => {
        const signal = new Signal<number>();
        const fn1 = vi.fn();
        const fn2 = vi.fn(() => { throw new Error('boom'); });
        const fn3 = vi.fn();
        signal.add(fn1);
        signal.add(fn2);
        signal.add(fn3);
        expect(() => signal.emit(1)).toThrow('boom');
        expect(fn1).toHaveBeenCalledWith(1);
        expect(fn2).toHaveBeenCalledWith(1);
        expect(fn3).toHaveBeenCalledWith(1);
    });

    it('re-throws the first error after all listeners run', () => {
        const signal = new Signal<number>();
        const error1 = new Error('first');
        const error2 = new Error('second');
        signal.add(() => { throw error1; });
        signal.add(() => { throw error2; });
        try {
            signal.emit(1);
        } catch (err) {
            expect(err).toBe(error1);
        }
    });

    it('once listener that throws is still consumed', () => {
        const signal = new Signal<number>();
        const fn = vi.fn(() => { throw new Error('boom'); });
        signal.once(fn);
        expect(() => signal.emit(1)).toThrow('boom');
        expect(signal.hasListeners).toBe(false);
        // Should not fire again
        signal.emit(2);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

// ─── ComputedSignal ──────────────────────────────────────────────────────────

describe('ComputedSignal', () => {
    it('stores and exposes initial value', () => {
        const cs = new ComputedSignal<number>(42, () => {});
        expect(cs.value).toBe(42);
    });

    it('updates value on emit', () => {
        const cs = new ComputedSignal<number>(0, () => {});
        cs.emit(10);
        expect(cs.value).toBe(10);
    });

    it('notifies listeners on emit', () => {
        const cs = new ComputedSignal<number>(0, () => {});
        const fn = vi.fn();
        cs.add(fn);
        cs.emit(5);
        expect(fn).toHaveBeenCalledWith(5);
    });

    it('dispose detaches from source and clears listeners', () => {
        const detachFn = vi.fn();
        const cs = new ComputedSignal<number>(0, detachFn);
        const fn = vi.fn();
        cs.add(fn);
        cs.dispose();
        expect(detachFn).toHaveBeenCalledTimes(1);
        expect(cs.isDisposed).toBe(true);
        expect(cs.hasListeners).toBe(false);
    });

    it('dispose is idempotent', () => {
        const detachFn = vi.fn();
        const cs = new ComputedSignal<number>(0, detachFn);
        cs.dispose();
        cs.dispose();
        expect(detachFn).toHaveBeenCalledTimes(1);
    });

    it('emit is no-op after disposal', () => {
        const cs = new ComputedSignal<number>(5, () => {});
        cs.dispose();
        cs.emit(99);
        expect(cs.value).toBe(5); // unchanged
    });

    it('add throws after disposal', () => {
        const cs = new ComputedSignal<number>(0, () => {});
        cs.dispose();
        expect(() => cs.add(() => {})).toThrow('disposed');
    });

    it('once throws after disposal', () => {
        const cs = new ComputedSignal<number>(0, () => {});
        cs.dispose();
        expect(() => cs.once(() => {})).toThrow('disposed');
    });
});
