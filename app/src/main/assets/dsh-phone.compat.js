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
  // The Models editor calls structuredClone only when its edit card mounts.
  // Loading the Models list alone cannot exercise this pre-Chrome-98 failure.
  // Keep native cloning when available; this fallback covers configuration
  // graphs, preserving cycles, aliases and shared typed-array buffers.
  if (typeof globalThis.structuredClone !== 'function') {
    const cannotClone = () => {
      if (typeof DOMException === 'function') return new DOMException('Value cannot be cloned', 'DataCloneError');
      const error = new TypeError('Value cannot be cloned'); error.name = 'DataCloneError'; return error;
    };
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, enumerable: true, value(value, options) {
      // Detaching/transfer needs engine support. Refuse it instead of silently
      // returning a copy while leaving a requested transferred buffer attached.
      if (options && options.transfer != null && Array.from(options.transfer).length) throw cannotClone();
      const seen = new Map();
      const clone = input => {
        if (typeof input === 'function' || typeof input === 'symbol') throw cannotClone();
        if (input === null || typeof input !== 'object') return input;
        if (seen.has(input)) return seen.get(input);
        const tag = Object.prototype.toString.call(input);
        let output;
        if (tag === '[object ArrayBuffer]') output = input.slice(0);
        else if (ArrayBuffer.isView(input)) {
          const buffer = clone(input.buffer);
          output = tag === '[object DataView]' ? new DataView(buffer, input.byteOffset, input.byteLength)
            : new globalThis[tag.slice(8, -1)](buffer, input.byteOffset, input.length);
        } else if (tag === '[object Date]') output = new Date(input.getTime());
        else if (tag === '[object RegExp]') output = new RegExp(input.source, input.flags);
        else if (tag === '[object Map]') {
          output = new Map(); seen.set(input, output);
          input.forEach((item, key) => output.set(clone(key), clone(item)));
          return output;
        } else if (tag === '[object Set]') {
          output = new Set(); seen.set(input, output);
          input.forEach(item => output.add(clone(item)));
          return output;
        } else if (tag === '[object Error]') {
          const Constructor = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].find(type => type.name === input.name) || Error;
          output = new Constructor(input.message); seen.set(input, output);
          if (typeof input.stack === 'string') output.stack = input.stack;
          if (Object.prototype.hasOwnProperty.call(input, 'cause')) output.cause = clone(input.cause);
          return output;
        } else if (['[object Number]', '[object String]', '[object Boolean]', '[object BigInt]'].includes(tag)) output = Object(input.valueOf());
        else if (tag === '[object Object]' || Array.isArray(input)) {
          output = Array.isArray(input) ? new Array(input.length) : {}; seen.set(input, output);
          // Structured cloning flattens custom prototypes and ignores symbol
          // keys. Defining own properties also preserves a literal __proto__.
          for (const key of Object.keys(input)) Object.defineProperty(output, key, {
            value: clone(input[key]), enumerable: true, configurable: true, writable: true,
          });
          return output;
        } else throw cannotClone();
        seen.set(input, output); return output;
      };
      return clone(value);
    } });
  }
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
