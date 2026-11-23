import { Buffer } from 'buffer';
import { EventEmitter } from './lib/events-shim';

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

if (typeof window !== 'undefined') {
  (window as any).Buffer = (window as any).Buffer || Buffer;
  (window as any).global = (window as any).global || window;
  (window as any).self = (window as any).self || window;
  (window as any).process = (window as any).process || { env: {} };
  (window as any).EventEmitter = EventEmitter;
  (window as any).events = { EventEmitter };
  (window as any).util = (window as any).util || {
    inspect: { custom: customInspectSymbol },
  };
}

if (typeof globalThis !== 'undefined') {
  (globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;
  (globalThis as any).self = (globalThis as any).self || globalThis;
}

export { Buffer, EventEmitter, customInspectSymbol };
