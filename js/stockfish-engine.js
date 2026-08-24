// Wraps Stockfish (WASM/asm.js, loaded from CDN into a Web Worker) behind a small
// promise-based evaluate() API. Tries a few CDN builds in order since worker/wasm
// loading can be flaky depending on the browser and network.

// Note: newer Stockfish (16.x) builds are WASM + an emscripten loader that resolves
// its .wasm file relative to the script's own URL. That resolution breaks when the
// engine is loaded into a Worker via a blob: URL (our only cross-origin-safe option),
// so we stick to the classic, self-contained asm.js build — no external file fetch,
// same UCI-over-postMessage protocol, just slower per-move.
const STOCKFISH_SOURCES = [
  'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/stockfish.asm.js',
  'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/stockfish.js',
  'https://unpkg.com/stockfish@10.0.2/src/stockfish.asm.js',
];

class StockfishEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.queue = [];
    this.busy = false;
    this._currentJob = null;
    this._lastScore = null;
    this._lastPv = null;
  }

  async init(onStatus) {
    let lastErr = null;
    for (const src of STOCKFISH_SOURCES) {
      try {
        onStatus && onStatus('Chargement du moteur Stockfish (' + src.split('/').pop() + ')…');
        await this._tryLoad(src);
        this.ready = true;
        return;
      } catch (e) {
        lastErr = e;
        console.warn('Source Stockfish indisponible:', src, e);
        if (this.worker) { try { this.worker.terminate(); } catch (_) {} this.worker = null; }
      }
    }
    throw new Error('Impossible de charger Stockfish depuis les CDN disponibles. ' + (lastErr ? lastErr.message || lastErr : ''));
  }

  _tryLoad(src) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let blobUrl;
      try {
        const workerCode = "try{importScripts('" + src + "');}catch(e){postMessage('__LOAD_ERROR__:'+e.message);}";
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        this.worker = new Worker(blobUrl);
      } catch (e) {
        reject(e);
        return;
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { this.worker.terminate(); } catch (_) {}
          reject(new Error('timeout de chargement'));
        }
      }, 15000);

      this.worker.onerror = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(e.message || 'erreur worker'));
        }
      };

      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line.startsWith('__LOAD_ERROR__')) {
          if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(line)); }
          return;
        }
        if (line === 'uciok') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this._attachMessageHandler();
            resolve();
          }
        }
      };

      this.worker.postMessage('uci');
    });
  }

  _attachMessageHandler() {
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : (e.data && e.data.data) || '';
      if (!this._currentJob) return;

      if (line.startsWith('info') && line.indexOf(' pv ') !== -1) {
        const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
        const pvMatch = line.match(/ pv (.+)/);
        if (scoreMatch) {
          this._lastScore = { type: scoreMatch[1], value: parseInt(scoreMatch[2], 10) };
        }
        if (pvMatch) {
          this._lastPv = pvMatch[1].trim().split(' ');
        }
      }

      if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        const bestMove = parts[1];
        const job = this._currentJob;
        this._currentJob = null;
        this.busy = false;

        const result = {
          bestMove: bestMove === '(none)' ? null : bestMove,
          score: this._lastScore || { type: 'cp', value: 0 },
          pv: this._lastPv || [],
        };
        this._lastScore = null;
        this._lastPv = null;

        job.resolve(result);
        this._processQueue();
      }
    };
  }

  evaluate(fen, depth, movetimeMs) {
    return new Promise((resolve) => {
      this.queue.push({ fen, depth, movetimeMs, resolve });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.busy || this.queue.length === 0 || !this.worker) return;
    this.busy = true;
    const job = this.queue.shift();
    this._currentJob = job;
    this.worker.postMessage('ucinewgame');
    this.worker.postMessage('position fen ' + job.fen);
    const depthPart = job.depth ? ' depth ' + job.depth : '';
    const movetimePart = job.movetimeMs ? ' movetime ' + job.movetimeMs : '';
    this.worker.postMessage('go' + depthPart + movetimePart);
  }

  terminate() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) {}
      this.worker = null;
    }
  }
}
