// Controller: wires the UI, chess.com import, and Stockfish analysis together.

// The @chrisoakman/chessboardjs npm package ships no piece images at all (dist/ only
// has css+js), so we point at the official chessboardjs.com site's own asset folder —
// the same images the library's own demos use.
const PIECE_THEME = 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png';

const state = {
  games: [],
  allErrors: [],
  selectedGameIndex: -1,
  selectedErrorIndex: -1,
  engine: null,
  board: null,
  importing: false,
  currentError: null,
  pvIndex: 0,
  pvMode: 'good',
  recurringClusters: [],
  importBarCollapsed: false,
};

document.addEventListener('DOMContentLoaded', init);

function init() {
  state.board = Chessboard('board', { position: 'start', pieceTheme: PIECE_THEME });
  document.getElementById('importBtn').addEventListener('click', onImport);
  document.getElementById('prevErrBtn').addEventListener('click', () => navigateError(-1));
  document.getElementById('nextErrBtn').addEventListener('click', () => navigateError(1));
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  window.addEventListener('resize', () => state.board && state.board.resize());
  document.getElementById('clearCacheBtn').addEventListener('click', onClearCache);
  document.getElementById('pvPrevBtn').addEventListener('click', pvPrev);
  document.getElementById('pvNextBtn').addEventListener('click', pvNext);
  document.getElementById('pvModeGoodBtn').addEventListener('click', () => pvSetMode('good'));
  document.getElementById('pvModeBadBtn').addEventListener('click', () => pvSetMode('bad'));
  document.getElementById('seeAllRecurringBtn').addEventListener('click', () => switchTab('recurring'));
  document.getElementById('recurringPreview').addEventListener('click', onRecurringClick);
  document.getElementById('recurringList').addEventListener('click', onRecurringClick);
  document.getElementById('viewCacheBtn').addEventListener('click', onViewCache);
  document.getElementById('changePseudoBtn').addEventListener('click', expandImportBar);
  updateCacheInfo();
}

// The import bar (pseudo/cadence/nombre + le bouton) and the cache bar only matter on
// the analysis screen — hide both elsewhere. On the analysis screen itself, the full
// form collapses to a compact "👤 pseudo · cadence" summary once an import has actually
// been triggered, so it stops eating header space once it's done its job.
function updateHeaderVisibility() {
  const isAnalysis = typeof opState === 'undefined' || opState.screen === 'analysis';
  document.getElementById('cacheBar').classList.toggle('hidden', !isAnalysis);
  document.getElementById('importBar').classList.toggle('hidden', !isAnalysis || state.importBarCollapsed);
  document.getElementById('importSummary').classList.toggle('hidden', !isAnalysis || !state.importBarCollapsed);
}

function collapseImportBar(username, timeClass) {
  state.importBarCollapsed = true;
  const timeClassLabels = { rapid: 'Rapide', blitz: 'Blitz', bullet: 'Bullet', daily: 'Correspondance' };
  document.getElementById('importSummaryText').innerHTML =
    '👤 <strong>' + escapeHtml(username) + '</strong> · ' + escapeHtml(timeClassLabels[timeClass] || timeClass);
  updateHeaderVisibility();
}

function expandImportBar() {
  state.importBarCollapsed = false;
  updateHeaderVisibility();
  document.getElementById('username').focus();
}

// Loads whatever is already in the cache straight into the UI — no chess.com API call,
// no Stockfish, just localStorage reads. Lets the user revisit a previous analysis
// (e.g. after closing the app) without re-typing a pseudo or waiting on anything.
function onViewCache() {
  if (state.importing) return;

  const games = GameCache.getAllGames();
  if (!games.length) {
    setStatus('Le cache est vide pour l\'instant — importe des parties une première fois.', 0);
    showStatus(true);
    return;
  }

  hideEmptyState();
  state.games = games.map((g, i) => Object.assign({}, g, { index: i, errors: migrateCachedErrors(g.errors) }));
  state.allErrors = [];
  state.games.forEach((g, i) => {
    g.errors.forEach((err) => state.allErrors.push(Object.assign({ gameIndex: i }, err)));
  });
  state.selectedGameIndex = -1;
  state.selectedErrorIndex = -1;

  renderGamesList(state);
  showWorkspace(true);
  state.board.resize();
  renderSummary(Analyzer.summarize(state.allErrors));
  state.recurringClusters = Analyzer.findRecurringPositions(state.allErrors, 2);
  renderRecurringPreview(state.recurringClusters);
  renderRecurringList(state.recurringClusters);

  switchTab('games');
  selectGame(0);
  setStatus(games.length + ' partie(s) chargée(s) depuis le cache — aucun appel réseau, aucune analyse.', 100);
  showStatus(true);
}

function onRecurringClick(e) {
  const target = e.target.closest('[data-game]');
  if (!target) return;
  const gameIndex = parseInt(target.dataset.game, 10);
  const ply = parseInt(target.dataset.ply, 10);
  jumpToError(gameIndex, ply);
}

function jumpToError(gameIndex, ply) {
  const game = state.games[gameIndex];
  if (!game) return;
  const idx = game.errors.findIndex((e) => e.ply === ply);
  if (idx === -1) return;
  state.selectedGameIndex = gameIndex;
  state.board.orientation(game.playerColor === 'w' ? 'white' : 'black');
  renderGamesList(state);
  selectError(idx);
  switchTab('errors');
}

function updateCacheInfo() {
  const n = GameCache.count();
  document.getElementById('cacheInfo').textContent =
    n > 0 ? n + '/' + GameCache.MAX_ENTRIES + ' partie(s) en cache (analyse instantanée)' : 'Aucune partie en cache';
}

function onClearCache() {
  if (state.importing) return;
  const n = GameCache.clearAll();
  updateCacheInfo();
  setStatus(n > 0 ? 'Cache vidé (' + n + ' partie(s)) — le prochain import ré-analysera tout.' : 'Le cache était déjà vide.', 0);
  showStatus(true);
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
}

async function onImport() {
  const username = document.getElementById('username').value.trim();
  const timeClass = document.getElementById('timeClass').value;
  const numGames = Math.max(5, Math.min(30, parseInt(document.getElementById('numGames').value, 10) || 20));

  if (!username) { alert('Entre ton pseudo chess.com.'); return; }
  if (state.importing) return;

  state.importing = true;
  setImportButtonState(true);
  showStatus(true);
  hideEmptyState();
  setStatus('Connexion à chess.com…', 0);

  try {
    if (!state.engine) {
      state.engine = new StockfishEngine();
      await state.engine.init((msg) => setStatus(msg, 0));
    }

    setStatus('Récupération de tes ' + numGames + ' dernières parties (' + timeClass + ')…', 2);
    const rawGames = await ChessComAPI.getRecentGames(username, timeClass, numGames);

    if (rawGames.length === 0) {
      setStatus('Aucune partie "' + timeClass + '" trouvée pour ce pseudo.', 0);
      return;
    }

    collapseImportBar(username, timeClass);
    state.games = rawGames.map((g, i) => buildGameRecord(g, username, i));
    state.allErrors = [];
    state.selectedGameIndex = -1;
    state.selectedErrorIndex = -1;
    renderGamesList(state);
    showWorkspace(true);
    // chessboard.js measures its container's width once, at construction time — but
    // #workspace was display:none back then (0 width), so the board rendered at 0x0.
    // Now that the section is visible, force it to re-measure and lay itself out.
    state.board.resize();
    switchTab('games');

    for (let i = 0; i < state.games.length; i++) {
      const game = state.games[i];
      const basePct = Math.round((i / state.games.length) * 100);
      const cached = GameCache.get(game.url);

      if (cached) {
        game.errors = migrateCachedErrors(cached.errors);
        game.plyCount = cached.plyCount;
        game.analyzed = true;
        game.fromCache = true;
        setStatus('Partie ' + (i + 1) + '/' + state.games.length + ' — vs ' + game.opponent + ' (déjà en cache, instantané)', basePct);
        // Backfill game metadata (opponent, result, date...) onto older cache entries
        // that predate "Voir les parties en cache" — cheap localStorage write, no
        // Stockfish involved, so it doesn't cost anything on a cache hit.
        if (!cached.opponent) {
          GameCache.set(game.url, {
            errors: game.errors, plyCount: game.plyCount, url: game.url, endTime: game.endTime,
            playerColor: game.playerColor, opponent: game.opponent, opponentRating: game.opponentRating,
            result: game.result,
          });
        }
      } else {
        game.analyzing = true;
        renderGamesList(state);
        setStatus('Analyse partie ' + (i + 1) + '/' + state.games.length + ' — vs ' + game.opponent + '…', basePct);

        try {
          const { errors, plyCount } = await Analyzer.analyzeGame(game.pgn, game.playerColor, state.engine, {
            onPly: (done, total) => {
              const framePct = total ? done / total : 0;
              const overall = Math.round(((i + framePct) / state.games.length) * 100);
              setProgressFill(overall);
              document.getElementById('statusText').textContent =
                'Analyse partie ' + (i + 1) + '/' + state.games.length + ' — vs ' + game.opponent + ' (coup ' + done + '/' + total + ')';
            },
          });
          game.errors = errors;
          game.plyCount = plyCount;
          game.analyzed = true;
          GameCache.set(game.url, {
            errors, plyCount, url: game.url, endTime: game.endTime, playerColor: game.playerColor,
            opponent: game.opponent, opponentRating: game.opponentRating, result: game.result,
          });
          updateCacheInfo();
        } catch (e) {
          console.error('Erreur analyse partie', game.url, e);
          game.error = e.message;
        }

        game.analyzing = false;
      }

      (game.errors || []).forEach((err) => state.allErrors.push(Object.assign({ gameIndex: i }, err)));
      renderGamesList(state);
      renderSummary(Analyzer.summarize(state.allErrors));
      state.recurringClusters = Analyzer.findRecurringPositions(state.allErrors, 2);
      renderRecurringPreview(state.recurringClusters);
      renderRecurringList(state.recurringClusters);

      if (state.selectedGameIndex === -1 && game.errors && game.errors.length) {
        selectGame(i);
      }
    }

    setStatus('Analyse terminée : ' + state.games.length + ' parties, ' + state.allErrors.length + ' erreur(s) détectée(s).', 100);
  } catch (e) {
    console.error(e);
    setStatus('Erreur : ' + e.message, 0);
  } finally {
    state.importing = false;
    setImportButtonState(false);
  }
}

// Fills in fields the analyzer has grown since some entries were cached (e.g. pvMoves,
// added for the on-board PV player). Cached errors already carry the raw engine PV
// (pvBefore), so this is pure client-side chess.js work — no Stockfish, no re-analysis.
// Also drops the old "Position déjà difficile" entries: those flagged played-move-equals-
// engine's-own-top-choice, which is pure search noise, not a real mistake — the analyzer
// no longer creates them, so old cached ones are filtered out here instead of lingering.
function migrateCachedErrors(errors) {
  return errors
    .filter((err) => err.theme !== 'Position déjà difficile')
    // Drop errors that turn out to be known opening theory (checked against the book
    // added after these were cached) — same rule the analyzer now applies up front.
    .filter((err) => !Analyzer.isBookPosition(err.fenAfter))
    .map((err) => {
      if (err.pvMoves) return err;
      if (err.pvBefore && err.pvBefore.length) {
        const pv = Analyzer.buildPvLine(err.fenBefore, err.pvBefore, 6);
        return Object.assign({}, err, { pvMoves: pv.moves, pvLine: err.pvLine || pv.sanLine });
      }
      return Object.assign({}, err, { pvMoves: [] });
    });
}

function buildGameRecord(g, username, index) {
  const isWhite = (g.white.username || '').toLowerCase() === username.toLowerCase();
  const playerColor = isWhite ? 'w' : 'b';
  const opponent = isWhite ? g.black.username : g.white.username;
  const opponentRating = isWhite ? g.black.rating : g.white.rating;
  const myResult = isWhite ? g.white.result : g.black.result;
  const oppResult = isWhite ? g.black.result : g.white.result;
  let result = 'draw';
  if (myResult === 'win') result = 'win';
  else if (oppResult === 'win') result = 'loss';

  return {
    index, pgn: g.pgn, url: g.url, endTime: g.end_time,
    playerColor, opponent, opponentRating, result,
    errors: [], analyzed: false, analyzing: false, plyCount: 0, error: null, fromCache: false,
  };
}

function selectGame(i) {
  state.selectedGameIndex = i;
  state.selectedErrorIndex = -1;
  const game = state.games[i];
  state.board.orientation(game.playerColor === 'w' ? 'white' : 'black');
  renderGamesList(state);
  renderErrorList(state);
  if (game.errors && game.errors.length) {
    selectError(0);
  } else {
    state.currentError = null;
    state.board.position('start');
    document.getElementById('moveInfo').textContent = '—';
    document.getElementById('explainBox').classList.add('hidden');
    document.getElementById('pvSection').classList.add('hidden');
  }
  switchTab('errors');
}

function selectError(idx) {
  const game = state.games[state.selectedGameIndex];
  if (!game || !game.errors[idx]) return;
  state.selectedErrorIndex = idx;
  renderErrorList(state);
  showErrorOnBoard(game.errors[idx]);
}

function navigateError(delta) {
  const game = state.games[state.selectedGameIndex];
  if (!game || !game.errors.length) return;
  let next = state.selectedErrorIndex + delta;
  if (next < 0) next = game.errors.length - 1;
  if (next >= game.errors.length) next = 0;
  selectError(next);
}

function showErrorOnBoard(err) {
  state.currentError = err;
  state.pvIndex = 0;

  const bestSan = err.bestSanBefore || bestSanFromUci(err.fenBefore, err.bestMoveBefore);
  document.getElementById('moveInfo').textContent =
    err.san + ' joué — coup conseillé : ' + bestSan;

  const display = scoreToWhiteDisplay(err.fenBefore, err.scoreBefore);
  document.getElementById('evalFill').style.width = evalBarPercent(display) + '%';
  document.getElementById('evalText').textContent = formatScoreDisplay(display);

  document.getElementById('explainBox').classList.remove('hidden');
  document.getElementById('explainBad').textContent = err.explainBad || '';
  document.getElementById('explainGood').textContent = err.explainGood || '';

  // Both lines can always be computed on demand (see ensurePvForMode) — fenBefore and
  // fenAfter always exist — so the buttons stay enabled even when nothing is cached yet.
  state.pvMode = 'good';
  document.getElementById('pvSection').classList.remove('hidden');
  const goodBtn = document.getElementById('pvModeGoodBtn');
  const badBtn = document.getElementById('pvModeBadBtn');
  goodBtn.disabled = false;
  badBtn.disabled = false;
  goodBtn.classList.add('active');
  badBtn.classList.remove('active');

  renderPvStep(false);
}

async function pvSetMode(mode) {
  const err = state.currentError;
  if (!err || state.pvMode === mode) return;
  state.pvMode = mode;
  state.pvIndex = 0;
  document.getElementById('pvModeGoodBtn').classList.toggle('active', mode === 'good');
  document.getElementById('pvModeBadBtn').classList.toggle('active', mode === 'bad');
  renderPvStep(false);
}

// Older cached errors (analyzed before the PV player / punishment line existed) don't
// carry pvMoves/punishPvMoves — nothing was ever computed for them. Rather than leave
// the feature permanently broken for anything already in the cache, run a single
// Stockfish evaluation on just that one position (~1-4s, not a whole game) the first
// time it's needed, then patch the result into both the live error object and the
// cache so it's instant from then on.
async function ensurePvForMode(err, mode) {
  const hasLine = mode === 'good' ? err.pvLine : err.punishPvLine;
  if (hasLine) return true;

  const btn = document.getElementById('pvNextBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Calcul…';

  let ok = false;
  try {
    if (!state.engine) {
      state.engine = new StockfishEngine();
      await state.engine.init((msg) => setStatus(msg, 0));
    }
    const fen = mode === 'good' ? err.fenBefore : err.fenAfter;
    const result = await state.engine.evaluate(fen, Analyzer.DEPTH, Analyzer.MOVETIME_MS);
    const built = Analyzer.buildPvLine(fen, result.pv, 6);
    if (mode === 'good') {
      err.pvLine = built.sanLine;
      err.pvMoves = built.moves;
    } else {
      err.punishPvLine = built.sanLine;
      err.punishPvMoves = built.moves;
    }
    ok = !!built.sanLine;
    persistGameErrorsToCache(state.selectedGameIndex);
  } catch (e) {
    console.error('Impossible de calculer la suite', e);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
  return ok;
}

function persistGameErrorsToCache(gameIndex) {
  const game = state.games[gameIndex];
  if (!game || !game.url) return;
  GameCache.set(game.url, {
    errors: game.errors, plyCount: game.plyCount, url: game.url, endTime: game.endTime,
    playerColor: game.playerColor, opponent: game.opponent, opponentRating: game.opponentRating,
    result: game.result,
  });
}

// Two lines, picked via state.pvMode:
// 'good' — the engine's suggested alternative, played out from fenBefore (proves what
//          you should have done). Same red/green highlight as before at step 0.
// 'bad'  — the engine's own best continuation for the OPPONENT from fenAfter, i.e. how
//          the mistake actually gets punished move by move (proves *why* it was wrong).
// pvNext()/pvPrev() step through whichever line is active, highlighting each move blue.
function renderPvStep(animate) {
  const err = state.currentError;
  if (!err) return;
  const isGood = state.pvMode !== 'bad';
  const moves = (isGood ? err.pvMoves : err.punishPvMoves) || [];
  const baseFen = isGood ? err.fenBefore : err.fenAfter;
  document.getElementById('explainPv').textContent = (isGood ? err.pvLine : err.punishPvLine) || '';

  if (state.pvIndex <= 0) {
    state.board.position(baseFen, !!animate);
    clearHighlights();
    highlightSquares([err.from, err.to], 'sq-bad');
    if (isGood) {
      const bestParsed = Analyzer.parseUci(err.bestMoveBefore);
      if (bestParsed) highlightSquares([bestParsed.from, bestParsed.to], 'sq-good');
    }
    document.getElementById('pvStepLabel').textContent = isGood ? 'Position de départ' : 'Juste après ton coup';
  } else {
    const mv = moves[state.pvIndex - 1];
    state.board.position(mv.fen, !!animate);
    clearHighlights();
    highlightSquares([mv.from, mv.to], 'sq-pv');
    document.getElementById('pvStepLabel').textContent = 'Coup ' + state.pvIndex + '/' + moves.length + ' — ' + mv.san;
  }

  document.getElementById('pvPrevBtn').disabled = state.pvIndex <= 0;
  const nextBtn = document.getElementById('pvNextBtn');
  // moves.length === 0 at index 0 means "not computed yet", not "empty line" — that
  // case must still show an enabled, clickable "Voir la suite/punition" button so
  // pvNext()'s on-demand computation can actually be triggered.
  const atEnd = moves.length > 0 && state.pvIndex >= moves.length;
  nextBtn.disabled = atEnd;
  nextBtn.textContent = atEnd
    ? 'Fin de la ligne'
    : (state.pvIndex === 0 ? (isGood ? 'Voir la suite ▶' : 'Voir la punition ▶') : 'Coup suivant ▶');
}

async function pvNext() {
  const err = state.currentError;
  if (!err) return;
  let moves = (state.pvMode !== 'bad' ? err.pvMoves : err.punishPvMoves) || [];

  if (state.pvIndex === 0 && moves.length === 0) {
    const ok = await ensurePvForMode(err, state.pvMode);
    if (state.currentError !== err) return; // user moved on while we were computing
    if (!ok) return;
    moves = (state.pvMode !== 'bad' ? err.pvMoves : err.punishPvMoves) || [];
    document.getElementById('explainPv').textContent = (state.pvMode !== 'bad' ? err.pvLine : err.punishPvLine) || '';
  }

  if (state.pvIndex >= moves.length) return;
  state.pvIndex++;
  renderPvStep(true);
}

function pvPrev() {
  if (state.pvIndex <= 0) return;
  state.pvIndex--;
  renderPvStep(true);
}

function clearHighlights() {
  document.querySelectorAll('#board .sq-bad, #board .sq-good, #board .sq-pv').forEach((el) => {
    el.classList.remove('sq-bad', 'sq-good', 'sq-pv');
  });
}

function highlightSquares(squares, cls) {
  squares.forEach((sq) => {
    if (!sq) return;
    const el = document.querySelector('#board [data-square="' + sq + '"]');
    if (el) el.classList.add(cls);
  });
}
