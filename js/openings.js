// Controller for the standalone "Ouvertures" screen — browses the curated OPENINGS
// data (js/openings-data.js) and replays any variation move by move on its own
// chessboard.js instance, independent from the analysis screen's board.

const opState = {
  board: null,
  screen: 'analysis',
  family: null,
  variation: null,
  fens: null,   // fens[0] = start position, fens[i] = position after moves[i-1]
  sans: null,   // SAN as chess.js normalized it (should match authored .s, kept separate defensively)
  moveIndex: 0,
  flipped: false,
  filterMove: 'all',
  filterColor: 'all',
};

document.addEventListener('DOMContentLoaded', initOpenings);

function initOpenings() {
  opState.board = Chessboard('openingsBoard', { position: 'start', pieceTheme: PIECE_THEME });

  document.getElementById('navAnalysisBtn').addEventListener('click', () => switchScreen('analysis'));
  document.getElementById('navOpeningsBtn').addEventListener('click', () => switchScreen('openings'));

  document.getElementById('opPrevBtn').addEventListener('click', opPrev);
  document.getElementById('opNextBtn').addEventListener('click', opNext);
  document.getElementById('opFlipBtn').addEventListener('click', opFlip);
  document.getElementById('opResetBtn').addEventListener('click', () => opGoTo(0));

  document.querySelectorAll('.op-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.op-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
      opState.filterMove = btn.dataset.filter;
      renderOpeningsList();
    });
  });

  document.querySelectorAll('.op-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.op-color-btn').forEach((b) => b.classList.toggle('active', b === btn));
      opState.filterColor = btn.dataset.color;
      renderOpeningsList();
    });
  });

  document.getElementById('openingsList').addEventListener('click', (e) => {
    const favBtn = e.target.closest('.op-fav-btn');
    if (favBtn) {
      const nowFav = Favorites.toggle(favBtn.dataset.family, favBtn.dataset.name);
      favBtn.classList.toggle('active', nowFav);
      favBtn.textContent = nowFav ? '★' : '☆';
      favBtn.title = nowFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
      // If we're currently viewing the favorites-only filter, un-favoriting should
      // drop the row immediately rather than leave a stale entry until next render.
      if (opState.filterMove === 'favorites' && !nowFav) renderOpeningsList();
      return;
    }
    const btn = e.target.closest('.op-variation-btn');
    if (!btn) return;
    loadVariation(btn.dataset.family, parseInt(btn.dataset.idx, 10));
  });

  document.getElementById('opMoveList').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ply]');
    if (!chip) return;
    opGoTo(parseInt(chip.dataset.ply, 10));
  });

  renderOpeningsList();
}

function switchScreen(screen) {
  opState.screen = screen;
  document.getElementById('analysisScreen').classList.toggle('hidden', screen !== 'analysis');
  document.getElementById('openingsScreen').classList.toggle('hidden', screen !== 'openings');
  document.getElementById('puzzlesScreen').classList.toggle('hidden', screen !== 'puzzles');
  document.getElementById('navAnalysisBtn').classList.toggle('active', screen === 'analysis');
  document.getElementById('navOpeningsBtn').classList.toggle('active', screen === 'openings');
  document.getElementById('navPuzzlesBtn').classList.toggle('active', screen === 'puzzles');
  if (typeof updateHeaderVisibility === 'function') updateHeaderVisibility();
  // Every board was possibly created while its section was display:none, which makes
  // chessboard.js measure a 0-width container (see the analysis-board resize fix) —
  // re-measure whichever board just became visible.
  if (screen === 'analysis' && state.board) state.board.resize();
  if (screen === 'openings' && opState.board) opState.board.resize();
  if (screen === 'puzzles' && typeof onEnterPuzzlesScreen === 'function') onEnterPuzzlesScreen();
}

function categoryOf(family) {
  const first = family.variations[0].moves[0].s;
  if (first === 'e4') return 'e4';
  if (first === 'd4') return 'd4';
  return 'flank';
}

function renderOpeningsList() {
  const container = document.getElementById('openingsList');
  const { filterMove, filterColor } = opState;
  const favoritesOnly = filterMove === 'favorites';

  let families = OPENINGS.filter((f) => filterColor === 'all' || f.forColor === filterColor);
  if (!favoritesOnly) {
    families = families.filter((f) => filterMove === 'all' || categoryOf(f) === filterMove);
  }
  if (favoritesOnly) {
    families = families.filter((f) => f.variations.some((v) => Favorites.has(f.id, v.name)));
  }

  if (favoritesOnly && !families.length) {
    container.innerHTML = '<p class="op-favorites-empty">Aucun favori pour l\'instant — clique l\'étoile ☆ à côté d\'une variante pour l\'ajouter ici.</p>';
    return;
  }

  container.innerHTML = families.map((f) => familyHtml(f, favoritesOnly)).join('');
}

function familyHtml(family, favoritesOnly) {
  const isActive = opState.family === family.id;
  const variationEntries = family.variations
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => !favoritesOnly || Favorites.has(family.id, v.name));

  const variationsHtml = variationEntries.map(({ v, i }) => {
    const selected = isActive && opState.variation === v;
    const fav = Favorites.has(family.id, v.name);
    return (
      '<div class="op-variation-row">' +
        '<button class="op-variation-btn' + (selected ? ' active' : '') + '" data-family="' +
          family.id + '" data-idx="' + i + '">' + escapeHtml(v.name) + '</button>' +
        '<button class="op-fav-btn' + (fav ? ' active' : '') + '" data-family="' + family.id +
          '" data-name="' + escapeHtml(v.name) + '" title="' + (fav ? 'Retirer des favoris' : 'Ajouter aux favoris') + '">' +
          (fav ? '★' : '☆') +
        '</button>' +
      '</div>'
    );
  }).join('');

  const colorBadge = family.forColor === 'w'
    ? '<span class="op-color-badge color-w">⚪ Blancs</span>'
    : '<span class="op-color-badge color-b">⚫ Noirs</span>';

  return (
    '<details class="op-family"' + (isActive || favoritesOnly ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="op-family-name-row">' +
          '<span class="op-family-name">' + escapeHtml(family.family) + '</span>' +
          colorBadge +
        '</span>' +
        '<span class="op-family-eco">' + escapeHtml(family.eco) + '</span>' +
      '</summary>' +
      '<p class="op-family-intro">' + escapeHtml(family.intro) + '</p>' +
      '<div class="op-variation-list">' + variationsHtml + '</div>' +
    '</details>'
  );
}

function buildVariationFens(moves) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const sans = [];
  moves.forEach((m) => {
    const mv = chess.move(m.s, { sloppy: true });
    sans.push(mv ? mv.san : m.s);
    fens.push(chess.fen());
  });
  return { fens, sans };
}

function loadVariation(familyId, idx) {
  const family = OPENINGS.find((f) => f.id === familyId);
  if (!family) return;
  const variation = family.variations[idx];
  if (!variation) return;

  const { fens, sans } = buildVariationFens(variation.moves);
  opState.family = family;
  opState.variation = variation;
  opState.fens = fens;
  opState.sans = sans;
  opState.moveIndex = 0;

  // Orient the board for whichever side is actually being studied: a White system is
  // shown from White's side, a Black defense from Black's — no manual flip needed to
  // see "your own" perspective. The flip button still overrides this at will.
  opState.flipped = family.forColor === 'b';
  opState.board.orientation(opState.flipped ? 'black' : 'white');

  document.getElementById('opIntroBox').classList.add('hidden');
  document.getElementById('opCommentBox').classList.remove('hidden');
  document.getElementById('opMoveListBox').classList.remove('hidden');
  renderOpMoveList();
  opRenderStep(false);

  // Re-render the family list so the active family stays expanded and the picked
  // variation is visually marked, without losing the current filter selection.
  renderOpeningsList();
}

function renderOpMoveList() {
  const { variation, sans } = opState;
  const parts = [];
  let n = 1;
  sans.forEach((san, i) => {
    if (i % 2 === 0) parts.push('<span class="op-move-num">' + n + '.</span>');
    parts.push('<span class="op-move-chip" data-ply="' + (i + 1) + '">' + escapeHtml(san) + '</span>');
    if (i % 2 === 1) n++;
  });
  document.getElementById('opMoveList').innerHTML = parts.join(' ');
}

function opRenderStep(animate) {
  const { family, variation, fens, sans, moveIndex } = opState;
  if (!fens) return;

  opState.board.position(fens[moveIndex], !!animate);

  const moveInfo = document.getElementById('opMoveInfo');
  if (moveIndex === 0) {
    moveInfo.textContent = family.family + ' — ' + variation.name + ' : position de départ';
  } else {
    const n = Math.ceil(moveIndex / 2);
    const dots = moveIndex % 2 === 1 ? '.' : '...';
    moveInfo.textContent = family.family + ' — ' + variation.name + ' : ' + n + dots + ' ' + sans[moveIndex - 1];
  }

  const commentEl = document.getElementById('opComment');
  if (moveIndex === 0) {
    commentEl.textContent = family.intro;
  } else {
    const c = variation.moves[moveIndex - 1].c;
    commentEl.textContent = c || '';
  }

  document.querySelectorAll('.op-move-chip').forEach((chip) => {
    chip.classList.toggle('active', parseInt(chip.dataset.ply, 10) === moveIndex);
  });

  document.getElementById('opPrevBtn').disabled = moveIndex <= 0;
  document.getElementById('opNextBtn').disabled = moveIndex >= sans.length;
}

function opNext() {
  if (!opState.fens || opState.moveIndex >= opState.sans.length) return;
  opState.moveIndex++;
  opRenderStep(true);
}

function opPrev() {
  if (!opState.fens || opState.moveIndex <= 0) return;
  opState.moveIndex--;
  opRenderStep(true);
}

function opGoTo(ply) {
  if (!opState.fens || ply < 0 || ply > opState.sans.length) return;
  opState.moveIndex = ply;
  opRenderStep(true);
}

function opFlip() {
  opState.flipped = !opState.flipped;
  opState.board.orientation(opState.flipped ? 'black' : 'white');
}
