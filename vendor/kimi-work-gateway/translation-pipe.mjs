import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class TranslationPipe extends EventEmitter {
  constructor(readable, writable, { maxBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.readable = readable;
    this.writable = writable;
    this.maxBytes = maxBytes;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.data = chunk => this.receive(chunk);
    this.ended = () => this.dispose('translation_pipe_closed');
    readable.on('data', this.data);
    readable.on('end', this.ended);
    readable.on('error', this.ended);
    writable.on('error', this.ended);
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > this.maxBytes) { this.dispose('translation_pipe_message_too_large'); return; }
    let at;
    while ((at = this.buffer.indexOf('\0')) !== -1) {
      const text = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      const waiting = this.pending.get(message.id);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(message.id);
        if (message.error) waiting.reject(Error('translation_protocol_error'));
        else waiting.resolve(message.result || {});
      } else if (typeof message.method === 'string') {
        this.emit('message', message);
      }
    }
  }

  send(method, params = {}, sessionId, timeout = 10000) {
    if (this.closed) return Promise.reject(Error('translation_pipe_closed'));
    if (this.pending.size >= 128) return Promise.reject(Error('translation_protocol_busy'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('translation_protocol_timeout'));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      try {
        this.writable.write(JSON.stringify(message) + '\0', error => {
          if (error) this.dispose('translation_pipe_closed');
        });
      } catch { this.dispose('translation_pipe_closed'); }
    });
  }

  dispose(reason = 'translation_pipe_closed') {
    if (this.closed) return;
    this.closed = true;
    this.readable.off('data', this.data);
    this.readable.off('end', this.ended);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(reason));
    }
    this.pending.clear();
    this.buffer = '';
    this.emit('closed', reason);
  }
}
