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
      diagnosisText: this.diagnose(allErrors),
    };
  },

  SEVERITY_WEIGHT: { blunder: 3, mistake: 2, inaccuracy: 1 },

  // A theme like "Pièce laissée en prise (dame)" groups under the family "Pièce laissée
  // en prise" for aggregation, while the piece detail is kept separately for phrasing.
  themeFamily(theme) {
    return theme.replace(/\s*\([^)]*\)\s*$/, '').trim();
  },

  FAMILY_INFO: {
    'Pièce laissée en prise': {
      label: 'tu laisses des pièces en prise',
      advice: "Avant de jouer, prends l'habitude de vérifier si la pièce que tu viens de déplacer — ou une autre — reste attaquée sans défense suffisante.",
    },
    'Fourchette subie': {
      label: 'tu te fais prendre dans des fourchettes',
      advice: "Avant de bouger une pièce, regarde si la case où elle atterrit peut être attaquée par un cavalier ou un pion en même temps qu'une autre de tes pièces.",
    },
    'Mat manqué': {
      label: 'tu rates des mats forcés',
      advice: "Quand l'adversaire est en difficulté, prends quelques secondes de plus pour chercher un mat forcé avant de jouer le premier coup correct qui te vient à l'esprit.",
    },
    'Mat au couloir': {
      label: 'tu te fais mater au couloir',
      advice: "Pense à donner une case de fuite à ton roi (souvent h3/h6) avant que la dernière rangée ne devienne un problème.",
    },
    'Mat forcé subi': {
      label: "tu laisses l'adversaire forcer le mat",
      advice: "Même quand c'est toi qui attaques, vérifie la sécurité de ton propre roi à chaque coup — c'est souvent lui qu'on oublie de défendre.",
    },
    'Erreur en finale': {
      label: 'tes erreurs se concentrent en finale',
      advice: "Travaille les finales de base (roi et pions, finales de tours) : c'est souvent là que des parties à égalité basculent.",
    },
    'Erreur tactique': {
      label: "tes erreurs ne rentrent pas dans un motif classique (pièce en prise, fourchette, mat)",
      advice: "Ralentis sur les positions calmes et vérifie systématiquement les menaces de l'adversaire avant de jouer, même quand rien ne semble se passer.",
    },
  },

  PIECE_ARTICLE_FR: { pion: 'ton', cavalier: 'ton', fou: 'ton', tour: 'ta', dame: 'ta', roi: 'ton' },

  // Turns the raw error list into a short written diagnosis of what's actually going
  // wrong for this player — the "so what" a bar chart of theme counts can't give on its
  // own. Picks the single costliest weakness (weighted by severity, not just frequency),
  // then adds whichever secondary signals (game phase, blunder-vs-inaccuracy mix, color,
  // repeated positions) are strong enough to be worth a sentence.
  diagnose(allErrors) {
    if (!allErrors.length) return "Importe quelques parties pour obtenir un diagnostic.";
    if (allErrors.length < 5) {
      return "Pas encore assez de données pour un diagnostic fiable — importe davantage de parties pour affiner l'analyse.";
    }

    const familyScore = {};
    const familyCount = {};
    const pieceCountByFamily = {};
    const phaseCount = { ouverture: 0, milieu: 0, finale: 0 };
    const colorCount = { w: 0, b: 0 };
    let blunders = 0, inaccuracies = 0;

    allErrors.forEach((err) => {
      const family = this.themeFamily(err.theme);
      familyScore[family] = (familyScore[family] || 0) + (this.SEVERITY_WEIGHT[err.severity] || 1);
      familyCount[family] = (familyCount[family] || 0) + 1;

      const pieceMatch = err.theme.match(/\(([^)]+)\)\s*$/);
      if (pieceMatch) {
        pieceCountByFamily[family] = pieceCountByFamily[family] || {};
        pieceCountByFamily[family][pieceMatch[1]] = (pieceCountByFamily[family][pieceMatch[1]] || 0) + 1;
      }

      const phase = family === 'Erreur en finale' ? 'finale' : (err.moveNumber <= 10 ? 'ouverture' : 'milieu');
      phaseCount[phase]++;
      if (err.color === 'w' || err.color === 'b') colorCount[err.color]++;
      if (err.severity === SEVERITY.BLUNDER) blunders++;
      else if (err.severity === SEVERITY.INACCURACY) inaccuracies++;
    });

    const families = Object.keys(familyScore).sort((a, b) => familyScore[b] - familyScore[a]);
    const topFamily = families[0];
    const topCount = familyCount[topFamily];
    const topPct = Math.round((topCount / allErrors.length) * 100);
    const info = this.FAMILY_INFO[topFamily] || { label: topFamily, advice: '' };

    let text = 'Ton principal problème : ' + info.label + ' (' + topCount + ' fois sur ' + allErrors.length + ' erreurs détectées, ' + topPct + '%).';

    const pieces = pieceCountByFamily[topFamily]
      ? Object.entries(pieceCountByFamily[topFamily]).sort((a, b) => b[1] - a[1])
      : null;
    if (pieces && pieces.length) {
      const named = pieces.slice(0, 2).map(([p]) => (this.PIECE_ARTICLE_FR[p] || 'ta') + ' ' + p);
      text += ' Le plus souvent ' + named.join(' ou ') + '.';
    }

    if (allErrors.length >= 8) {
      const blunderShare = blunders / allErrors.length;
      const inaccuracyShare = inaccuracies / allErrors.length;
      if (blunderShare >= 0.45) {
        text += ' Plus de la moitié de tes erreurs sont de vraies gaffes (perte nette, pas juste imprécise) : le souci semble être la vérification de tes coups avant de jouer, pas la compréhension stratégique.';
      } else if (inaccuracyShare >= 0.5) {
        text += ' La majorité de tes erreurs restent de petites imprécisions plutôt que de vraies gaffes : c\'est davantage une question de précision positionnelle que de calcul qui plante.';
      }
    }

    const phaseTotal = phaseCount.ouverture + phaseCount.milieu + phaseCount.finale;
    const phaseEntries = Object.entries(phaseCount).sort((a, b) => b[1] - a[1]);
    const topPhase = phaseEntries[0];
    if (topPhase && phaseTotal > 0 && topPhase[1] / phaseTotal >= 0.45) {
      const phaseLabel = {
        ouverture: "dans l'ouverture (avant le coup 10)",
        milieu: 'en milieu de partie',
        finale: 'en finale',
      }[topPhase[0]];
      text += ' Ça se produit surtout ' + phaseLabel + ' (' + Math.round((topPhase[1] / phaseTotal) * 100) + '% de tes erreurs).';
    }

    if (colorCount.w >= 3 && colorCount.b >= 3) {
      const whitePct = colorCount.w / (colorCount.w + colorCount.b);
      if (whitePct >= 0.65) text += ' Tu commets aussi nettement plus d\'erreurs avec les Blancs qu\'avec les Noirs.';
      else if (whitePct <= 0.35) text += ' Tu commets aussi nettement plus d\'erreurs avec les Noirs qu\'avec les Blancs.';
    }

    const recurring = this.findRecurringPositions(allErrors, 2);
    if (recurring.length) {
      text += ' ' + recurring.length + ' position' + (recurring.length > 1 ? 's' : '') +
        ' où tu refais exactement la même erreur plusieurs fois — regarde "Erreurs récurrentes" ci-dessous, c\'est le plus rapide à corriger.';
    }

    if (info.advice) text += ' ' + info.advice;

    return text;
  },

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
