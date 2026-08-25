// Pure(ish) rendering helpers — read from `state`, write to the DOM.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function severityLabel(sev) {
  return sev === 'blunder' ? 'Gaffe' : sev === 'mistake' ? 'Erreur' : 'Imprécision';
}

function formatLoss(err) {
  if (err.scoreAfter.type === 'mate') return 'Mat en ' + Math.abs(err.scoreAfter.value);
  return '-' + (err.loss / 100).toFixed(1) + ' pion(s)';
}

function scoreToWhiteDisplay(fen, score) {
  const stm = fen.split(' ')[1];
  if (score.type === 'mate') {
    const m = stm === 'w' ? score.value : -score.value;
    return { mate: m };
  }
  const cp = stm === 'w' ? score.value : -score.value;
  return { cp };
}

function formatScoreDisplay(d) {
  if (d.mate !== undefined) return (d.mate >= 0 ? '#' : '#-') + Math.abs(d.mate);
  return (d.cp >= 0 ? '+' : '') + (d.cp / 100).toFixed(1);
}

function evalBarPercent(d) {
  if (d.mate !== undefined) return d.mate > 0 ? 98 : 2;
  const cp = Math.max(-1000, Math.min(1000, d.cp));
  return 50 + (cp / 1000) * 50;
}

function bestSanFromUci(fen, uci) {
  if (!uci) return '?';
  const parsed = Analyzer.parseUci(uci);
  if (!parsed) return uci;
  try {
    const temp = new Chess(fen);
    const mv = temp.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
    return mv ? mv.san : uci;
  } catch (e) {
    return uci;
  }
}

function setStatus(text, pct) {
  document.getElementById('statusText').textContent = text;
  if (typeof pct === 'number') setProgressFill(pct);
}

function setProgressFill(pct) {
  document.getElementById('progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function showStatus(visible) {
  document.getElementById('statusPanel').classList.toggle('hidden', !visible);
}

function showWorkspace(visible) {
  document.getElementById('workspace').classList.toggle('hidden', !visible);
}

function hideEmptyState() {
  document.getElementById('emptyState').classList.add('hidden');
}

function setImportButtonState(importing) {
  const btn = document.getElementById('importBtn');
  btn.disabled = importing;
  btn.textContent = importing ? 'Import en cours…' : 'Importer mes parties';
}

function renderGamesList(state) {
  const container = document.getElementById('gamesList');
  container.innerHTML = '';
  state.games.forEach((game, i) => {
    const card = document.createElement('div');
    card.className = 'game-card' +
      (i === state.selectedGameIndex ? ' selected' : '') +
      (game.analyzing ? ' analyzing' : '');
    const resultClass = game.result === 'win' ? 'result-win' : game.result === 'loss' ? 'result-loss' : 'result-draw';
    const resultLabel = game.result === 'win' ? 'Gagné' : game.result === 'loss' ? 'Perdu' : 'Nul';
    const blunderCount = game.errors.filter((e) => e.severity === 'blunder').length;
    let subText = game.playerColor === 'w' ? 'Blancs' : 'Noirs';
    subText += ' · ' + formatDate(game.endTime);
    if (game.analyzing) subText += ' · analyse…';
    else if (game.analyzed) {
      subText += ' · ' + game.errors.length + ' erreur(s), ' + blunderCount + ' gaffe(s)';
      if (game.fromCache) subText += ' · cache ⚡';
    }
    else if (game.error) subText += ' · échec analyse';

    card.innerHTML =
      '<div class="game-meta">' +
        '<span class="game-players">vs ' + escapeHtml(game.opponent) + ' (' + (game.opponentRating || '?') + ')</span>' +
        '<span class="game-sub">' + escapeHtml(subText) + '</span>' +
      '</div>' +
      '<span class="game-result ' + resultClass + '">' + resultLabel + '</span>';

    card.addEventListener('click', () => selectGame(i));
    container.appendChild(card);
  });
}

function renderErrorList(state) {
  const container = document.getElementById('errorList');
  container.innerHTML = '';
  const game = state.games[state.selectedGameIndex];
  if (!game) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Sélectionne une partie dans l\'onglet "Mes parties".</p>';
    return;
  }
  if (game.analyzing) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Analyse en cours…</p>';
    return;
  }
  if (!game.errors.length) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Aucune erreur significative détectée dans cette partie 🎉</p>';
    return;
  }
  game.errors.forEach((err, idx) => {
    const card = document.createElement('div');
    card.className = 'error-card' + (idx === state.selectedErrorIndex ? ' selected' : '');
    card.innerHTML =
      '<div class="error-card-top">' +
        '<span class="error-move">' + err.moveNumber + (err.color === 'w' ? '.' : '...') + ' ' + escapeHtml(err.san) + '</span>' +
        '<span class="error-severity severity-' + err.severity + '">' + severityLabel(err.severity) + '</span>' +
      '</div>' +
      '<div class="error-theme">' + escapeHtml(err.theme) + '</div>' +
      '<div class="error-loss">' + formatLoss(err) + '</div>';
    card.addEventListener('click', () => selectError(idx));
    container.appendChild(card);
  });
}

function renderSummary(summary) {
  const panel = document.getElementById('summaryPanel');
  panel.classList.remove('hidden');
  document.getElementById('diagnosisBox').textContent = summary.diagnosisText || '';
  const stats = document.getElementById('summaryStats');
  stats.innerHTML =
    statHtml(summary.totalErrors, 'Erreurs détectées') +
    statHtml(summary.blunders, 'Gaffes') +
    statHtml(summary.mistakes, 'Erreurs') +
    statHtml(summary.inaccuracies, 'Imprécisions') +
    statHtml(summary.avgLoss + ' cp', 'Perte moyenne / erreur');
}

function statHtml(value, label) {
  return '<div class="stat"><span class="stat-value">' + value + '</span><span class="stat-label">' + escapeHtml(label) + '</span></div>';
}

const UNICODE_PIECE = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

// Small self-contained SVG board preview (no images, no chessboard.js instance) — used
// for the many-cards recurring-positions list where spinning up a full interactive
// board per row would be wasteful. Optionally highlights the move that was played.
function miniBoardSvg(fen, size, fromSq, toSq) {
  size = size || 96;
  const sq = size / 8;
  const boardPart = fen.split(' ')[0];
  const rows = boardPart.split('/');
  const squareOf = (r, c) => 'abcdefgh'[c] + (8 - r);
  let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">';

  rows.forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        c += parseInt(ch, 10);
        continue;
      }
      const isLight = (r + c) % 2 === 0;
      const x = c * sq, y = r * sq;
      const thisSq = squareOf(r, c);
      const isHighlighted = thisSq === fromSq || thisSq === toSq;
      const base = isLight ? '#f0d9b5' : '#b58863';
      svg += '<rect x="' + x + '" y="' + y + '" width="' + sq + '" height="' + sq + '" fill="' + base + '"></rect>';
      if (isHighlighted) {
        svg += '<rect x="' + x + '" y="' + y + '" width="' + sq + '" height="' + sq + '" fill="rgba(255,92,92,.45)"></rect>';
      }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const glyph = UNICODE_PIECE[color + ch.toUpperCase()];
      if (glyph) {
        svg += '<text x="' + (x + sq / 2) + '" y="' + (y + sq * 0.76) + '" font-size="' + (sq * 0.8) + '" text-anchor="middle" ' +
          'fill="' + (color === 'w' ? '#fdfdfd' : '#161616') + '" stroke="' + (color === 'w' ? '#2a2a2a' : '#eaeaea') + '" stroke-width="0.6" paint-order="stroke fill">' + glyph + '</text>';
      }
      c++;
    }
  });

  svg += '</svg>';
  return svg;
}

function recurringCardHtml(cluster, clickable) {
  const rep = cluster.representative;
  const mini = miniBoardSvg(rep.fenBefore, 96, rep.from, rep.to);
  const occHtml = cluster.errors.map((e) =>
    '<span class="recurring-occ" data-game="' + e.gameIndex + '" data-ply="' + e.ply + '">' +
      escapeHtml(e.moveNumber + (e.color === 'w' ? '.' : '...') + e.san) +
    '</span>'
  ).join('');

  return (
    '<div class="recurring-card" data-game="' + rep.gameIndex + '" data-ply="' + rep.ply + '">' +
      '<div class="recurring-mini">' + mini + '</div>' +
      '<div class="recurring-body">' +
        '<span class="recurring-count">' + cluster.count + '× la même erreur</span>' +
        '<div class="recurring-theme">' + escapeHtml(rep.theme) + '</div>' +
        '<div class="recurring-reason">' + escapeHtml(rep.explainBad || '') + '</div>' +
        '<div class="recurring-occurrences">' + occHtml + '</div>' +
      '</div>' +
    '</div>'
  );
}

function renderRecurringPreview(clusters) {
  const container = document.getElementById('recurringPreview');
  if (!clusters.length) {
    container.innerHTML = '<div class="recurring-empty">Aucune position répétée détectée pour l\'instant — continue d\'importer des parties, ou c\'est plutôt bon signe !</div>';
    return;
  }
  container.innerHTML = clusters.slice(0, 3).map((c) => recurringCardHtml(c)).join('');
}

function renderRecurringList(clusters) {
  const container = document.getElementById('recurringList');
  if (!clusters.length) {
    container.innerHTML = '<div class="recurring-empty">Aucune position répétée détectée pour l\'instant.</div>';
    return;
  }
  container.innerHTML = clusters.map((c) => recurringCardHtml(c)).join('');
}
