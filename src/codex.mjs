import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class CodexClient extends EventEmitter {
  #nextId = 1;
  #pending = new Map();
  #child;

  constructor(executable, cwd) {
    super();
    this.closed = false;
    this.stderr = '';
    this.#child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.setEncoding('utf8').on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    this.#child.stdin.on('error', (error) => this.#end(error));
    this.#child.on('error', (error) => this.#end(error));
    this.#child.on('close', (code, signal) => {
      this.#end(new Error(`Codex 进程已退出（${signal ?? code}）`));
    });
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
      .on('line', (line) => this.#handle(line));
    this.ready = this.call('initialize', {
      clientInfo: { name: 'guagrid', title: 'GuaGrid', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }).then(() => this.#send({ method: 'initialized' }));
  }

  call(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex 进程已断开'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex ${method} 响应超时`));
      }, 90_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handle(line) {
    if (this.closed || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr = (this.stderr + '\n' + line).slice(-2000);
      return;
    }
    if (message.method) {
      if (message.id !== undefined) {
        this.#send({ id: message.id, error: { code: -32601, message: `Unsupported request: ${message.method}` } });
      } else {
        this.emit('notification', message);
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  #end(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.emit('disconnect', error);
  }

  close() {
    this.#end(new Error('Codex 会话已断开'));
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGTERM');
    }
  }
}
