// Run before the DSH client bundle on older Android WebViews.
(() => {
  'use strict';
  // Model settings and the model picker use ES2023 copying sort. An older
  // WebView otherwise leaves their async stores permanently in "loading".
  const lengthOf = value => {
    const length = +value.length;
    return Number.isNaN(length) || length <= 0 ? 0 : Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER);
  };
  const objectOf = value => {
    if (value == null) throw new TypeError('Expected an array-like object');
    return Object(value);
  };
  if (typeof Array.prototype.toSorted !== 'function') {
    Object.defineProperty(Array.prototype, 'toSorted', { configurable: true, writable: true, value(compareFn) {
      const object = objectOf(this), length = lengthOf(object);
      if (compareFn !== undefined && typeof compareFn !== 'function') throw new TypeError('Expected a comparison function');
      const copy = new Array(length);
      // Copy by index, including holes as undefined, without consulting an
      // overridden iterator or Array species, as required by toSorted.
      for (let index = 0; index < length; index++) copy[index] = object[index];
      return copy.sort(compareFn);
    } });
  }
  for (const [method, returnIndex] of [['findLast', false], ['findLastIndex', true]]) {
    if (typeof Array.prototype[method] === 'function') continue;
    Object.defineProperty(Array.prototype, method, { configurable: true, writable: true, value(predicate, thisArg) {
      const object = objectOf(this), length = lengthOf(object);
      if (typeof predicate !== 'function') throw new TypeError('Expected a predicate');
      for (let index = length - 1; index >= 0; index--) {
        const value = object[index];
        if (predicate.call(thisArg, value, index, object)) return returnIndex ? index : value;
      }
      return returnIndex ? -1 : undefined;
    } });
  }
  // Approval and user-question dialogs also use this newer Promise helper.
  if (typeof Promise.withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value() {
      let resolve, reject, captured = false;
      const promise = new this((accept, decline) => {
        if (captured) throw new TypeError('Promise executor called twice');
        captured = true;
        resolve = accept; reject = decline;
      });
      if (typeof resolve !== 'function' || typeof reject !== 'function') throw new TypeError('Invalid Promise constructor');
      return { promise, resolve, reject };
    } });
  }
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return;
  if (typeof AbortSignal.any !== 'function') {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value(inputs) {
      const signals = Array.from(inputs), controller = new AbortController(), listeners = [];
      for (const signal of signals) {
        if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function') throw new TypeError('Expected AbortSignal');
      }
      const cleanup = () => { for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener); listeners.length = 0; };
      const abort = signal => { cleanup(); controller.abort(signal.reason); };
      const alreadyAborted = signals.find(signal => signal.aborted);
      if (alreadyAborted) { abort(alreadyAborted); return controller.signal; }
      for (const signal of signals) {
        const listener = () => abort(signal);
        listeners.push([signal, listener]);
        signal.addEventListener('abort', listener, { once: true });
      }
      return controller.signal;
    } });
  }
  if (typeof AbortSignal.timeout !== 'function') {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value(milliseconds) {
      if (typeof milliseconds !== 'number') throw new TypeError('Expected timeout in milliseconds');
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError('Invalid timeout');
      const controller = new AbortController();
      const wait = remaining => setTimeout(() => {
        if (remaining > 2147483647) wait(remaining - 2147483647);
        else controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }, Math.min(remaining, 2147483647));
      wait(milliseconds);
      return controller.signal;
    } });
  }
  if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, writable: true, value() {
      if (this.aborted) throw this.reason || new DOMException('The operation was aborted.', 'AbortError');
    } });
  }
})();
