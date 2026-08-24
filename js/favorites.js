// Persists favorited opening variations in localStorage so they're one click away next
// time, across sessions. Keyed by "familyId::variationName" rather than an array index —
// indices shift if openings-data.js gets reordered/edited, names don't.

const Favorites = {
  STORAGE_KEY: 'chesscoach:favorites',
  _cache: null,

  _load() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      this._cache = raw ? JSON.parse(raw) : [];
    } catch (e) {
      this._cache = [];
    }
    return this._cache;
  },

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._cache));
    } catch (e) {
      console.warn('Favorites: impossible d\'enregistrer', e);
    }
  },

  keyFor(familyId, variationName) {
    return familyId + '::' + variationName;
  },

  has(familyId, variationName) {
    return this._load().indexOf(this.keyFor(familyId, variationName)) !== -1;
  },

  // Returns the new state (true = now favorited) so callers don't need a follow-up has().
  toggle(familyId, variationName) {
    const list = this._load();
    const key = this.keyFor(familyId, variationName);
    const idx = list.indexOf(key);
    if (idx === -1) {
      list.push(key);
      this._save();
      return true;
    }
    list.splice(idx, 1);
    this._save();
    return false;
  },

  count() {
    return this._load().length;
  },
};
