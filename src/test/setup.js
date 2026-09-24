import { afterEach, expect } from 'vitest';
import { cleanup } from './dom.js';

// Node exposes a localStorage global that is empty unless --localstorage-file
// is set, and that binding shadows jsdom. Tests need a real Storage.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map();
  const memory = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memory,
  });
}

Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
});

expect.extend({
  /**
   * @param {Element | null | undefined} received
   */
  toBeInTheDocument(received) {
    const pass = received != null && document.body.contains(received);
    return {
      pass,
      message: () =>
        pass
          ? 'expected element not to be in the document'
          : 'expected element to be in the document',
    };
  },

  /**
   * @param {Element} received
   * @param {string | RegExp} text
   */
  toHaveTextContent(received, text) {
    const content = (received?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const pass =
      typeof text === 'string' ? content.includes(text) : text instanceof RegExp && text.test(content);
    return {
      pass,
      message: () =>
        pass
          ? `expected element not to have text content ${String(text)} (got "${content}")`
          : `expected element to have text content ${String(text)} (got "${content}")`,
    };
  },

  /**
   * @param {Element} received
   * @param {string} name
   * @param {string} [value]
   */
  toHaveAttribute(received, name, value) {
    const actual = received.getAttribute(name);
    const pass = value === undefined ? received.hasAttribute(name) : actual === String(value);
    return {
      pass,
      message: () =>
        pass
          ? `expected element not to have attribute ${name}${value === undefined ? '' : `="${value}"`}`
          : `expected element to have attribute ${name}${value === undefined ? '' : `="${value}"`} (got ${actual === null ? 'null' : `"${actual}"`})`,
    };
  },

  /**
   * @param {HTMLElement} received
   */
  toBeDisabled(received) {
    const pass =
      Boolean(/** @type {HTMLButtonElement} */ (received).disabled) ||
      received.getAttribute('aria-disabled') === 'true';
    return {
      pass,
      message: () =>
        pass ? 'expected element not to be disabled' : 'expected element to be disabled',
    };
  },
});
