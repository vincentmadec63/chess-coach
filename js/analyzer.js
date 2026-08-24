// Turns a PGN + Stockfish evaluations into a list of classified player errors.

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAME_FR = { p: 'pion', n: 'cavalier', b: 'fou', r: 'tour', q: 'dame', k: 'roi' };

const SLIDE_DIRS = {
  b: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  r: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  q: [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]],
};
const KNIGHT_OFFSETS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

const SEVERITY = {
  BLUNDER: 'blunder',
  MISTAKE: 'mistake',
  INACCURACY: 'inaccuracy',
};

// Thresholds are a bit above the textbook 50/100/200 to absorb search noise:
// two fixed-depth asm.js searches on adjacent positions rarely telescope perfectly,
// so a "best" move can still show a small apparent loss purely from horizon effects.
const THRESHOLDS = { inaccuracy: 60, mistake: 120, blunder: 250 };

const Analyzer = {
  DEPTH: 14,
  MOVETIME_MS: 4000,

  // --- board helpers -------------------------------------------------

  squareToRC(sq) {
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1], 10);
    return { row: 8 - rank, col: file };
  },

  parseUci(uci) {
    if (!uci || uci.length < 4) return null;
    return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
  },

  attackedSquares(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];
    const attacks = [];
    const push = (r, c) => { if (r >= 0 && r < 8 && c >= 0 && c < 8) attacks.push({ row: r, col: c }); };
    if (piece.type === 'n') {
      KNIGHT_OFFSETS.forEach(([dr, dc]) => push(row + dr, col + dc));
    } else if (piece.type === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) push(row + dr, col + dc);
    } else if (piece.type === 'p') {
      const dir = piece.color === 'w' ? -1 : 1;
      push(row + dir, col - 1);
      push(row + dir, col + 1);
    } else if (SLIDE_DIRS[piece.type]) {
      SLIDE_DIRS[piece.type].forEach(([dr, dc]) => {
        let r = row + dr, c = col + dc;
        while (r >= 0 && r < 8 && c >= 0 && c < 8) {
          attacks.push({ row: r, col: c });
          if (board[r][c]) break;
          r += dr; c += dc;
        }
      });
    }
    return attacks;
  },

  countForkTargets(board, row, col, enemyColor) {
    const attacks = this.attackedSquares(board, row, col);
    let count = 0;
    for (const a of attacks) {
      const p = board[a.row][a.col];
      if (p && p.color === enemyColor && PIECE_VALUE[p.type] >= 3) count++;
    }
    return count;
  },

  countNonPawnMaterial(board) {
    let total = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type !== 'p' && p.type !== 'k') total++;
    }
    return total;
  },

  // --- score helpers ---------------------------------------------------

  sideToMove(fen) { return fen.split(' ')[1]; },

  cpFromScore(score) {
    if (score.type === 'cp') return score.value;
    const m = score.value;
    return m > 0 ? 100000 - m * 100 : -100000 - m * 100;
  },

  whiteCp(fen, score) {
    const cp = this.cpFromScore(score);
    return this.sideToMove(fen) === 'w' ? cp : -cp;
  },

  // --- opening book (js/openings-data.js) -------------------------------

  // Every position reachable by playing a move from the curated opening book, keyed the
  // same way as positionKey() so clock differences don't break the match. Built once
  // and memoized — OPENINGS is a few hundred moves, cheap to replay with chess.js.
  _bookPositions: null,

  getBookPositions() {
    if (this._bookPositions) return this._bookPositions;
    const set = new Set();
    if (typeof OPENINGS !== 'undefined') {
      OPENINGS.forEach((family) => {
        family.variations.forEach((variation) => {
          const chess = new Chess();
          variation.moves.forEach((m) => {
            const mv = chess.move(m.s, { sloppy: true });
            if (mv) set.add(this.positionKey(chess.fen()));
          });
        });
      });
    }
    this._bookPositions = set;
    return set;
  },

  isBookPosition(fen) {
    return this.getBookPositions().has(this.positionKey(fen));
  },

  sanFromUci(fen, uci) {
    if (!uci) return '?';
    const parsed = this.parseUci(uci);
    if (!parsed) return uci;
    try {
      const temp = new Chess(fen);
      const mv = temp.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
      return mv ? mv.san : uci;
    } catch (e) {
      return uci;
    }
  },

  // Converts a UCI principal variation into a step-by-step replayable line: each move
  // carries its own SAN, from/to squares (for board highlighting) and the resulting FEN
  // (for board.position()), plus a single formatted text line for the error card.
  // Stops at the first illegal/garbage token (engine output sometimes trails junk).
  buildPvLine(fen, pvUci, maxPlies) {
    const temp = new Chess(fen);
    const moves = [];
    for (let i = 0; i < (pvUci || []).length && moves.length < maxPlies; i++) {
      const u = pvUci[i];
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)) break;
      const parsed = this.parseUci(u);
      const mv = temp.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
      if (!mv) break;
      moves.push({ san: mv.san, from: parsed.from, to: parsed.to, fen: temp.fen() });
    }

    let sanLine = '';
    if (moves.length) {
      const parts = fen.split(' ');
      let n = parseInt(parts[5], 10) || 1;
      let stm = parts[1];
      const out = [];
      moves.forEach((mv, i) => {
        if (stm === 'w') {
          out.push(n + '.' + mv.san);
        } else {
          out.push((i === 0 ? n + '...' : '') + mv.san);
          n++;
        }
        stm = stm === 'w' ? 'b' : 'w';
      });
      sanLine = out.join(' ');
    }

    return { moves, sanLine };
  },

  // --- main entry point --------------------------------------------------

  async analyzeGame(pgn, playerColor, engine, opts) {
    opts = opts || {};
    const onPly = opts.onPly || function () {};

    const parser = new Chess();
    if (!parser.load_pgn(pgn, { sloppy: true })) {
      throw new Error('PGN illisible');
    }
    const verboseHistory = parser.history({ verbose: true });

    const replay = new Chess();
    const fens = [replay.fen()];
    for (const mv of verboseHistory) {
      replay.move(mv.san);
      fens.push(replay.fen());
    }

    const engineResults = [];
    for (let i = 0; i < fens.length; i++) {
      const res = await engine.evaluate(fens[i], this.DEPTH, this.MOVETIME_MS);
      engineResults.push(res);
      onPly(i, fens.length - 1);
    }

    const errors = [];
    for (let k = 1; k < fens.length; k++) {
      const mv = verboseHistory[k - 1];
      if (mv.color !== playerColor) continue;

      const fenBefore = fens[k - 1];
      const fenAfter = fens[k];
      const before = engineResults[k - 1];
      const after = engineResults[k];

      const whiteCpBefore = this.whiteCp(fenBefore, before.score);
      const whiteCpAfter = this.whiteCp(fenAfter, after.score);
      const loss = playerColor === 'w' ? (whiteCpBefore - whiteCpAfter) : (whiteCpAfter - whiteCpBefore);

      if (loss < THRESHOLDS.inaccuracy) continue;

      // The played move WAS the engine's own top choice from this position — any
      // apparent "loss" is pure search noise (two fixed-depth searches on adjacent
      // positions not telescoping perfectly), not a real mistake. Nothing to correct
      // here, so don't report it as one.
      const playedUci = mv.from + mv.to + (mv.promotion || '');
      if (playedUci === before.bestMove) continue;

      // The resulting position is a recognized position from the curated opening book
      // (js/openings-data.js) — i.e. the move just played matches known theory exactly,
      // not just "the engine's 3rd choice at low depth". Don't flag known book moves as
      // mistakes just because a shallow search has a marginal preference.
      if (this.isBookPosition(fenAfter)) continue;

      let severity = SEVERITY.INACCURACY;
      if (loss >= THRESHOLDS.blunder) severity = SEVERITY.BLUNDER;
      else if (loss >= THRESHOLDS.mistake) severity = SEVERITY.MISTAKE;

      const bestSanBefore = this.sanFromUci(fenBefore, before.bestMove);
      const { theme, explainBad, explainGood } = this.classify({
        fenBefore, fenAfter, playedUci: mv.from + mv.to + (mv.promotion || ''),
        playedSan: mv.san, bestUciBefore: before.bestMove, bestSanBefore,
        before, after, playerColor, loss,
      });
      const pv = this.buildPvLine(fenBefore, before.pv, 6);
      // How the opponent actually punishes the move that was played: the engine's own
      // best continuation from the resulting position (fenAfter), not a hypothetical —
      // this is what proves "why" a move was a blunder, move by move.
      const punishPv = this.buildPvLine(fenAfter, after.pv, 6);

      errors.push({
        ply: k,
        moveNumber: Math.ceil(k / 2),
        san: mv.san,
        color: mv.color,
        from: mv.from,
        to: mv.to,
        piece: mv.piece,
        fenBefore, fenAfter,
        loss: Math.round(loss),
        severity,
        theme,
        explainBad,
        explainGood,
        pvLine: pv.sanLine,
        pvMoves: pv.moves,
        punishPvLine: punishPv.sanLine,
        punishPvMoves: punishPv.moves,
        scoreBefore: before.score,
        scoreAfter: after.score,
        bestMoveBefore: before.bestMove,
        bestSanBefore,
      });
    }

    return { errors, plyCount: verboseHistory.length };
  },

  // Names the two attacked pieces for a fork sentence, e.g. "ta dame (d8) et ta tour (a8)".
  describeForkTargets(board, row, col, enemyColor) {
    const attacks = this.attackedSquares(board, row, col);
    const named = [];
    for (const a of attacks) {
      const p = board[a.row][a.col];
      if (p && p.color === enemyColor && PIECE_VALUE[p.type] >= 3) {
        named.push(PIECE_NAME_FR[p.type] + ' (' + this.rcToSquare(a.row, a.col) + ')');
      }
    }
    return named;
  },

  rcToSquare(row, col) {
    return 'abcdefgh'[col] + (8 - row);
  },

  classify(ctx) {
    const { fenBefore, fenAfter, before, after, playerColor, playedSan, bestSanBefore, loss } = ctx;
    const backRank = playerColor === 'w' ? 1 : 8;
    const lossPawns = (loss / 100).toFixed(1);

    // 1. Player had a forced mate and missed it.
    if (before.score.type === 'mate' && before.score.value > 0 && before.score.value <= 6) {
      const n = before.score.value;
      return {
        theme: 'Mat manqué',
        explainBad: 'Tu avais un mat forcé en ' + n + ' coup(s), mais ' + playedSan + ' laisse l\'adversaire s\'échapper.',
        explainGood: bestSanBefore + ' menait à un mat forcé en ' + n + ' coup(s).',
      };
    }

    // 2. Player's move allowed the opponent a forced mate.
    if (after.score.type === 'mate' && after.score.value > 0 && after.score.value <= 8 && after.bestMove) {
      const n = after.score.value;
      const parsed = this.parseUci(after.bestMove);
      let isCorridor = false;
      if (parsed) {
        const fromRC = this.squareToRC(parsed.from);
        const toRC = this.squareToRC(parsed.to);
        const board = new Chess(fenAfter).board();
        const piece = board[fromRC.row] && board[fromRC.row][fromRC.col];
        const toRank = 8 - toRC.row;
        if (piece && (piece.type === 'r' || piece.type === 'q') && toRank === backRank) {
          isCorridor = true;
        }
      }
      const mateSan = this.sanFromUci(fenAfter, after.bestMove);
      return {
        theme: isCorridor ? 'Mat au couloir' : 'Mat forcé subi',
        explainBad: isCorridor
          ? playedSan + ' laisse ton roi sans case de fuite sur sa rangée : ' + mateSan + ' force le mat en ' + n + ' coup(s).'
          : playedSan + ' permet à l\'adversaire de forcer le mat en ' + n + ' coup(s) (' + mateSan + '…).',
        explainGood: bestSanBefore + ' évitait ce mat forcé.',
      };
    }

    // 3. A piece left hanging (opponent's best reply just wins material for free).
    if (after.bestMove) {
      const parsed = this.parseUci(after.bestMove);
      if (parsed) {
        const boardBeforeReply = new Chess(fenAfter).board();
        const toRC = this.squareToRC(parsed.to);
        const target = boardBeforeReply[toRC.row][toRC.col];
        const captureSan = this.sanFromUci(fenAfter, after.bestMove);
        if (target && target.color === playerColor && PIECE_VALUE[target.type] >= 3) {
          const temp = new Chess(fenAfter);
          const played = temp.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
          if (played) {
            const recaptures = temp.moves({ verbose: true }).filter((m) => m.to === parsed.to);
            if (recaptures.length === 0) {
              const pieceFr = PIECE_NAME_FR[target.type];
              return {
                theme: 'Pièce laissée en prise (' + pieceFr + ')',
                explainBad: 'Après ' + playedSan + ', ta/ton ' + pieceFr + ' en ' + parsed.to + ' n\'est plus défendu(e) : ' + captureSan + ' la/le gagne gratuitement.',
                explainGood: bestSanBefore + ' évitait d\'exposer cette pièce.',
              };
            }
            const boardAfterReply = temp.board();
            const forkTargets = this.describeForkTargets(boardAfterReply, toRC.row, toRC.col, playerColor);
            if (forkTargets.length >= 2) {
              return {
                theme: 'Fourchette subie',
                explainBad: playedSan + ' permet ' + captureSan + ', qui attaque en même temps ta ' + forkTargets.join(' et ta ') + ' : tu ne peux pas sauver les deux.',
                explainGood: bestSanBefore + ' évitait cette double attaque.',
              };
            }
          }
        } else {
          const temp = new Chess(fenAfter);
          const played = temp.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
          if (played) {
            const boardAfterReply = temp.board();
            const forkTargets = this.describeForkTargets(boardAfterReply, toRC.row, toRC.col, playerColor);
            if (forkTargets.length >= 2) {
              return {
                theme: 'Fourchette subie',
                explainBad: playedSan + ' permet ' + captureSan + ', qui attaque en même temps ta ' + forkTargets.join(' et ta ') + ' : tu ne peux pas sauver les deux.',
                explainGood: bestSanBefore + ' évitait cette double attaque.',
              };
            }
          }
        }
      }
    }

    // 4. Endgame context fallback.
    const boardBefore = new Chess(fenBefore).board();
    if (this.countNonPawnMaterial(boardBefore) <= 6) {
      return {
        theme: 'Erreur en finale',
        explainBad: 'En finale, chaque coup compte : ' + playedSan + ' cède environ ' + lossPawns + ' pion(s) d\'évaluation.',
        explainGood: bestSanBefore + ' maintenait un meilleur équilibre dans cette finale.',
      };
    }

    return {
      theme: 'Erreur tactique',
      explainBad: playedSan + ' fait perdre environ ' + lossPawns + ' pion(s) d\'évaluation par rapport au meilleur coup.',
      explainGood: bestSanBefore + ' maintenait une position nettement meilleure (regarde la suite indicative ci-dessous pour l\'idée).',
    };
  },

  // --- aggregation for the summary dashboard --------------------------

  summarize(allErrors) {
    const themeCounts = {};
    let blunders = 0, mistakes = 0, inaccuracies = 0, totalLoss = 0;
    for (const err of allErrors) {
      themeCounts[err.theme] = (themeCounts[err.theme] || 0) + 1;
      if (err.severity === SEVERITY.BLUNDER) blunders++;
      else if (err.severity === SEVERITY.MISTAKE) mistakes++;
      else inaccuracies++;
      // Mate-related losses are synthesized as huge cp values (see cpFromScore) so they
      // always cross the blunder threshold — but summing them raw would let one or two
      // missed/walked-into mates dwarf every ordinary blunder in the "average loss" stat.
      totalLoss += Math.min(err.loss, 1000);
    }
    const themes = Object.entries(themeCounts)
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count);
    return {
      themes,
      topThemes: themes.slice(0, 5),
      blunders, mistakes, inaccuracies,
      totalErrors: allErrors.length,
      avgLoss: allErrors.length ? Math.round(totalLoss / allErrors.length) : 0,
    };
  },

  SEVERITY_WEIGHT: { blunder: 3, mistake: 2, inaccuracy: 1 },

  // Board + side-to-move + castling rights + en-passant target — i.e. everything that
  // defines "the same position", but ignoring the halfmove/fullmove counters so the
  // same crossroads reached via different move orders (or in different games) still
  // matches.
  positionKey(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
  },

  // Finds positions the player has stood in more than once and blundered every time —
  // literal, exact repeats (not a fuzzy/heuristic match), which is what makes them
  // directly actionable: "you've been here before and gotten it wrong every time."
  findRecurringPositions(allErrors, minCount) {
    minCount = minCount || 2;
    const groups = {};
    allErrors.forEach((err) => {
      const key = this.positionKey(err.fenBefore);
      (groups[key] = groups[key] || []).push(err);
    });
    return Object.values(groups)
      .filter((list) => list.length >= minCount)
      .map((list) => {
        const weight = list.reduce((sum, e) => sum + (this.SEVERITY_WEIGHT[e.severity] || 1), 0);
        return { errors: list, count: list.length, weight, representative: list[0] };
      })
      .sort((a, b) => b.weight - a.weight || b.count - a.count);
  },
};
