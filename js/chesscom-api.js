// Thin wrapper around the public, read-only chess.com API. No auth, no keys.

const ChessComAPI = {
  async _getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 404) throw new Error("Pseudo introuvable sur chess.com.");
      throw new Error('Erreur chess.com API (' + res.status + ') sur ' + url);
    }
    return res.json();
  },

  async getArchives(username) {
    const data = await this._getJson(
      'https://api.chess.com/pub/player/' + encodeURIComponent(username.toLowerCase()) + '/games/archives'
    );
    return data.archives || [];
  },

  async getMonthGames(archiveUrl) {
    const data = await this._getJson(archiveUrl);
    return data.games || [];
  },

  async getStats(username) {
    try {
      return await this._getJson(
        'https://api.chess.com/pub/player/' + encodeURIComponent(username.toLowerCase()) + '/stats'
      );
    } catch (e) {
      return null;
    }
  },

  // Fetches the most recent `count` games of a given time class (rapid/blitz/bullet/daily),
  // walking back through monthly archives until enough games are found.
  async getRecentGames(username, timeClass, count) {
    const archives = await this.getArchives(username);
    if (archives.length === 0) return [];
    const recentMonths = archives.slice(-8).reverse();
    let collected = [];
    for (const url of recentMonths) {
      const monthGames = await this.getMonthGames(url);
      const filtered = monthGames
        .filter((g) => g.time_class === timeClass && g.rules === 'chess' && g.pgn)
        .reverse();
      collected = collected.concat(filtered);
      if (collected.length >= count) break;
    }
    return collected.slice(0, count);
  },
};
