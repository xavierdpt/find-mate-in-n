/* Find the mate in n.
 *
 * levels.json lists the mate distances the site has and how many positions each holds, and
 * mate-<n>.json holds the positions of one distance, every legal move scored. A level is a
 * distance: answer a mate in n and the next position is a mate at the next distance the site
 * has; miss one and the next is a mate in one again. A level's file is fetched the first time it
 * is needed, and the next level's file is fetched ahead while a position is on the board.
 *
 * The answer is a move played on the board, and it is right when it scores a mate in exactly n,
 * which is often more than one move, so the verdict names the others. Nothing here knows the
 * rules of chess: a click is looked up in the position's own move list, and applying a move to
 * the board is three special cases: castling, en passant, promotion.
 *
 * A move token is [san:2][from:1][to:1][score:2][flags], digits base 64 (build.py, encode_move).
 */
(function (root) {
  'use strict';

  var DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var FILES = 'abcdefgh';
  var STORE = 'findmateinn.best';
  var HINT = 'Every legal move, scored, once you have answered.';
  var ASK = 'Pick up a piece and play the move you think forces mate.';

  /* ---- a position out of a level file ---- */

  function d1(ch) { return DIGITS.indexOf(ch); }
  function d12(pair) { return DIGITS.indexOf(pair[0]) * 64 + DIGITS.indexOf(pair[1]); }

  function decode(puzzle) {
    return puzzle.m.split(' ').map(function (token) {
      var flags = token.slice(6);
      var promo = flags.match(/[qrbn]/);
      return {
        san: puzzle.d[d12(token.slice(0, 2))],
        from: d1(token[2]),
        to: d1(token[3]),
        score: d12(token.slice(4, 6)) - 2048,
        mate: flags.indexOf('!') >= 0,
        promo: promo ? promo[0] : null
      };
    });
  }

  function whiteToMove(puzzle) { return puzzle.f.split(' ')[1] !== 'b'; }

  function applyMove(board, move) {
    var next = board.slice();
    var piece = next[move.from];
    var fromFile = move.from % 8, toFile = move.to % 8;
    var fromRank = Math.floor(move.from / 8), toRank = Math.floor(move.to / 8);

    // Castling: the king crosses two files, and the rook lands on the square it passed.
    if ((piece === 'K' || piece === 'k') && Math.abs(toFile - fromFile) === 2) {
      var side = toFile > fromFile ? 7 : 0;
      next[toRank * 8 + (toFile > fromFile ? 5 : 3)] = next[toRank * 8 + side];
      next[toRank * 8 + side] = ' ';
    }
    // En passant: a pawn that leaves its file onto an empty square takes the pawn beside it.
    if ((piece === 'P' || piece === 'p') && fromFile !== toFile && next[move.to] === ' ') {
      next[fromRank * 8 + toFile] = ' ';
    }
    next[move.to] = move.promo ? (piece === 'P' ? move.promo.toUpperCase() : move.promo) : piece;
    next[move.from] = ' ';
    return next;
  }

  /* ---- the ladder ---- */

  function shuffle(list, random) {
    random = random || Math.random;
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var swap = list[i]; list[i] = list[j]; list[j] = swap;
    }
    return list;
  }

  // The levels, in order, each a distance whose positions arrive when its file is loaded. A
  // level's positions are shuffled once and dealt in order, so none comes round again before the
  // rest of its level has been seen. `best` counts levels cleared, 0 until the first one is.
  function ladder(distances, best) {
    var decks = {};
    return {
      distances: distances,
      level: 0,
      solved: 0,
      best: best || 0,
      key: function () { return distances[this.level]; },
      has: function (level) { return !!decks[distances[level]]; },
      fill: function (distance, puzzles, random) {
        if (!decks[distance]) decks[distance] = { items: shuffle(puzzles.slice(), random), at: 0 };
      },
      deal: function (random) {
        var deck = decks[this.key()];
        if (deck.at >= deck.items.length) { shuffle(deck.items, random); deck.at = 0; }
        return deck.items[deck.at++];
      },
      win: function () {
        this.solved++;
        if (this.level + 1 > this.best) this.best = this.level + 1;
        this.level = Math.min(this.level + 1, distances.length - 1);
      },
      lose: function () { this.level = 0; }
    };
  }

  /* ---- the verdict's words ---- */

  // A list of moves, named while there are few enough to name.
  function named(names) {
    var shown = names.slice(0, 4).map(function (san) { return '<span class="san">' + san + '</span>'; });
    if (names.length > 4) shown.push((names.length - 4) + ' more');
    return shown.join(', ');
  }

  function others(names, played) {
    var rest = names.filter(function (san) { return san !== played; });
    if (!rest.length) return 'It is the only move that does.';
    if (rest.length > 4) return 'So do ' + rest.length + ' of the other moves.';
    return 'So ' + (rest.length === 1 ? 'does ' : 'do ') + named(rest) + '.';
  }

  // Why the move was not the answer: it mates more slowly than the position allows, it lets the
  // other side mate, or it mates nobody.
  function missed(move, distance) {
    var san = '<span class="san">' + move.san + '</span>';
    if (move.mate && move.score > 0) return san + ' mates in ' + move.score + ', not in ' + distance + '.';
    if (move.mate) return san + ' throws it away: mate in ' + Math.abs(move.score) + ' against.';
    return san + ' keeps the game going at ' + move.score + ' centipawns.';
  }

  var api = {
    decode: decode, whiteToMove: whiteToMove, applyMove: applyMove, shuffle: shuffle,
    ladder: ladder, named: named, others: others, missed: missed
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  /* ---- the page ---- */

  var page = null, run = null, loading = {};
  var puzzle = null, moves = [], board = [], white = true, squares = [];
  var origin = null, answer = null, done = false;

  function remembered() {
    try { return Number(localStorage.getItem(STORE)) || 0; } catch (error) { return 0; }
  }

  function remember(value) {
    try { localStorage.setItem(STORE, String(value)); } catch (error) { /* private window */ }
  }

  function fetchJson(name) {
    return fetch(name).then(function (response) {
      if (!response.ok) throw new Error(name + ': ' + response.status + ' ' + response.statusText);
      return response.json();
    });
  }

  // A level's positions, fetched once; a second request for it waits on the first.
  function load(level) {
    var distance = run.distances[level];
    if (run.has(level)) return Promise.resolve();
    if (!loading[distance]) {
      loading[distance] = fetchJson('mate-' + distance + '.json').then(function (file) {
        run.fill(distance, file.p || []);
      });
    }
    return loading[distance];
  }

  function fail(error) {
    page.level.textContent = 'No positions';
    verdict('wrong', 'The positions could not be read: ' + error.message);
  }

  function verdict(kind, html) {
    page.verdict.className = 'fm-verdict' + (kind ? ' ' + kind : '');
    page.verdict.innerHTML = html;
  }

  // Rebuilt for each position: a position with Black to move is drawn from Black's side.
  function drawBoard(flipped) {
    page.board.textContent = '';
    var cells = new Array(64);
    for (var row = 0; row < 9; row++) {
      for (var col = 0; col < 9; col++) {
        var cell = document.createElement('div');
        if (col === 0 || row === 8) {
          cell.className = 'co';
          if (col > 0) cell.textContent = flipped ? FILES[8 - col] : FILES[col - 1];
          else if (row < 8) cell.textContent = String(flipped ? row + 1 : 8 - row);
        } else {
          var file = flipped ? 8 - col : col - 1;
          var rank = flipped ? row : 7 - row;
          var index = rank * 8 + file;
          cell.dataset.sq = String(index);
          cells[index] = cell;
        }
        page.board.appendChild(cell);
      }
    }
    return cells;
  }

  function paint() {
    var dest = {}, pick = {};
    if (!done) {
      moves.forEach(function (move) {
        if (origin === null) pick[move.from] = true;
        if (move.from === origin) dest[move.to] = true;
      });
    }
    for (var i = 0; i < 64; i++) {
      var piece = board[i];
      squares[i].className = 'sq ' + ((Math.floor(i / 8) + (i % 8)) % 2 ? 'lt' : 'dk') +
        (piece === ' ' ? '' : ' pc-' + (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase()) +
        (answer && answer.from === i ? ' from' : '') +
        (answer && answer.to === i ? ' to' : '') +
        (origin === i ? ' origin' : '') +
        (dest[i] ? ' dest' + (piece === ' ' ? '' : ' occupied') : '') +
        (pick[i] ? ' pick' : '');
    }
  }

  // A cell per legal move: the balance in centipawns, or a countable stack of bands for a mate.
  function cell(move) {
    var fromWhite = white ? move.score : -move.score;
    if (move.mate) {
      var count = Math.min(20, Math.max(1, Math.abs(move.score)));
      var bands = '';
      for (var i = 0; i < count; i++) bands += '<div class="mate ' + (fromWhite > 0 ? 'w' : 'b') + '"></div>';
      return '<div class="mates">' + bands + '</div>';
    }
    var black = Math.max(0, Math.min(100, 50 - 5 * fromWhite / 100));
    return '<div class="zero"></div><div class="black" style="height:' + black + '%"></div>';
  }

  function drawBars(chosen) {
    page.bars.className = 'fm-bars';
    page.bars.innerHTML = '<div class="mini">' + moves.map(function (move, index) {
      return '<div class="cell' + (index === chosen ? ' chosen' : '') + '" title="' + move.san + ': ' +
             (move.mate ? 'mate ' : 'cp ') + move.score + '">' + cell(move) + '</div>';
    }).join('') + '</div>';
  }

  function closeBars() {
    page.bars.className = 'fm-bars empty';
    page.bars.innerHTML = '<div class="fm-hint">' + HINT + '</div>';
  }

  function label(distance) { return 'mate in ' + distance; }

  function renderScore() {
    page.score.innerHTML = 'level <b>' + (run.level + 1) + '</b> of ' + run.distances.length +
      ' · solved ' + run.solved + ' · best <b>' + (run.best ? label(run.distances[run.best - 1]) : '—') + '</b>';
  }

  function renderHead() {
    page.level.innerHTML = 'Find the mate in <span class="fm-n">' + run.key() + '</span>';
    page.turn.hidden = false;
    page.turn.textContent = white ? 'White to move' : 'Black to move';
    page.turn.className = 'fm-turn ' + (white ? 'white' : 'black');
    page.here.textContent = puzzle.f;
    renderScore();
  }

  function mating(move) { return move.mate && move.score === run.key(); }

  function answered(move, gaveUp) {
    answer = move;
    done = true;
    origin = null;
    if (move) board = applyMove(board, move);

    var right = !gaveUp && move && mating(move);
    var answers = moves.filter(mating).map(function (m) { return m.san; });
    var distance = run.key();

    if (right) {
      run.win();
      remember(run.best);
      verdict('right', '<b class="good">Found it.</b> <span class="san">' + move.san + '</span> forces mate in ' +
        distance + '. ' + others(answers, move.san) + ' Next: mate in ' + run.key() + '.');
    } else {
      run.lose();
      verdict('wrong', (gaveUp
        ? '<b>The mate in ' + distance + ' was ' + named(answers) + '.</b>'
        : '<b class="bad">Not that one.</b> ' + missed(move, distance) +
          ' The mate in ' + distance + ' was ' + named(answers) + '.') +
        ' Back to mate in ' + run.key() + '.');
    }

    renderScore();
    drawBars(moves.indexOf(move));
    page.next.disabled = false;
    page.give.disabled = true;
    paint();
    page.next.focus();
  }

  /* ---- promotion: four moves on the same two squares, so the click is asked which ---- */

  function closePromotion() {
    var open = page.board.querySelector('.promo');
    if (open) open.remove();
  }

  function askPromotion(choices) {
    closePromotion();
    var box = document.createElement('div');
    box.className = 'promo';
    var target = squares[choices[0].to];
    var above = target.offsetTop + target.offsetHeight * 4 <= page.board.clientHeight;
    box.style.left = target.offsetLeft + 'px';
    if (above) {
      box.style.top = target.offsetTop + 'px';
    } else {
      box.style.bottom = (page.board.clientHeight - target.offsetTop - target.offsetHeight) + 'px';
      box.style.flexDirection = 'column-reverse';
    }
    choices.forEach(function (move) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'pc-' + (white ? 'w' : 'b') + move.promo.toUpperCase();
      button.title = move.san;
      button.setAttribute('aria-label', move.san);
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        closePromotion();
        answered(move, false);
      });
      box.appendChild(button);
    });
    page.board.appendChild(box);
  }

  function onBoardClick(event) {
    if (done) return;
    var target = event.target.closest('.sq');
    if (!target) return;
    closePromotion();
    var index = Number(target.dataset.sq);
    var chosen = origin === null ? [] : moves.filter(function (move) {
      return move.from === origin && move.to === index;
    });
    if (chosen.length > 1 && chosen[0].promo) { askPromotion(chosen); return; }
    if (chosen.length) { answered(chosen[0], false); return; }
    origin = moves.some(function (move) { return move.from === index; }) ? index : null;
    paint();
  }

  /* ---- a position ---- */

  function show() {
    page.next.disabled = true;
    load(run.level).then(function () {
      puzzle = run.deal();
      moves = decode(puzzle);
      board = puzzle.b.split('');
      white = whiteToMove(puzzle);
      origin = null;
      answer = null;
      done = false;
      page.give.disabled = false;
      closePromotion();
      squares = drawBoard(!white);
      renderHead();
      paint();
      closeBars();
      if (page.verdict.className !== 'fm-verdict') verdict('', ASK);
      // The level a right answer leads to, fetched while this one is played.
      if (run.level + 1 < run.distances.length) load(run.level + 1).catch(function () {});
    }).catch(fail);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var id = document.getElementById.bind(document);
    page = {
      board: id('fm-board'), level: id('fm-level'), turn: id('fm-turn'), score: id('fm-score'),
      verdict: id('fm-verdict'), bars: id('fm-bars'), next: id('fm-next'), give: id('fm-give'),
      here: id('bar-here')
    };
    page.board.addEventListener('click', onBoardClick);
    page.next.addEventListener('click', function () { if (!page.next.disabled) show(); });
    page.give.addEventListener('click', function () { if (!done) answered(null, true); });
    document.addEventListener('keydown', function (event) {
      // Enter on the focused button already clicks it; only the page itself needs handling.
      if (event.key === 'Enter' && done && event.target.tagName !== 'BUTTON') show();
      if (event.key === 'Escape' && puzzle) { closePromotion(); origin = null; paint(); }
    });

    fetchJson('levels.json').then(function (index) {
      var distances = (index.l || []).filter(function (level) { return level.c > 0; })
        .map(function (level) { return level.n; });
      if (!distances.length) throw new Error('levels.json lists no position');
      // A best kept from a time the site had more levels is held to the levels it has now.
      run = ladder(distances, Math.min(remembered(), distances.length));
      show();
    }).catch(fail);
  });
}(this));
