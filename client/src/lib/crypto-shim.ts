import { Buffer } from 'buffer';
import aes from '@cryptography/aes';

class Counter {
  _counter: Buffer;
  constructor(initialValue: any) {
    this._counter = Buffer.from(initialValue);
  }
  increment() {
    for (let i = 15; i >= 0; i--) {
      if (this._counter[i] === 255) {
        this._counter[i] = 0;
      } else {
        this._counter[i]++;
        break;
      }
    }
  }
}

function ab2i(ab: any): Uint32Array {
  const byteView = new Uint8Array(ab);
  const intView = new Uint32Array(byteView.length / 4);
  for (let i = 0; i < intView.length; i++) {
    intView[i] =
      ((byteView[i * 4] << 24) |
        (byteView[i * 4 + 1] << 16) |
        (byteView[i * 4 + 2] << 8) |
        byteView[i * 4 + 3]) >>>
      0;
  }
  return intView;
}

function i2ab(intView: any): Uint8Array {
  const byteView = new Uint8Array(intView.length * 4);
  for (let i = 0; i < intView.length; i++) {
    const int = intView[i];
    byteView[i * 4] = (int >>> 24) & 255;
    byteView[i * 4 + 1] = (int >>> 16) & 255;
    byteView[i * 4 + 2] = (int >>> 8) & 255;
    byteView[i * 4 + 3] = int & 255;
  }
  return byteView;
}

function getWords(key: any): number[] {
  if (key instanceof Uint8Array) {
    return Array.from(ab2i(key));
  }
  if (Array.isArray(key)) {
    return key;
  }
  return Array.from(ab2i(Buffer.from(key)));
}

class CTR {
  _counter: Counter;
  _remainingCounter: Buffer | undefined;
  _remainingCounterIndex: number = 16;
  _aes: any;

  constructor(key: any, counter: any) {
    if (!(counter instanceof Counter)) {
      counter = new Counter(counter);
    }
    this._counter = counter;
    this._remainingCounter = undefined;
    this._remainingCounterIndex = 16;
    this._aes = new (aes as any)(getWords(key));
  }

  update(plainText: any): Buffer {
    return this.encrypt(plainText);
  }

  encrypt(plainText: any): Buffer {
    const encrypted = Buffer.from(plainText);
    for (let i = 0; i < encrypted.length; i++) {
      if (this._remainingCounterIndex === 16) {
        this._remainingCounter = Buffer.from(i2ab(this._aes.encrypt(ab2i(this._counter._counter))));
        this._remainingCounterIndex = 0;
        this._counter.increment();
      }
      if (this._remainingCounter) {
        encrypted[i] ^= this._remainingCounter[this._remainingCounterIndex++];
      }
    }
    return encrypted;
  }
}

export class Hash {
  algorithm: string;
  data: Uint8Array | null = null;

  constructor(algorithm: string) {
    this.algorithm = algorithm;
  }

  update(data: any): this {
    this.data = new Uint8Array(data);
    return this;
  }

  async digest(): Promise<Buffer> {
    if (this.data) {
      const cryptoObj = globalThis.crypto || (typeof window !== 'undefined' ? window.crypto : undefined);
      const subtle = cryptoObj?.subtle;
      if (!subtle) {
        throw new Error('Web Crypto API (crypto.subtle) is not available');
      }
      const algo = this.algorithm.toLowerCase();
      if (algo === 'sha1' || algo === 'sha-1') {
        return Buffer.from(await subtle.digest('SHA-1', this.data as any));
      } else if (algo === 'sha256' || algo === 'sha-256') {
        return Buffer.from(await subtle.digest('SHA-256', this.data as any));
      } else if (algo === 'sha512' || algo === 'sha-512') {
        return Buffer.from(await subtle.digest('SHA-512', this.data as any));
      }
    }
    return Buffer.alloc(0);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

export function createCipheriv(_algorithm: string, key: any, iv: any): CTR {
  return new CTR(key, iv);
}

export function createDecipheriv(_algorithm: string, key: any, iv: any): CTR {
  return new CTR(key, iv);
}

export function randomBytes(count: number): Buffer {
  const bytes = new Uint8Array(count);
  const cryptoObj = globalThis.crypto || (typeof window !== 'undefined' ? window.crypto : undefined);
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  }
  return Buffer.from(bytes);
}

export async function pbkdf2Sync(password: any, salt: any, iterations: number, ..._args: any[]): Promise<Buffer> {
  const cryptoObj = globalThis.crypto || (typeof window !== 'undefined' ? window.crypto : undefined);
  const subtle = cryptoObj?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available');
  }
  const passwordKey = await subtle.importKey('raw', password, { name: 'PBKDF2' }, false, ['deriveBits']);
  return Buffer.from(
    await subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-512',
        salt,
        iterations,
      },
      passwordKey,
      512
    )
  );
}

const cryptoShim: any = {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  Counter,
  CTR,
  Hash,
};
cryptoShim.default = cryptoShim;

export default cryptoShim;
