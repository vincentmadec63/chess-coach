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
  selectedSquare: null,  // tap-to-move: square of the piece currently picked up, if any
  touchStart: null,      // {x, y, square} — tracked manually, see onPuzzleBoardTouchStart
  lastTouchTapAt: 0,     // timestamp of the last tap handled via touch, to swallow the
                         // delayed synthetic 'click' some browsers still fire after it
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

  // Tap-to-move (pick a piece, then tap the destination square), for anyone who finds
  // dragging fiddly on a phone — same interaction chess.com/lichess offer alongside
  // drag. chessboard.js only wires its own touch/mouse handling to squares that have a
  // piece on them (see touchstartSquare in the vendored lib), so a tap on an *empty*
  // destination square never reaches it — the listeners below are what catch that.
  //
  // On touch devices this is handled via raw touchstart/touchend, NOT the synthetic
  // 'click' event: the board has touch-action:none (needed so dragging doesn't scroll
  // the page), and on real iOS Safari that also suppresses the synthetic click a plain
  // tap would otherwise fire — so a click-only implementation silently does nothing on
  // an iPhone even though it worked in every non-touch test. Distance between
  // touchstart/touchend (not "did chessboard.js call onDrop") decides tap vs drag: a
  // real drag is left entirely to chessboard.js's own handling; only a tap (movement
  // under the threshold) is turned into a select/move here. lastTouchTapAt then makes
  // the 'click' listener (kept for desktop mice) ignore the delayed synthetic click
  // that may still follow.
  const boardEl = document.getElementById('puzzleBoard');
  boardEl.addEventListener('touchstart', onPuzzleBoardTouchStart, { passive: true });
  boardEl.addEventListener('touchend', onPuzzleBoardTouchEnd);
  boardEl.addEventListener('click', onPuzzleBoardClick);
  document.getElementById('puzzleSkipBtn').addEventListener('click', loadNextPuzzle);
  document.getElementById('puzzleNextBtn').addEventListener('click', loadNextPuzzle);
  document.getElementById('puzzleRetryBtn').addEventListener('click', retryPuzzle);
  document.getElementById('puzzleHintBtn').addEventListener('click', showPuzzleHint);

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
  document.getElementById('puzzleHintText').classList.add('hidden');
  document.getElementById('puzzleSkipBtn').classList.remove('hidden');
  document.getElementById('puzzleHintBtn').classList.remove('hidden');
  document.getElementById('puzzleRetryBtn').classList.add('hidden');
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
  if (source === target) return 'snapback'; // a tap, not a drag — the click handler owns this case
  deselectPuzzleSquare();
  attemptPuzzleMove(source, target);
  return 'snapback';
}

// Shared by both drag-drop and tap-to-move. Returns true if `from`→`to` was a legal
// move (right or wrong answer, both count as an attempt); false if illegal, so the
// caller knows nothing happened (e.g. to leave the current selection as-is).
function attemptPuzzleMove(from, to) {
  if (!puzState.current || puzState.solved || !puzState.chess) return false;

  const piece = puzState.chess.get(from);
  if (!piece) return false;
  const needsPromotion = piece.type === 'p' && (to[1] === '8' || to[1] === '1');
  const moveObj = { from, to };
  if (needsPromotion) moveObj.promotion = 'q';

  const mv = puzState.chess.move(moveObj);
  if (!mv) return false;

  const resultFen = puzState.chess.fen();
  puzState.chess.undo();

  const uci = from + to + (needsPromotion ? 'q' : '');
  resolvePuzzleAttempt(uci === puzState.current.bestMoveBefore, from, to, resultFen);
  return true;
}

// Distance-based tap detection, independent of chessboard.js's own drag state — see the
// comment in initPuzzles() for why this can't just rely on the synthetic 'click' event.
const TAP_MOVE_THRESHOLD_PX = 12;

function onPuzzleBoardTouchStart(e) {
  if (e.touches.length !== 1) {
    puzState.touchStart = null;
    return;
  }
  const squareEl = e.target && e.target.closest && e.target.closest('[data-square]');
  const t = e.touches[0];
  puzState.touchStart = { x: t.clientX, y: t.clientY, square: squareEl ? squareEl.dataset.square : null };
}

function onPuzzleBoardTouchEnd(e) {
  const start = puzState.touchStart;
  puzState.touchStart = null;
  if (!start || !start.square || e.changedTouches.length !== 1) return;

  const t = e.changedTouches[0];
  const moved = Math.abs(t.clientX - start.x) > TAP_MOVE_THRESHOLD_PX || Math.abs(t.clientY - start.y) > TAP_MOVE_THRESHOLD_PX;
  // Real drags are left entirely to chessboard.js's own touch handling (already wired
  // via draggable:true) — this listener only acts on the "didn't really move" case.
  if (moved) return;

  puzState.lastTouchTapAt = Date.now();
  handlePuzzleTap(start.square);
}

function onPuzzleBoardClick(e) {
  if (Date.now() - puzState.lastTouchTapAt < 500) return; // already handled as a touch tap
  const squareEl = e.target.closest('[data-square]');
  if (!squareEl) return;
  handlePuzzleTap(squareEl.dataset.square);
}

function handlePuzzleTap(square) {
  if (!puzState.current || puzState.solved || !puzState.chess) return;
  const sideToMove = puzState.chess.turn();
  const pieceHere = puzState.chess.get(square);

  if (!puzState.selectedSquare) {
    if (pieceHere && pieceHere.color === sideToMove) selectPuzzleSquare(square);
    return;
  }

  if (square === puzState.selectedSquare) {
    deselectPuzzleSquare();
    return;
  }

  // Tapping another one of your own pieces switches the selection instead of
  // attempting an (illegal) move onto it.
  if (pieceHere && pieceHere.color === sideToMove) {
    selectPuzzleSquare(square);
    return;
  }

  const moved = attemptPuzzleMove(puzState.selectedSquare, square);
  if (!moved) deselectPuzzleSquare();
}

function selectPuzzleSquare(square) {
  clearSelectionHighlights();
  puzState.selectedSquare = square;
  const el = document.querySelector('#puzzleBoard [data-square="' + square + '"]');
  if (el) el.classList.add('sq-selected');
  (puzState.chess.moves({ square, verbose: true }) || []).forEach((m) => {
    const targetEl = document.querySelector('#puzzleBoard [data-square="' + m.to + '"]');
    if (targetEl) targetEl.classList.add('sq-legal');
  });
}

function deselectPuzzleSquare() {
  puzState.selectedSquare = null;
  clearSelectionHighlights();
}

function clearSelectionHighlights() {
  document.querySelectorAll('#puzzleBoard .sq-selected, #puzzleBoard .sq-legal').forEach((el) => {
    el.classList.remove('sq-selected', 'sq-legal');
  });
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
  document.getElementById('puzzleHintBtn').classList.add('hidden');
  document.getElementById('puzzleRetryBtn').classList.remove('hidden');
  document.getElementById('puzzleNextBtn').classList.remove('hidden');
}

// Replays the same puzzle from scratch — useful right after a miss to actually find the
// right move before moving on. Doesn't touch the pool/attemptedKeys or PuzzleProgress:
// a retry is practice, not a new scored attempt (otherwise you could farm points by just
// retrying until correct).
function retryPuzzle() {
  const puzzle = puzState.current;
  if (!puzzle) return;

  puzState.solved = false;
  puzState.chess = new Chess(puzzle.fenBefore);

  clearPuzzleHighlights();
  puzState.board.position(puzzle.fenBefore, false);

  document.getElementById('puzzleFeedback').classList.add('hidden');
  document.getElementById('puzzleHintText').classList.add('hidden');
  document.getElementById('puzzleSkipBtn').classList.remove('hidden');
  document.getElementById('puzzleHintBtn').classList.remove('hidden');
  document.getElementById('puzzleRetryBtn').classList.add('hidden');
  document.getElementById('puzzleNextBtn').classList.add('hidden');
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
  puzState.selectedSquare = null;
  clearSelectionHighlights();
}

// A small nudge, not the answer: names the piece that should move and where it stands
// (chess.com's "hint" glows the piece — this is the same idea in one line of text).
// Doesn't touch rating/points/attempts; purely informational.
function showPuzzleHint() {
  if (!puzState.current || puzState.solved || !puzState.chess) return;
  const hintEl = document.getElementById('puzzleHintText');
  hintEl.textContent = '💡 ' + getPuzzleHint(puzState.current);
  hintEl.classList.remove('hidden');
}

function getPuzzleHint(puzzle) {
  const parsed = Analyzer.parseUci(puzzle.bestMoveBefore);
  const pieceNames = { p: 'pion', n: 'cavalier', b: 'fou', r: 'tour', q: 'dame', k: 'roi' };
  const pieceAt = parsed ? puzState.chess.get(parsed.from) : null;
  if (!pieceAt) return 'Regarde bien la position, coup par coup.';
  return 'Regarde du côté de ta/ton ' + pieceNames[pieceAt.type] + ' en ' + parsed.from + '.';
}

function highlightPuzzleSquares(squares, cls) {
  squares.forEach((sq) => {
    if (!sq) return;
    const el = document.querySelector('#puzzleBoard [data-square="' + sq + '"]');
    if (el) el.classList.add(cls);
  });
}
