// Persists per-game analysis results in localStorage, keyed by the game's chess.com
// URL (globally unique). Re-importing skips Stockfish entirely for games already
// analyzed — that's the slow part, not the chess.com fetch.
//
// Capped to MAX_ENTRIES via LRU: every read or write "touches" a game (bumps
// lastAccessed), and once the cap is exceeded the least-recently-touched entries are
// evicted first. So the cache always holds the last MAX_ENTRIES games you've actually
// loaded — analyzed or just revisited — regardless of how many different pseudos or
// import sessions that spans.

const GameCache = {
  PREFIX: 'chesscoach:game:',
  // Bump this if Analyzer's depth/thresholds/output shape changes in a way that makes
  // old cached results stale or incompatible — cache entries tagged with an older
  // version (or a different depth) are treated as misses.
  VERSION: 1,
  MAX_ENTRIES: 100,

  keyFor(gameUrl) {
    return this.PREFIX + gameUrl;
  },

  get(gameUrl) {
    const key = this.keyFor(gameUrl);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.version !== this.VERSION || parsed.depth !== Analyzer.DEPTH) return null;
      this._touch(key, parsed);
      return parsed;
    } catch (e) {
      return null;
    }
  },

  set(gameUrl, data) {
    const key = this.keyFor(gameUrl);
    try {
      let savedAt = Date.now();
      const existing = localStorage.getItem(key);
      if (existing) {
        try { savedAt = JSON.parse(existing).savedAt || savedAt; } catch (e) { /* overwrite with a fresh timestamp */ }
      }
      const payload = Object.assign(
        { version: this.VERSION, depth: Analyzer.DEPTH, savedAt, lastAccessed: Date.now() },
        data
      );
      localStorage.setItem(key, JSON.stringify(payload));
      this._enforceLimit();
    } catch (e) {
      // Quota exceeded or storage disabled (private browsing, etc.) — degrade
      // gracefully, the app still works, it just won't be instant next time.
      console.warn('GameCache: impossible d\'enregistrer le cache pour', gameUrl, e);
    }
  },

  // Rewrites an entry with a fresh lastAccessed so it survives the next eviction pass.
  // Best-effort: a failed touch (e.g. quota momentarily full) shouldn't break the read.
  _touch(key, parsed) {
    try {
      parsed.lastAccessed = Date.now();
      localStorage.setItem(key, JSON.stringify(parsed));
    } catch (e) { /* not fatal — the entry just won't look freshly-touched */ }
  },

  _enforceLimit() {
    const keys = this.allKeys();
    if (keys.length <= this.MAX_ENTRIES) return;
    const entries = keys.map((k) => {
      // Entries written before lastAccessed existed have no such field — fall back to
      // savedAt (still a real timestamp) rather than 0, or they'd all look infinitely
      // old and get evicted first regardless of how recently they were actually saved.
      let lastAccessed = 0;
      try {
        const p = JSON.parse(localStorage.getItem(k));
        lastAccessed = p.lastAccessed || p.savedAt || 0;
      } catch (e) { /* treat as oldest */ }
      return { key: k, lastAccessed };
    });
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
    const excess = entries.length - this.MAX_ENTRIES;
    for (let i = 0; i < excess; i++) localStorage.removeItem(entries[i].key);
  },

  allKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(this.PREFIX) === 0) keys.push(k);
    }
    return keys;
  },

  count() {
    return this.allKeys().length;
  },

  // Reconstructs full game-list entries straight from the cache — no chess.com API call
  // needed. Entries saved before game metadata was cached alongside the analysis (just
  // {errors, plyCount}) are skipped here; they still work fine for normal per-game hits
  // via get(), they just can't be listed standalone until re-analyzed once more.
  // Touches every entry it returns, same as get() — viewing counts as loading.
  getAllGames() {
    const games = [];
    this.allKeys().forEach((k) => {
      let raw;
      try {
        raw = JSON.parse(localStorage.getItem(k));
      } catch (e) {
        return;
      }
      if (!raw || raw.version !== this.VERSION || raw.depth !== Analyzer.DEPTH) return;
      if (!raw.opponent || !raw.url) return;
      this._touch(k, raw);
      games.push({
        pgn: null, url: raw.url, endTime: raw.endTime, playerColor: raw.playerColor,
        opponent: raw.opponent, opponentRating: raw.opponentRating, result: raw.result,
        errors: raw.errors, analyzed: true, analyzing: false, plyCount: raw.plyCount,
        error: null, fromCache: true,
      });
    });
    games.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
    return games;
  },

  clearAll() {
    const keys = this.allKeys();
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  },
};
