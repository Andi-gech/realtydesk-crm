export class EventEmitter {
  private _events: Record<string, Function[]> = {};

  on(event: string, listener: Function) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(listener);
    return this;
  }

  addListener(event: string, listener: Function) {
    return this.on(event, listener);
  }

  once(event: string, listener: Function) {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      listener.apply(this, args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: Function) {
    if (!this._events[event]) return this;
    this._events[event] = this._events[event].filter((l) => l !== listener);
    return this;
  }

  removeListener(event: string, listener: Function) {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string) {
    if (event) {
      delete this._events[event];
    } else {
      this._events = {};
    }
    return this;
  }

  emit(event: string, ...args: any[]) {
    if (!this._events[event]) return false;
    this._events[event].forEach((fn) => {
      try {
        fn(...args);
      } catch (err) {
        console.error('EventEmitter error:', err);
      }
    });
    return true;
  }
}

export default EventEmitter;

