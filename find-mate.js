/* Find the mate in 1 (task-mate-in-1.md).
 *
 * index.json says how many position files the site has, and mates-<k>.json holds 1,000 positions,
 * each a FEN and its mates in 1, every one of them. The page deals one file at a time: it picks a
 * file at random among those it has not loaded yet, deals all of its positions in a random order,
 * and only then picks another. The files loaded are kept in the browser, and once every file has
 * been loaded the page starts again from all of them. The next file is fetched while the last
 * position of the current one is on the board.
 *
 * The rules come from chess.js (chess.js, beside this file): the legal moves of the position, the
 * move played, and whether it mates. A right answer adds one to the streak; a miss, or giving up,
 * resets it.
 */
(function (root) {
  'use strict';

  var FILES = 'abcdefgh';
  var STORE_BEST = 'findmatein1.best';
  var STORE_SEEN = 'findmatein1.seen';
  var ASK = 'Pick up a piece and play the move that mates.';

  /* ---- squares and moves ---- */

  // 'e4' as 28: a1 = 0, h8 = 63.
  function squareIndex(name) { return (name.charCodeAt(0) - 97) + 8 * (Number(name[1]) - 1); }

  // chess.js wants the move counters, which the database's FENs leave out.
  function fullFen(fen) { return fen.split(' ').length < 6 ? fen + ' 0 1' : fen; }

  // The legal moves, with their squares as indexes.
  function legalMoves(chess) {
    return chess.moves({ verbose: true }).map(function (move) {
      return { san: move.san, from: squareIndex(move.from), to: squareIndex(move.to),
               promo: move.promotion || null, uci: move.from + move.to + (move.promotion || '') };
    });
  }

  // The board as sixty-four letters, a1 first, ' ' for an empty square.
  function boardOf(chess) {
    var squares = new Array(64).fill(' ');
    chess.board().forEach(function (row) {
      row.forEach(function (cell) {
        if (cell) squares[squareIndex(cell.square)] = cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
      });
    });
    return squares;
  }

  /* ---- the deck: one file at a time ---- */

  function shuffle(list, random) {
    random = random || Math.random;
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var swap = list[i]; list[i] = list[j]; list[j] = swap;
    }
    return list;
  }

  // `count` files, `seen` the ones already loaded (kept between visits). `pick` chooses the next
  // file among those not yet loaded, never the one being dealt, and starts again from all of them
  // once every file has been loaded. `fill` takes a file's positions, shuffled, and `deal` hands
  // them out until the file is done.
  function deck(count, seen, random) {
    random = random || Math.random;
    var loaded = (seen || []).filter(function (k) { return k >= 0 && k < count; });
    return {
      count: count,
      current: -1,
      seen: loaded,
      queue: [],
      pick: function () {
        var self = this;
        var fresh = function () {
          var out = [];
          for (var k = 0; k < count; k++) if (self.seen.indexOf(k) < 0 && k !== self.current) out.push(k);
          return out;
        };
        var choices = fresh();
        if (!choices.length) {
          // Every file has been loaded: start again, except with the one just dealt, if there is another.
          this.seen = this.current >= 0 && count > 1 ? [this.current] : [];
          choices = fresh();
          if (!choices.length) choices = [0];
        }
        var chosen = choices[Math.floor(random() * choices.length)];
        if (this.seen.indexOf(chosen) < 0) this.seen.push(chosen);
        return chosen;
      },
      fill: function (index, positions) {
        this.current = index;
        this.queue = shuffle(positions.slice(), random);
      },
      deal: function () { return this.queue.length ? this.queue.shift() : null; },
      remaining: function () { return this.queue.length; }
    };
  }

  /* ---- the streak ---- */

  function streak(best) {
    return {
      current: 0, best: best || 0, solved: 0,
      win: function () {
        this.solved++;
        this.current++;
        if (this.current > this.best) this.best = this.current;
      },
      lose: function () { this.current = 0; }
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
    if (!rest.length) return 'It is the only mate.';
    if (rest.length > 4) return 'So do ' + rest.length + ' other moves.';
    return 'So ' + (rest.length === 1 ? 'does ' : 'do ') + named(rest) + '.';
  }

  // Why a move was not the answer, from what it left on the board.
  function missed(san, check, stalemate) {
    var move = '<span class="san">' + san + '</span>';
    if (stalemate) return move + ' is stalemate.';
    if (check) return move + ' gives check, but it is not mate.';
    return move + ' is not mate.';
  }

  var api = {
    squareIndex: squareIndex, fullFen: fullFen, legalMoves: legalMoves, boardOf: boardOf,
    shuffle: shuffle, deck: deck, streak: streak, named: named, others: others, missed: missed
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  /* ---- the page ---- */

  var Chess = root.Chess;
  var page = null, cards = null, score = null, pending = null;
  var position = null, chess = null, moves = [], board = [], white = true, squares = [];
  var origin = null, answer = null, done = false;

  function stored(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch (error) { return fallback; }
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* a private window */ }
  }

  function fetchJson(name) {
    return fetch(name).then(function (response) {
      if (!response.ok) throw new Error(name + ': ' + response.status + ' ' + response.statusText);
      return response.json();
    });
  }

  function fileName(index) { return 'mates-' + String(index).padStart(3, '0') + '.json'; }

  // The next file, picked and fetched once: a second call waits on the first.
  function nextFile() {
    if (!pending) {
      var index = cards.pick();
      store(STORE_SEEN, cards.seen);
      pending = fetchJson(fileName(index)).then(function (file) { return { index: index, positions: file.p || [] }; });
    }
    return pending;
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

  function renderScore() {
    page.score.innerHTML = 'streak <b>' + score.current + '</b> · best <b>' + score.best + '</b> · solved ' + score.solved;
  }

  function renderHead() {
    page.level.innerHTML = 'Find the mate in <span class="fm-n">1</span>';
    page.turn.hidden = false;
    page.turn.textContent = white ? 'White to move' : 'Black to move';
    page.turn.className = 'fm-turn ' + (white ? 'white' : 'black');
    page.here.textContent = position[0];
    renderScore();
  }

  function answered(move, gaveUp) {
    answer = move;
    done = true;
    origin = null;
    var answers = position[1];
    var right = false, check = false, stalemate = false;
    if (move) {
      chess.move(move.san);
      right = !gaveUp && chess.isCheckmate();
      check = chess.isCheck();
      stalemate = chess.isStalemate();
      board = boardOf(chess);
    }

    if (right) {
      score.win();
      store(STORE_BEST, score.best);
      verdict('right', '<b class="good">Mate.</b> <span class="san">' + move.san + '</span>. ' + others(answers, move.san));
    } else {
      score.lose();
      verdict('wrong', gaveUp
        ? '<b>The mate was ' + named(answers) + '.</b>'
        : '<b class="bad">Not that one.</b> ' + missed(move.san, check, stalemate) + ' The mate was ' + named(answers) + '.');
    }

    renderScore();
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

  function setUp(next) {
    position = next;
    chess = new Chess(fullFen(position[0]));
    moves = legalMoves(chess);
    board = boardOf(chess);
    white = chess.turn() === 'w';
    origin = null;
    answer = null;
    done = false;
    page.give.disabled = false;
    closePromotion();
    squares = drawBoard(!white);
    renderHead();
    paint();
    verdict('', ASK);
    // The last position of the file is on the board: fetch the next file while it is played.
    if (!cards.remaining()) nextFile().catch(function () {});
  }

  function show() {
    page.next.disabled = true;
    var next = cards.deal();
    if (next) { setUp(next); return; }
    nextFile().then(function (file) {
      pending = null;
      cards.fill(file.index, file.positions);
      var first = cards.deal();
      if (!first) throw new Error(fileName(file.index) + ' holds no position');
      setUp(first);
    }).catch(fail);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var id = document.getElementById.bind(document);
    page = {
      board: id('fm-board'), level: id('fm-level'), turn: id('fm-turn'), score: id('fm-score'),
      verdict: id('fm-verdict'), next: id('fm-next'), give: id('fm-give'), here: id('bar-here')
    };
    page.board.addEventListener('click', onBoardClick);
    page.next.addEventListener('click', function () { if (!page.next.disabled) show(); });
    page.give.addEventListener('click', function () { if (!done && position) answered(null, true); });
    document.addEventListener('keydown', function (event) {
      // Enter on the focused button already clicks it; only the page itself needs handling.
      if (event.key === 'Enter' && done && event.target.tagName !== 'BUTTON') show();
      if (event.key === 'Escape' && position) { closePromotion(); origin = null; paint(); }
    });

    if (!Chess) { fail(new Error('chess.js did not load')); return; }
    score = streak(Number(stored(STORE_BEST, 0)) || 0);
    fetchJson('index.json').then(function (index) {
      if (!index.files) throw new Error('index.json lists no position file');
      var seen = stored(STORE_SEEN, []);
      cards = deck(index.files, Array.isArray(seen) ? seen : []);
      show();
    }).catch(fail);
  });
}(this));
