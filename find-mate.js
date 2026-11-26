/* Find the mate in 1 (task-mate-in-1.md, task-mate-filters.md).
 *
 * index.json says how many position files the site has and describes each of them (its positions,
 * single or several mates, its mates' labels and escape profiles), and mates-<k>.json holds 1,000
 * positions, each a FEN and its mates in 1, every one of them, each [san, escapes, labels]: the
 * escape profile and the labels of task-mate-categories.md, shown once the position is answered.
 *
 * The page starts on a file picked at random among those not loaded yet (the files loaded are kept
 * in the browser, and once every file has been loaded the page starts again from all of them), and
 * the player can switch to any other file from the chooser, which shows what the index says of each.
 * The filter (single mate only, labels shown or hidden, escape profiles) applies to the file loaded
 * alone; its positions are dealt in a random order, those that pass the filter, until the end of the
 * file, which is said. The filter is kept in the browser.
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
  var STORE_FILTER = 'findmatein1.filter';
  var NO_LABEL = 'no label';
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
  // once every file has been loaded; `choose` notes a file the player picked. `fill` takes a file's
  // positions, shuffled once, and `deal` hands out the next one that passes `test` (all of them without
  // one), leaving the others in place; `restart` goes back to the start of that order.
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
        return this.choose(choices[Math.floor(random() * choices.length)]);
      },
      choose: function (index) {
        if (this.seen.indexOf(index) < 0) this.seen.push(index);
        return index;
      },
      fill: function (index, positions) {
        this.current = index;
        this.order = shuffle(positions.slice(), random);
        this.queue = this.order.slice();
      },
      // Back to the start of the file, in the order it was dealt in: what was dealt comes again.
      restart: function () { this.queue = (this.order || []).slice(); },
      deal: function (test) {
        for (var i = 0; i < this.queue.length; i++) {
          if (!test || test(this.queue[i])) return this.queue.splice(i, 1)[0];
        }
        return null;
      },
      remaining: function (test) { return test ? this.queue.filter(test).length : this.queue.length; }
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

  // A position's mates: [san, escapes, labels] each (a file of version 3), or a SAN alone (before).
  function mateList(position) {
    return position[1].map(function (m) {
      return typeof m === 'string' ? { san: m, escapes: null, labels: [] } : { san: m[0], escapes: m[1], labels: m[2] || [] };
    });
  }

  // What is known of each mate, once the position is answered: its labels and its escape profile,
  // the one played marked.
  function mateDetails(mates, played) {
    return '<ul class="fm-mates">' + mates.map(function (m) {
      var labels = m.labels.length ? m.labels.join(', ') : 'no label yet';
      return '<li' + (m.san === played ? ' class="played"' : '') + '><span class="san">' + m.san + '</span> ' +
        '<span class="fm-labels">' + labels + '</span>' +
        (m.escapes ? ' <span class="fm-escapes" title="squares around the king / not taken by its own pieces / enemy pieces controlling them">' + m.escapes + '</span>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  /* ---- the filter (task-mate-filters.md, requirement 4) ---- */

  // single: only positions with one mate; labels: {name: 'show' | 'hide'}, NO_LABEL standing for a
  // mate without one; combine: a mate with 'any' or 'all' of the shown labels; profiles: escape
  // profiles, any of them. A stored filter is read back with whatever it lacks filled in.
  function readFilter(stored) {
    var f = stored && typeof stored === 'object' ? stored : {};
    var labels = {};
    Object.keys(f.labels || {}).forEach(function (name) {
      if (f.labels[name] === 'show' || f.labels[name] === 'hide') labels[name] = f.labels[name];
    });
    return { single: !!f.single, labels: labels, combine: f.combine === 'all' ? 'all' : 'any',
             profiles: Array.isArray(f.profiles) ? f.profiles.slice() : [] };
  }

  function withState(filter, state) {
    return Object.keys(filter.labels).filter(function (name) { return filter.labels[name] === state; });
  }

  function labelNames(mate) { return mate.labels.length ? mate.labels : [NO_LABEL]; }

  // Whether the filter asks for something: shown labels or profiles.
  function asks(filter) { return withState(filter, 'show').length > 0 || filter.profiles.length > 0; }

  // A mate the filter asks for: the shown labels (any or all of them) and one of the profiles, both on
  // this same mate.
  function wanted(mate, filter) {
    var shown = withState(filter, 'show'), names = labelNames(mate);
    var has = function (name) { return names.indexOf(name) >= 0; };
    if (shown.length && !(filter.combine === 'all' ? shown.every(has) : shown.some(has))) return false;
    if (filter.profiles.length && filter.profiles.indexOf(mate.escapes) < 0) return false;
    return true;
  }

  // Whether a position passes the filter, and its mates the filter asks for (all of them when it
  // asks for nothing): dropped when it has several mates under "single", or when any mate has a hidden
  // label, since that one could be played instead.
  function passes(position, filter) {
    var mates = mateList(position);
    if (filter.single && mates.length !== 1) return { ok: false, targets: [] };
    var hidden = withState(filter, 'hide');
    var hides = function (m) { return labelNames(m).some(function (n) { return hidden.indexOf(n) >= 0; }); };
    if (hidden.length && mates.some(hides)) return { ok: false, targets: [] };
    var targets = asks(filter) ? mates.filter(function (m) { return wanted(m, filter); }) : mates;
    return { ok: targets.length > 0, targets: targets };
  }

  /* ---- the files, from the index (task-mate-filters.md, requirements 2 and 5) ---- */

  // Every kind of mate the index knows, alphabetically, "no label" last.
  function kindsOf(index) {
    var names = {};
    index.f.forEach(function (stats) { Object.keys(stats.labels || {}).forEach(function (n) { names[n] = true; }); });
    return Object.keys(names).sort(function (a, b) { return (a === NO_LABEL) - (b === NO_LABEL) || a.localeCompare(b); });
  }

  // Every escape profile of every file, in the order of their numbers.
  function profilesOf(index) {
    var names = {};
    index.f.forEach(function (stats) { Object.keys(stats.profiles || {}).forEach(function (p) { names[p] = true; }); });
    return Object.keys(names).sort(compareProfiles);
  }

  // One row per file: what the index says of it, the mates of every kind and of every escape profile,
  // all of them and those in single-mate positions. Nothing is guessed of what a filter would find in
  // it: only loading the file tells.
  function fileRows(index) {
    var kinds = kindsOf(index), profiles = profilesOf(index);
    return index.f.map(function (stats, k) {
      var row = { k: k, n: stats.n, single: stats.single, several: stats.several, kinds: {}, profiles: {} };
      kinds.forEach(function (name) {
        row.kinds[name] = { all: (stats.labels || {})[name] || 0, single: (stats.singleLabels || {})[name] || 0 };
      });
      profiles.forEach(function (p) {
        row.profiles[p] = { all: (stats.profiles || {})[p] || 0, single: (stats.singleProfiles || {})[p] || 0 };
      });
      return row;
    });
  }

  // The rows sorted by a column: 'k' (the file), 'n', 'single', 'several', or a kind's or a profile's
  // count, 'kind:<name>:all', 'kind:<name>:single', 'profile:<p>:all', 'profile:<p>:single' (all its
  // mates, or those in single-mate positions). Ties keep the files in order.
  function sortRows(rows, key, desc) {
    var value = function (row) {
      var m = /^(kind|profile):(.*):(all|single)$/.exec(key);
      if (m) return ((m[1] === 'kind' ? row.kinds : row.profiles)[m[2]] || { all: 0, single: 0 })[m[3]];
      return row[key];
    };
    return rows.slice().sort(function (a, b) {
      var d = value(a) - value(b);
      return (desc ? -d : d) || a.k - b.k;
    });
  }

  // Profiles in the order of their numbers: around, then open, then controllers ("3/0/0" before
  // "3/1/1" before "5/2/1" before "5/10/1").
  function compareProfiles(a, b) {
    var x = a.split('/').map(Number), y = b.split('/').map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    }
    return 0;
  }

  // The escape profiles of all files, with their counts (of single-mate positions only, if asked).
  function profileTotals(index, single) {
    var totals = {};
    index.f.forEach(function (stats) {
      var table = (single ? stats.singleProfiles : stats.profiles) || {};
      Object.keys(table).forEach(function (p) { totals[p] = (totals[p] || 0) + table[p]; });
    });
    return totals;
  }

  // What the filter finds in the file loaded, in positions: how many pass, and how many are still to come
  // after the one on the board (counts of mates are not counts of positions: one position can hold
  // seven mates of a profile).
  function matchLine(file, passing, left, onBoard, filtering) {
    var head = 'File ' + file + ': ';
    if (!passing) return head + 'no position passes this filter.';
    var more = left === 0 ? 'none' : String(left);
    return head + passing + (filtering ? (passing === 1 ? ' position passes' : ' positions pass') + ' this filter; '
                                      : (passing === 1 ? ' position; ' : ' positions; ')) +
      (onBoard ? 'this one, and ' + more + ' after it.' : more + ' still to come.');
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
    shuffle: shuffle, deck: deck, streak: streak, named: named, others: others, missed: missed,
    mateList: mateList, mateDetails: mateDetails, readFilter: readFilter, asks: asks, wanted: wanted,
    passes: passes, kindsOf: kindsOf, profilesOf: profilesOf, fileRows: fileRows, sortRows: sortRows,
    profileTotals: profileTotals, compareProfiles: compareProfiles, matchLine: matchLine
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  /* ---- the page ---- */

  var Chess = root.Chess;
  var page = null, cards = null, score = null, index = null, filter = null;
  var loaded = -1, loading = null, sortBy = { key: 'k', desc: false };
  // The index's figures, one row per file, computed once.
  var fileData = null;
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

  function fileName(k) { return 'mates-' + String(k).padStart(3, '0') + '.json'; }

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
    var mates = mateList(position);
    var answers = mates.map(function (m) { return m.san; });
    var targets = passes(position, filter).targets.map(function (m) { return m.san; });
    var asked = asks(filter) && targets.length && targets.length < answers.length;
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
      verdict('right', '<b class="good">Mate.</b> <span class="san">' + move.san + '</span>. ' + others(answers, move.san) +
        (asked && targets.indexOf(move.san) < 0 ? ' It is not the mate the filter asks for: that was ' + named(targets) + '.' : ''));
    } else {
      score.lose();
      verdict('wrong', (gaveUp
        ? '<b>The mate was ' + named(answers) + '.</b>'
        : '<b class="bad">Not that one.</b> ' + missed(move.san, check, stalemate) + ' The mate was ' + named(answers) + '.') +
        (asked ? ' The filter asked for ' + named(targets) + '.' : ''));
    }

    page.verdict.innerHTML += mateDetails(mates, right ? move.san : null);
    renderScore();
    renderMatch();
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

  function test(p) { return passes(p, filter).ok; }

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
    renderMatch();
  }

  // The next position of the file loaded that passes the filter, or the end of the file, said.
  function show() {
    page.next.disabled = true;
    if (loaded < 0) return;
    var next = cards.deal(test);
    if (next) { setUp(next); return; }
    position = null;
    page.give.disabled = true;
    var filtering = asks(filter) || filter.single || withState(filter, 'hide').length;
    // Nothing of the file passes, from its start: say so, rather than an end the player never saw.
    var none = filtering && !(cards.order || []).some(test);
    verdict('', none
      ? 'No position of file ' + (loaded + 1) + ' passes this filter. The table of files below shows which files hold ' +
        'the kinds and escapes you chose: sort it by one of them, and choose a file.'
      : 'You have reached the end of file ' + (loaded + 1) + (filtering ? ' for this filter' : '') +
        '. Choose another file, or change the filter.');
    renderMatch();
  }

  // A file, loaded and dealt from; a second call for the same file waits on the first.
  function load(k) {
    if (loading && loading.k === k) return loading.promise;
    page.next.disabled = true;
    verdict('', 'Loading file ' + (k + 1) + '…');
    var promise = fetchJson(fileName(k)).then(function (file) {
      if (loading && loading.k !== k) return;
      loading = null;
      cards.fill(k, file.p || []);
      loaded = k;
      store(STORE_SEEN, cards.seen);
      markFiles();
      renderFilter();
      show();
    });
    loading = { k: k, promise: promise };
    return promise.catch(fail);
  }

  /* ---- the file chooser and the filter panel ---- */

  // The table of files: everything the index says of each, so a file can be chosen before it is loaded.
  // Every kind, then every escape profile in the order of their numbers, gets two columns: all its mates
  // and those in single-mate positions, each sorted on its own. The table scrolls sideways, the file's
  // number kept in view.
  //
  // A thousand rows of nearly two hundred cells took the browser seconds to lay out on every sort, so
  // only the rows in view (and a margin) are in the page; spacers above and below keep the scrollbar
  // true, and a scroll, a sort or a file played redraws those rows alone. The columns have fixed widths,
  // so that rows coming and going do not move them.
  var ROW_BUFFER = 15;
  var fileGroups = null, fileOrder = null, rowHeight = 0, drawPending = false;

  function renderFiles() {
    var kinds = kindsOf(index);
    fileGroups = kinds.map(function (name) {
      return { key: 'kind:' + name, text: name, what: 'mates of this kind' };
    }).concat(profilesOf(index).map(function (p, i) {
      return { key: 'profile:' + p, text: p, what: 'mates with these escapes', first: i === 0 };
    }));
    fileData = fileRows(index);
    var sortButton = function (key, text, title) {
      return '<button type="button" data-sort="' + key + '" data-text="' + text + '" title="' + title + '">' + text + '</button>';
    };
    var plain = function (key, text, title, extra) {
      return '<th scope="col" rowspan="2"' + (extra ? ' class="' + extra + '"' : '') + '>' + sortButton(key, text, title) + '</th>';
    };
    var widths = [64, 84, 64, 72];
    fileGroups.forEach(function () { widths.push(64, 64); });
    page.files.innerHTML = '<table style="width:' + widths.reduce(function (a, b) { return a + b; }, 0) + 'px"><colgroup>' +
      widths.map(function (w) { return '<col style="width:' + w + 'px">'; }).join('') + '</colgroup><thead><tr>' +
      plain('k', 'File', 'Sort by file', 'fm-file-col') +
      plain('n', 'Positions', 'Positions in the file') +
      plain('single', 'Single', 'Positions with a single mate') +
      plain('several', 'Several', 'Positions with several mates') +
      fileGroups.map(function (g) {
        return '<th scope="colgroup" colspan="2" class="fm-group-start' + (g.first ? ' fm-profiles-start' : '') + '">' + g.text + '</th>';
      }).join('') + '</tr><tr>' +
      fileGroups.map(function (g) {
        return '<th scope="col" class="fm-group-start">' + sortButton(g.key + ':all', 'all', g.what + ', all') + '</th>' +
          '<th scope="col">' + sortButton(g.key + ':single', 'single', g.what + ', in single-mate positions') + '</th>';
      }).join('') + '</tr></thead><tbody></tbody></table>';
    page.files.addEventListener('scroll', function () {
      if (drawPending) return;
      drawPending = true;
      requestAnimationFrame(function () { drawPending = false; drawFileRows(); });
    });
    sortFiles();
  }

  function fileRowHtml(row) {
    var count = function (c, part) {
      return '<td class="fm-num' + (part === 'all' ? ' fm-group-start' : '') + '">' + c[part] + '</td>';
    };
    return '<tr data-k="' + row.k + '"' + (row.k === loaded ? ' class="current"' : '') + '>' +
      '<th scope="row" class="fm-file-col"><button type="button" data-file="' + row.k + '">' + (row.k + 1) + '</button></th>' +
      '<td class="fm-num">' + row.n + '</td><td class="fm-num">' + row.single + '</td><td class="fm-num">' + row.several + '</td>' +
      fileGroups.map(function (g) {
        var c = g.key.indexOf('kind:') === 0 ? row.kinds[g.key.slice(5)] : row.profiles[g.key.slice(8)];
        return count(c, 'all') + count(c, 'single');
      }).join('') + '</tr>';
  }

  // The rows in view, and a margin, between two spacers as tall as the rows left out.
  function drawFileRows() {
    var body = page.files.querySelector('tbody');
    if (!body || !fileOrder) return;
    var head = page.files.querySelector('thead').offsetHeight;
    var height = rowHeight || 26;
    var first = Math.max(0, Math.floor((page.files.scrollTop - head) / height) - ROW_BUFFER);
    var last = Math.min(fileOrder.length, first + Math.ceil(page.files.clientHeight / height) + 2 * ROW_BUFFER);
    var span = 4 + 2 * fileGroups.length;
    var spacer = function (rows) {
      return rows > 0 ? '<tr class="fm-spacer" style="height:' + rows * height + 'px"><td colspan="' + span + '"></td></tr>' : '';
    };
    body.innerHTML = spacer(first) + fileOrder.slice(first, last).map(fileRowHtml).join('') + spacer(fileOrder.length - last);
    if (!rowHeight) {
      var drawn = body.querySelector('tr[data-k]');
      if (drawn && drawn.offsetHeight) { rowHeight = drawn.offsetHeight; drawFileRows(); }
    }
  }

  // A sort: the rows put in the new order, the arrows of the head updated, and the rows in view drawn.
  function sortFiles() {
    fileOrder = sortRows(fileData, sortBy.key, sortBy.desc);
    Array.prototype.forEach.call(page.files.querySelectorAll('thead button[data-sort]'), function (button) {
      var on = button.dataset.sort === sortBy.key;
      button.classList.toggle('sorted', on);
      button.textContent = button.dataset.text + (on ? (sortBy.desc ? ' ▾' : ' ▴') : '');
    });
    drawFileRows();
  }

  // The file played, marked in the table. The table shows nothing of the filter.
  function markFiles() {
    drawFileRows();
  }

  // The filter panel; its counts are those of all files, so it can be set before a file is chosen.
  function renderFilter() {
    // Each kind and profile with its mates in the file loaded, the one the filter searches; the table of
    // files shows the others.
    var here = loaded >= 0 ? index.f[loaded] : null;
    var hereLabels = here ? ((filter.single ? here.singleLabels : here.labels) || {}) : {};
    var hereProfiles = here ? ((filter.single ? here.singleProfiles : here.profiles) || {}) : {};
    var kinds = kindsOf(index);
    page.single.checked = filter.single;
    page.combine.value = filter.combine;
    page.labels.innerHTML = kinds.concat(Object.keys(filter.labels).filter(function (n) {
      return kinds.indexOf(n) < 0;
    })).map(function (name) {
      var state = filter.labels[name] || '';
      return '<label class="fm-label-row"><span>' + name + ' <span class="fm-count">' +
        (here ? hereLabels[name] || 0 : '') + '</span></span><select data-label="' + name + '">' +
        ['', 'show', 'hide'].map(function (v) {
          return '<option value="' + v + '"' + (v === state ? ' selected' : '') + '>' + (v || '—') + '</option>';
        }).join('') + '</select></label>';
    }).join('');
    // The profiles of the file loaded, with their mates in it, in the order of their numbers; one chosen
    // that the file lacks stays, so that it can be unchosen.
    var keys = Object.keys(hereProfiles).filter(function (p) { return hereProfiles[p] > 0; });
    filter.profiles.forEach(function (p) { if (keys.indexOf(p) < 0) keys.push(p); });
    keys.sort(compareProfiles);
    page.profiles.innerHTML = keys.map(function (p) {
      return '<option value="' + p + '"' + (filter.profiles.indexOf(p) >= 0 ? ' selected' : '') + '>' + p + ' — ' +
        (hereProfiles[p] || 0) + '</option>';
    }).join('');
  }

  function renderMatch() {
    if (loaded < 0) { page.match.textContent = ''; return; }
    page.match.textContent = matchLine(loaded + 1, (cards.order || []).filter(test).length, cards.remaining(test),
                                       !!position && test(position),
                                       asks(filter) || filter.single || withState(filter, 'hide').length > 0);
  }

  // A filter changed: kept, and applied from the start of the file, positions already dealt included,
  // with the first one that passes on the board at once.
  function changed() {
    store(STORE_FILTER, filter);
    renderFilter();
    if (loaded < 0) return;
    cards.restart();
    position = null;
    show();
  }

  function wirePanel() {
    page.files.addEventListener('click', function (event) {
      var sort = event.target.closest('[data-sort]'), file = event.target.closest('[data-file]');
      if (sort) {
        var key = sort.dataset.sort;
        // A column clicked again turns round; a count starts with the largest, the file with the first.
        sortBy = sortBy.key === key ? { key: key, desc: !sortBy.desc } : { key: key, desc: key !== 'k' };
        sortFiles();
      } else if (file) {
        load(cards.choose(Number(file.dataset.file)));
      }
    });
    page.single.addEventListener('change', function () { filter.single = page.single.checked; changed(); });
    page.combine.addEventListener('change', function () { filter.combine = page.combine.value; changed(); });
    page.labels.addEventListener('change', function (event) {
      var name = event.target.dataset.label;
      if (!name) return;
      if (event.target.value) filter.labels[name] = event.target.value; else delete filter.labels[name];
      changed();
    });
    page.profiles.addEventListener('change', function () {
      filter.profiles = Array.prototype.filter.call(page.profiles.options, function (o) { return o.selected; })
        .map(function (o) { return o.value; });
      changed();
    });
    page.clear.addEventListener('click', function () { filter = readFilter(null); changed(); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var id = document.getElementById.bind(document);
    page = {
      board: id('fm-board'), level: id('fm-level'), turn: id('fm-turn'), score: id('fm-score'),
      verdict: id('fm-verdict'), next: id('fm-next'), give: id('fm-give'), here: id('bar-here'),
      files: id('fm-files'), single: id('fm-single'), combine: id('fm-combine'), labels: id('fm-labels'),
      profiles: id('fm-profiles'), clear: id('fm-clear'), match: id('fm-match')
    };
    page.board.addEventListener('click', onBoardClick);
    page.next.addEventListener('click', function () { if (!page.next.disabled) show(); });
    page.give.addEventListener('click', function () { if (!done && position) answered(null, true); });
    document.addEventListener('keydown', function (event) {
      // Enter on the focused button already clicks it; only the page itself needs handling.
      if (event.key === 'Enter' && done && event.target.tagName !== 'BUTTON' && event.target.tagName !== 'SELECT') show();
      if (event.key === 'Escape' && position) { closePromotion(); origin = null; paint(); }
    });

    if (!Chess) { fail(new Error('chess.js did not load')); return; }
    score = streak(Number(stored(STORE_BEST, 0)) || 0);
    filter = readFilter(stored(STORE_FILTER, null));
    fetchJson('index.json').then(function (data) {
      if (!data.files || !Array.isArray(data.f)) throw new Error('index.json describes no position file');
      index = data;
      var seen = stored(STORE_SEEN, []);
      cards = deck(index.files, Array.isArray(seen) ? seen : []);
      wirePanel();
      renderFilter();
      renderFiles();
      load(cards.pick());
    }).catch(fail);
  });
}(this));
