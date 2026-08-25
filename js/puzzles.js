// Puzzle trainer — turns every error already found in analyzed games (js/analyzer.js,
// persisted via GameCache) into a tactics puzzle: "here's the position right before the
// mistake, find the move that was actually best." No separate puzzle database needed —
// the positions, the correct move, and the explanation were already computed during
// game analysis.
//
// Difficulty per puzzle is derived from how big the mistake was (bigger loss = harder to
// spot = higher difficulty rating). The player's own rating adapts after every attempt
// using the same win-probability-based update chess sites use for puzzle ratings:
// solving a puzzle rated above you gains more than solving an easy one, and missing an
// easy one costs more than missing a hard one.

const PuzzleProgress = {
  STORAGE_KEY: 'chesscoach:puzzleProgress',
  DEFAULTS: { rating: 1200, points: 0, streak: 0, bestStreak: 0, solved: 0, attempted: 0 },
  K_FACTOR: 32,
  _cache: null,

  _load() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      this._cache = raw ? Object.assign({}, this.DEFAULTS, JSON.parse(raw)) : Object.assign({}, this.DEFAULTS);
    } catch (e) {
      this._cache = Object.assign({}, this.DEFAULTS);
    }
    return this._cache;
  },

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._cache));
    } catch (e) {
      console.warn('PuzzleProgress: impossible d\'enregistrer', e);
    }
  },

  get() {
    return Object.assign({}, this._load());
  },

  // Elo-style update: expected = P(player solves a puzzle of this difficulty), then move
  // the rating toward the actual outcome by K * (outcome - expected). Same idea as
  // lichess/chess.com puzzle ratings.
  record(difficulty, correct) {
    const p = this._load();
    const expected = 1 / (1 + Math.pow(10, (difficulty - p.rating) / 400));
    p.rating = Math.max(600, Math.min(2600, Math.round(p.rating + this.K_FACTOR * ((correct ? 1 : 0) - expected))));
    p.attempted++;

    let pointsGained = 0;
    if (correct) {
      p.solved++;
      p.streak++;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      pointsGained = 10 + Math.max(0, Math.round((difficulty - 1000) / 20)) + Math.min(p.streak * 2, 20);
      p.points += pointsGained;
    } else {
      p.streak = 0;
    }

    this._save();
    return { pointsGained, stats: this.get() };
  },
};

const puzState = {
  board: null,
  chess: null,       // scratch chess.js instance at the puzzle's starting position
  pool: [],
  attemptedKeys: new Set(),
  current: null,
  solved: false,
};

document.addEventListener('DOMContentLoaded', initPuzzles);

function initPuzzles() {
  puzState.board = Chessboard('puzzleBoard', {
    position: 'start',
    pieceTheme: PIECE_THEME,
    draggable: true,
    onDragStart: puzzleOnDragStart,
    onDrop: puzzleOnDrop,
  });

  document.getElementById('navPuzzlesBtn').addEventListener('click', () => switchScreen('puzzles'));
  document.getElementById('puzzleSkipBtn').addEventListener('click', loadNextPuzzle);
  document.getElementById('puzzleNextBtn').addEventListener('click', loadNextPuzzle);

  renderPuzzleStats();
}

// Called by switchScreen() (js/openings.js) whenever the puzzles screen becomes visible.
function onEnterPuzzlesScreen() {
  puzState.board.resize();
  puzState.pool = buildPuzzlePool();
  renderPuzzleStats();
  if (!puzState.current) loadNextPuzzle();
}

function buildPuzzlePool() {
  return GameCache.getAllErrors().map((err) => ({
    key: err.gameUrl + '#' + err.ply,
    fenBefore: err.fenBefore,
    bestMoveBefore: err.bestMoveBefore,
    bestSanBefore: err.bestSanBefore || bestSanFromUci(err.fenBefore, err.bestMoveBefore),
    explainGood: err.explainGood,
    theme: err.theme,
    color: err.color,
    // Loss is centipawns lost by the mistake — a reasonable, already-computed proxy for
    // "how hard is this to spot". Capped so mate-driven synthetic scores (tens of
    // thousands of cp, see Analyzer.cpFromScore) don't blow the scale out.
    difficulty: Math.round(1000 + Math.min(err.loss || 60, 700)),
  }));
}

// Picks a puzzle close to the player's current rating (not always the closest one, or
// it'd be near-deterministic at a given rating) from whatever hasn't been shown yet this
// session; falls back to allowing repeats once the pool is exhausted.
function pickPuzzle() {
  const stats = PuzzleProgress.get();
  const fresh = puzState.pool.filter((p) => !puzState.attemptedKeys.has(p.key));
  const usable = fresh.length ? fresh : puzState.pool;
  if (!usable.length) return null;
  const sorted = usable.slice().sort((a, b) => Math.abs(a.difficulty - stats.rating) - Math.abs(b.difficulty - stats.rating));
  const candidates = sorted.slice(0, Math.min(6, sorted.length));
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function loadNextPuzzle() {
  const puzzle = pickPuzzle();
  const emptyBox = document.getElementById('puzzleEmptyBox');
  const promptEl = document.getElementById('puzzlePrompt');
  const statusRow = document.querySelector('.puzzle-status-row');
  const actions = document.querySelector('.puzzle-actions');
  const themeBox = document.getElementById('puzzleThemeBox');

  if (!puzzle) {
    puzState.current = null;
    clearPuzzleHighlights();
    puzState.board.position('start', false);
    emptyBox.classList.remove('hidden');
    promptEl.classList.add('hidden');
    statusRow.classList.add('hidden');
    actions.classList.add('hidden');
    document.getElementById('puzzleFeedback').classList.add('hidden');
    themeBox.classList.add('hidden');
    return;
  }

  emptyBox.classList.add('hidden');
  promptEl.classList.remove('hidden');
  statusRow.classList.remove('hidden');
  actions.classList.remove('hidden');

  puzState.current = puzzle;
  puzState.solved = false;
  puzState.attemptedKeys.add(puzzle.key);
  puzState.chess = new Chess(puzzle.fenBefore);

  clearPuzzleHighlights();
  puzState.board.orientation(puzzle.color === 'b' ? 'black' : 'white');
  puzState.board.position(puzzle.fenBefore, false);

  document.getElementById('puzzleColorLabel').textContent = puzzle.color === 'b' ? 'Noirs' : 'Blancs';
  document.getElementById('puzzleFeedback').classList.add('hidden');
  document.getElementById('puzzleSkipBtn').classList.remove('hidden');
  document.getElementById('puzzleNextBtn').classList.add('hidden');

  if (puzzle.theme) {
    themeBox.classList.remove('hidden');
    document.getElementById('puzzleThemeValue').textContent = puzzle.theme;
  } else {
    themeBox.classList.add('hidden');
  }
}

function puzzleOnDragStart(source) {
  if (!puzState.current || puzState.solved || !puzState.chess) return false;
  const piece = puzState.chess.get(source);
  if (!piece) return false;
  return piece.color === puzState.chess.turn();
}

function puzzleOnDrop(source, target) {
  if (!puzState.current || puzState.solved || !puzState.chess) return 'snapback';

  const piece = puzState.chess.get(source);
  if (!piece) return 'snapback';
  const needsPromotion = piece.type === 'p' && (target[1] === '8' || target[1] === '1');
  const moveObj = { from: source, to: target };
  if (needsPromotion) moveObj.promotion = 'q';

  const mv = puzState.chess.move(moveObj);
  if (!mv) return 'snapback';

  const resultFen = puzState.chess.fen();
  puzState.chess.undo();

  const uci = source + target + (needsPromotion ? 'q' : '');
  resolvePuzzleAttempt(uci === puzState.current.bestMoveBefore, source, target, resultFen);
  return 'snapback';
}

function resolvePuzzleAttempt(correct, from, to, resultFen) {
  puzState.solved = true;
  const puzzle = puzState.current;
  clearPuzzleHighlights();

  if (correct) {
    puzState.board.position(resultFen, true);
    highlightPuzzleSquares([from, to], 'sq-good');
  } else {
    const bestParsed = Analyzer.parseUci(puzzle.bestMoveBefore);
    highlightPuzzleSquares([from, to], 'sq-bad');
    if (bestParsed) highlightPuzzleSquares([bestParsed.from, bestParsed.to], 'sq-good');
  }

  const { pointsGained, stats } = PuzzleProgress.record(puzzle.difficulty, correct);
  renderPuzzleStats(stats);
  renderPuzzleFeedback(correct, puzzle, pointsGained, stats);

  document.getElementById('puzzleSkipBtn').classList.add('hidden');
  document.getElementById('puzzleNextBtn').classList.remove('hidden');
}

function renderPuzzleFeedback(correct, puzzle, pointsGained, stats) {
  const box = document.getElementById('puzzleFeedback');
  box.classList.remove('hidden', 'is-correct', 'is-incorrect');
  box.classList.add(correct ? 'is-correct' : 'is-incorrect');

  const title = correct ? '✓ Bien vu !' : '✗ Ce n\'était pas le meilleur coup';
  const body = correct
    ? (puzzle.explainGood || (puzzle.bestSanBefore + ' était le meilleur coup.'))
    : ('Le coup à jouer était ' + puzzle.bestSanBefore + '. ' + (puzzle.explainGood || ''));
  const delta = correct
    ? ('+' + pointsGained + ' points — Niveau : ' + stats.rating)
    : ('Pas de points cette fois — Niveau : ' + stats.rating);

  box.innerHTML =
    '<p class="puzzle-feedback-title">' + escapeHtml(title) + '</p>' +
    '<p class="puzzle-feedback-body">' + escapeHtml(body) + '</p>' +
    '<p class="puzzle-feedback-delta">' + escapeHtml(delta) + '</p>';
}

function renderPuzzleStats(stats) {
  stats = stats || PuzzleProgress.get();
  document.getElementById('puzzleRatingValue').textContent = stats.rating;
  document.getElementById('puzzlePointsValue').textContent = stats.points;
  document.getElementById('puzzleStreakValue').textContent = stats.streak;
  document.getElementById('puzzleSolvedValue').textContent = stats.solved;
  document.getElementById('puzzleAttemptedValue').textContent = stats.attempted;
  document.getElementById('puzzleAccuracyValue').textContent =
    stats.attempted ? Math.round((100 * stats.solved) / stats.attempted) + '%' : '—';
  document.getElementById('puzzleBestStreakValue').textContent = stats.bestStreak;
}

function clearPuzzleHighlights() {
  document.querySelectorAll('#puzzleBoard .sq-bad, #puzzleBoard .sq-good').forEach((el) => {
    el.classList.remove('sq-bad', 'sq-good');
  });
}

function highlightPuzzleSquares(squares, cls) {
  squares.forEach((sq) => {
    if (!sq) return;
    const el = document.querySelector('#puzzleBoard [data-square="' + sq + '"]');
    if (el) el.classList.add(cls);
  });
}
