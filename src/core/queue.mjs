export class AsyncQueue {
  items = [];
  readers = [];
  ended = false;
  push(value) {
    if (this.ended) throw new Error("Input is closed");
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.items.push(value);
  }
  end() {
    this.ended = true;
    for (const resolve of this.readers.splice(0)) resolve({ done: true });
  }
  next() {
    if (this.items.length)
      return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.readers.push(resolve));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
