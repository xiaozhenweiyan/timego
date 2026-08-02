// engine.js — 时空围棋 TimeGo 引擎核心
// 实现: 25x25 围棋基础 + 回溯权/时间债务 + 时痕子 + 时间线分岔/修复 + 毁灭性共振 + 终局计分
(function (global) {
  'use strict';

  var SIZE = 25;
  var COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, SIZE); // A-Y 共25列

  // ---------- 工具函数 ----------
  function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

  function neighbors(r, c) {
    var out = [];
    if (r > 0) out.push([r - 1, c]);
    if (r < SIZE - 1) out.push([r + 1, c]);
    if (c > 0) out.push([r, c - 1]);
    if (c < SIZE - 1) out.push([r, c + 1]);
    return out;
  }

  function cloneBoard(b) {
    var nb = new Array(SIZE);
    for (var r = 0; r < SIZE; r++) nb[r] = b[r].slice();
    return nb;
  }

  function emptyBoard() {
    var b = new Array(SIZE);
    for (var r = 0; r < SIZE; r++) b[r] = new Array(SIZE).fill(null);
    return b;
  }

  function coordToLabel(r, c) { return COLS[c] + (r + 1); }
  function labelToCoord(label) {
    if (!label) return null;
    var col = COLS.indexOf(label[0].toUpperCase());
    var row = parseInt(label.slice(1), 10) - 1;
    if (!inBounds(row, col)) return null;
    return { r: row, c: col };
  }

  // 单元格是否能与同色棋子连接成群 (时痕子: 稳定期 life<=20 可连接; 惰性期不连接)
  function cellConnects(cell) {
    if (!cell || cell.hole) return false;
    if (cell.trace) return cell.life <= 20;
    return true; // 普通子
  }

  // 计算棋子所属群及其气 (BFS)
  function getGroup(board, sr, sc) {
    var start = board[sr][sc];
    if (!start || start.hole) return null;
    var color = start.color;
    var stones = [];
    var libs = {};
    var libCount = 0;
    var seen = {};
    var stack = [[sr, sc]];
    seen[sr * SIZE + sc] = true;
    var startConnects = cellConnects(start);
    while (stack.length) {
      var cur = stack.pop();
      var r = cur[0], c = cur[1];
      stones.push([r, c]);
      var ns = neighbors(r, c);
      for (var i = 0; i < ns.length; i++) {
        var nr = ns[i][0], nc = ns[i][1];
        var key = nr * SIZE + nc;
        var cell = board[nr][nc];
        if (!cell) { // 空 = 气
          if (!libs[key]) { libs[key] = true; libCount++; }
        } else if (cell.hole) {
          // 永久空洞: 障碍, 非气
        } else if (cell.color === color && startConnects && cellConnects(cell)) {
          if (!seen[key]) { seen[key] = true; stack.push([nr, nc]); }
        }
        // 对方子 / 惰性时痕子: 非气, 非连接
      }
    }
    return { color: color, stones: stones, libCount: libCount };
  }

  // 落子后提走对方无气群的普通子 (时痕子不可提, 保留)
  function applyCaptures(board, r, c, moverColor) {
    var opp = moverColor === 'B' ? 'W' : 'B';
    var captured = [];
    var checked = {};
    var ns = neighbors(r, c);
    for (var i = 0; i < ns.length; i++) {
      var nr = ns[i][0], nc = ns[i][1];
      var key = nr * SIZE + nc;
      if (checked[key]) continue;
      var cell = board[nr][nc];
      if (!cell || cell.hole || cell.color !== opp) continue;
      var g = getGroup(board, nr, nc);
      for (var j = 0; j < g.stones.length; j++) checked[g.stones[j][0] * SIZE + g.stones[j][1]] = true;
      if (g.libCount === 0) {
        for (var k = 0; k < g.stones.length; k++) {
          var gr = g.stones[k][0], gc = g.stones[k][1];
          var cc = board[gr][gc];
          if (cc && !cc.trace && !cc.hole) {
            board[gr][gc] = null;
            captured.push({ r: gr, c: gc, color: opp });
          }
        }
      }
    }
    return captured;
  }

  // 时痕子衰老一拍 (落子时调用)
  function ageTraces(board) {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = board[r][c];
        if (cell && cell.trace) {
          var life = cell.life + 1;
          if (life >= 41) {
            board[r][c] = null; // 41+ 自行湮灭
          } else {
            board[r][c] = { color: cell.color, trace: true, life: life, mother: cell.mother };
          }
        }
      }
    }
  }

  // 局面哈希 (用于超级劫判定; 含时痕子类型, 不含寿命)
  function boardKey(b) {
    var s = '';
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = b[r][c];
        if (!cell) s += '.';
        else if (cell.hole) s += '#';
        else if (cell.trace) s += (cell.color === 'B' ? 'b' : 'w');
        else s += (cell.color === 'B' ? 'B' : 'W');
      }
    }
    return s;
  }

  // ---------- 引擎类 ----------
  function TimeGoEngine(opts) {
    opts = opts || {};
    this.size = SIZE;
    this.komi = 6.5;
    this.mode = opts.mode === 'pvp' ? 'pvp' : 'ai';
    this.reset();
  }

  TimeGoEngine.prototype.reset = function () {
    this.timelines = [];
    this.nextTimelineId = 0;
    this.activeId = 0;
    this._newTimeline(null, null);
    this.blackRights = 0;
    this.whiteRights = 0;
    this.blackDebt = 0;
    this.whiteDebt = 0;
    this.blackRepayDue = -1;
    this.whiteRepayDue = -1;
    this.player = 'B'; // 黑先
    this.gameOver = false;
    this.winner = null;
    this.endReason = '';
    this.consecutivePasses = 0;
    this.canDeclareEnd = false;
    this.declaredEnd = false;
    this.resigned = null;
    this.moveCount = 0;
    this.extraMoves = 0; // 债务连下计数
    this.finalScore = null;
    this.log = ['新对局开始。黑方先手。'];
    this.viewId = 0;
  };

  TimeGoEngine.prototype._newTimeline = function (parentId, forkPoint) {
    var id = this.nextTimelineId++;
    var tl = {
      id: id, parentId: parentId, forkPoint: forkPoint,
      moves: [], frozen: false, discarded: false,
      board: emptyBoard(), superko: {},
      forkStoneCoord: null, forkStoneColor: null
    };
    this.timelines.push(tl);
    return tl;
  };

  // 访问器
  Object.defineProperty(TimeGoEngine.prototype, 'active', {
    get: function () { return this.timelines[this.activeId]; }
  });
  Object.defineProperty(TimeGoEngine.prototype, 'board', {
    get: function () { return this.active.board; }
  });

  TimeGoEngine.prototype.getBoardForView = function (id) {
    var tl = this.timelines[id];
    return tl ? tl.board : null;
  };

  // ---------- 合法性判定 ----------
  TimeGoEngine.prototype.legalMove = function (coord) {
    if (this.gameOver) return { legal: false, reason: '对局已结束' };
    var r = coord.r, c = coord.c;
    if (!inBounds(r, c)) return { legal: false, reason: '越界' };
    var cell = this.board[r][c];
    if (cell && cell.hole) return { legal: false, reason: '永久空洞, 不可落子' };
    if (cell) return { legal: false, reason: '此处已有子' };
    var b = cloneBoard(this.board);
    b[r][c] = { color: this.player, trace: false };
    var captured = applyCaptures(b, r, c, this.player);
    var g = getGroup(b, r, c);
    if (g.libCount === 0 && captured.length === 0) return { legal: false, reason: '自杀禁着' };
    var key = boardKey(b);
    if (this.active.superko[key]) return { legal: false, reason: '违超级劫(再现历史局面)' };
    return { legal: true, captured: captured };
  };

  TimeGoEngine.prototype.getLegalMoves = function () {
    var out = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (this.board[r][c]) continue;
        var chk = this.legalMove({ r: r, c: c });
        if (chk.legal) out.push({ r: r, c: c });
      }
    }
    return out;
  };

  TimeGoEngine.prototype.getBacktrackableMoves = function () {
    var p = this.player;
    var out = [];
    var moves = this.active.moves;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.isLocked) continue;
      if (m.color !== p) continue;
      if (m.type === 'normal' || m.type === 'backtrack') out.push(m.idx);
    }
    return out;
  };

  TimeGoEngine.prototype.canBacktrack = function () {
    var p = this.player;
    var rights = p === 'B' ? this.blackRights : this.whiteRights;
    var debt = p === 'B' ? this.blackDebt : this.whiteDebt;
    return rights > 0 || debt < 3;
  };

  // ---------- 提子收益 (先偿债再给回溯权) ----------
  TimeGoEngine.prototype._grantCaptures = function (player, n) {
    while (n > 0) {
      if (player === 'B') {
        if (this.blackDebt > 0) this.blackDebt--; else this.blackRights++;
      } else {
        if (this.whiteDebt > 0) this.whiteDebt--; else this.whiteRights++;
      }
      n--;
    }
  };

  // ---------- 记录手 ----------
  TimeGoEngine.prototype._record = function (m) {
    m.idx = this.active.moves.length;
    m.globalIdx = this.moveCount;
    m.nextPlayer = this.player === 'B' ? 'W' : 'B';
    if (m.isLocked === undefined) m.isLocked = false;
    this.active.moves.push(m);
    this.active.superko[boardKey(m.boardAfter)] = true;
    this.moveCount++;
  };

  // ---------- 普通落子 ----------
  TimeGoEngine.prototype.makeMove = function (coord) {
    var check = this.legalMove(coord);
    if (!check.legal) return { ok: false, reason: check.reason };
    ageTraces(this.board);
    var r = coord.r, c = coord.c;
    this.board[r][c] = { color: this.player, trace: false };
    var captured = applyCaptures(this.board, r, c, this.player);
    var res = this._resonance(this.board);
    this._grantCaptures(this.player, captured.length);
    var note = '';
    if (captured.length) note += '提' + captured.length + '子 ';
    if (res) note += '毁灭性共振!';
    this._record({
      type: 'normal', color: this.player, coord: { r: r, c: c },
      captured: captured, boardAfter: cloneBoard(this.board), note: note
    });
    if (note) this.log.push('第' + this.moveCount + '手 ' + (this.player === 'B' ? '黑' : '白') + ' ' + coordToLabel(r, c) + ': ' + note);
    this.consecutivePasses = 0;
    var repaired = this._checkRepair(captured);
    this._endTurn();
    return { ok: true, captured: captured, resonance: res, repaired: repaired };
  };

  // ---------- 回溯 (时痕子 / 分岔) ----------
  TimeGoEngine.prototype.timeBack = function (targetHandIndex, coord) {
    if (this.gameOver) return { ok: false, reason: '对局已结束' };
    var tl = this.active;
    if (targetHandIndex < 0 || targetHandIndex >= tl.moves.length) return { ok: false, reason: '回溯目标无效' };
    var tm = tl.moves[targetHandIndex];
    if (tm.color !== this.player) return { ok: false, reason: '只能回溯自己下过的手' };
    if (tm.isLocked) return { ok: false, reason: '该手已锁定, 不可回溯' };
    var p = this.player;
    var rights = p === 'B' ? this.blackRights : this.whiteRights;
    var debt = p === 'B' ? this.blackDebt : this.whiteDebt;
    if (rights <= 0 && debt >= 3) return { ok: false, reason: '回溯权不足且债务已满3' };

    // 支付回溯权 / 债务
    if (rights > 0) {
      if (p === 'B') this.blackRights--; else this.whiteRights--;
    } else {
      if (p === 'B') { this.blackDebt++; if (this.blackRepayDue < 0) this.blackRepayDue = this.moveCount + 20; }
      else { this.whiteDebt++; if (this.whiteRepayDue < 0) this.whiteRepayDue = this.moveCount + 20; }
    }

    var r = coord.r, c = coord.c;
    if (!inBounds(r, c)) return { ok: false, reason: '越界' };
    var cell = this.board[r][c];
    if (cell && cell.hole) return { ok: false, reason: '永久空洞, 不可回溯' };
    if (cell && cell.color !== p) {
      // 对方子 -> 时间线分岔
      return this._fork(targetHandIndex, coord);
    }
    // 空点 / 己方子 -> 放置时痕子
    ageTraces(this.board);
    this._recharge(this.board, r, c);
    this.board[r][c] = { color: p, trace: true, life: 0, mother: targetHandIndex };
    var captured = applyCaptures(this.board, r, c, p);
    this._grantCaptures(p, captured.length);
    var res = this._resonance(this.board);
    var note = '落时痕子';
    if (captured.length) note += ',提' + captured.length + '子';
    if (res) note += ',共振!';
    this._record({
      type: 'backtrack', color: p, coord: { r: r, c: c },
      captured: captured, boardAfter: cloneBoard(this.board),
      targetHandIndex: targetHandIndex, note: note
    });
    this.log.push('第' + this.moveCount + '手 ' + (p === 'B' ? '黑' : '白') + ' 回溯至第' + (targetHandIndex + 1) + '手, ' + coordToLabel(r, c) + ' ' + note);
    this.consecutivePasses = 0;
    this._checkRepair(captured);
    this._endTurn();
    return { ok: true, captured: captured, resonance: res };
  };

  // 时痕子充能 (回溯落子相邻的时痕子寿命归零)
  TimeGoEngine.prototype._recharge = function (board, r, c) {
    var ns = neighbors(r, c);
    for (var i = 0; i < ns.length; i++) {
      var nr = ns[i][0], nc = ns[i][1];
      var cell = board[nr][nc];
      if (cell && cell.trace) {
        board[nr][nc] = { color: cell.color, trace: true, life: 0, mother: cell.mother };
      }
    }
  };

  // ---------- 时间线分岔 ----------
  TimeGoEngine.prototype._fork = function (targetHandIndex, coord) {
    var p = this.player;
    var parent = this.active;
    var r = coord.r, c = coord.c;
    var startBoard = cloneBoard(parent.moves[targetHandIndex].boardAfter);
    var newTl = this._newTimeline(parent.id, targetHandIndex);
    newTl.board = startBoard;
    // 继承母手及之前的着手 (深拷贝, 锁定状态清空)
    for (var i = 0; i <= targetHandIndex; i++) {
      var m = parent.moves[i];
      var copy = {};
      for (var k in m) { if (m.hasOwnProperty(k)) copy[k] = m[k]; }
      copy.isLocked = false;
      copy.boardAfter = cloneBoard(m.boardAfter);
      newTl.moves.push(copy);
      newTl.superko[boardKey(copy.boardAfter)] = true;
    }
    newTl.forkStoneCoord = { r: r, c: c };
    newTl.forkStoneColor = p;
    // 在新时间线放置普通子
    ageTraces(newTl.board);
    newTl.board[r][c] = { color: p, trace: false };
    var captured = applyCaptures(newTl.board, r, c, p);
    this._grantCaptures(p, captured.length);
    this._resonance(newTl.board);
    parent.frozen = true;
    this.activeId = newTl.id;
    var note = '时间线分岔';
    this._record({
      type: 'fork', color: p, coord: { r: r, c: c },
      captured: captured, boardAfter: cloneBoard(newTl.board),
      targetHandIndex: targetHandIndex, note: note
    });
    this.log.push((p === 'B' ? '黑' : '白') + ' 回溯撞击对方子, 时间线分岔! 新时间线 #' + newTl.id + ' 落子 ' + coordToLabel(r, c));
    this.consecutivePasses = 0;
    this._endTurn();
    return { ok: true, fork: true, newTimelineId: newTl.id };
  };

  // ---------- 修复判定 ----------
  TimeGoEngine.prototype._checkRepair = function (captured) {
    var tl = this.active;
    if (!tl.forkStoneCoord) return false;
    for (var i = 0; i < captured.length; i++) {
      if (captured[i].r === tl.forkStoneCoord.r && captured[i].c === tl.forkStoneCoord.c) {
        this._repair();
        return true;
      }
    }
    return false;
  };

  TimeGoEngine.prototype._repair = function () {
    var child = this.active;
    var parent = this.timelines[child.parentId];
    if (!parent) return;
    for (var i = 0; i <= child.forkPoint; i++) {
      if (parent.moves[i]) parent.moves[i].isLocked = true;
    }
    // 提子的那手 (新时间线最新手) 也锁定; 之后丢弃
    var last = child.moves[child.moves.length - 1];
    if (last) last.isLocked = true;
    child.frozen = true;
    child.discarded = true;
    parent.frozen = false;
    this.activeId = parent.id;
    this.viewId = parent.id;
    // 母手被锁定 -> 引发分岔的时痕子应湮灭 (本实现中分岔未在原时间线留时痕子, 此处为规则占位说明)
    this.log.push('时间线修复! 战场回到原时间线 #' + parent.id + ', 前' + (child.forkPoint + 1) + '手锁定为既定事实');
  };

  // ---------- 毁灭性共振 ----------
  TimeGoEngine.prototype._resonance = function (board) {
    var traces = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = board[r][c];
        if (cell && cell.trace) traces.push({ r: r, c: c });
      }
    }
    if (traces.length < 3) return false;
    var groups = { row: {}, col: {}, d1: {}, d2: {} };
    for (var i = 0; i < traces.length; i++) {
      var t = traces[i];
      var k1 = t.r, k2 = t.c, k3 = t.r - t.c, k4 = t.r + t.c;
      (groups.row[k1] = groups.row[k1] || []).push(t);
      (groups.col[k2] = groups.col[k2] || []).push(t);
      (groups.d1[k3] = groups.d1[k3] || []).push(t);
      (groups.d2[k4] = groups.d2[k4] || []).push(t);
    }
    var lines = [];
    function scan(obj, type) {
      for (var key in obj) {
        if (obj.hasOwnProperty(key) && obj[key].length >= 3) lines.push({ type: type, key: parseInt(key, 10) });
      }
    }
    scan(groups.row, 'row'); scan(groups.col, 'col'); scan(groups.d1, 'd1'); scan(groups.d2, 'd2');
    if (lines.length === 0) return false;
    var changed = false;
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li];
      var cells = [];
      if (ln.type === 'row') { for (var cc = 0; cc < SIZE; cc++) cells.push([ln.key, cc]); }
      else if (ln.type === 'col') { for (var rr = 0; rr < SIZE; rr++) cells.push([rr, ln.key]); }
      else if (ln.type === 'd1') { for (var rr2 = 0; rr2 < SIZE; rr2++) { var cc2 = rr2 - ln.key; if (cc2 >= 0 && cc2 < SIZE) cells.push([rr2, cc2]); } }
      else { for (var rr3 = 0; rr3 < SIZE; rr3++) { var cc3 = ln.key - rr3; if (cc3 >= 0 && cc3 < SIZE) cells.push([rr3, cc3]); } }
      for (var ci = 0; ci < cells.length; ci++) {
        var cr = cells[ci][0], ccc = cells[ci][1];
        var ce = board[cr][ccc];
        if (ce && !ce.hole) { board[cr][ccc] = { hole: true }; changed = true; }
      }
    }
    if (changed) this.log.push('毁灭性共振! 共振线上棋子化为永久空洞');
    return changed;
  };

  // ---------- 弃权 / 认输 / 声明终局 ----------
  TimeGoEngine.prototype.pass = function () {
    if (this.gameOver) return { ok: false, reason: '对局已结束' };
    this.consecutivePasses++;
    this._record({
      type: 'pass', color: this.player, coord: null, captured: [],
      boardAfter: cloneBoard(this.board), note: '弃权'
    });
    this.log.push('第' + this.moveCount + '手 ' + (this.player === 'B' ? '黑' : '白') + ' 弃权');
    if (this.consecutivePasses >= 2) {
      this.canDeclareEnd = true;
      this.log.push('双方连续弃权, 可声明终局(不再回溯)');
    }
    this._endTurn();
    return { ok: true };
  };

  TimeGoEngine.prototype.resign = function () {
    if (this.gameOver) return { ok: false, reason: '对局已结束' };
    var loser = this.player;
    this.resigned = loser;
    this.gameOver = true;
    this.endReason = '认输';
    this.winner = loser === 'B' ? 'W' : 'B';
    this.log.push((loser === 'B' ? '黑' : '白') + ' 认输, ' + (this.winner === 'B' ? '黑' : '白') + '胜');
    return { ok: true };
  };

  TimeGoEngine.prototype.declareEnd = function () {
    if (this.gameOver) return { ok: false, reason: '对局已结束' };
    this._finishGame('声明终局');
    return { ok: true };
  };

  TimeGoEngine.prototype._finishGame = function (reason) {
    this.gameOver = true;
    this.endReason = reason;
    this.declaredEnd = true;
    var s = this.score();
    this.finalScore = s;
    if (s.bScore > s.wScore) this.winner = 'B';
    else if (s.wScore > s.bScore) this.winner = 'W';
    else this.winner = 'draw';
    var msg = '对局结束(' + reason + ')。黑 ' + s.bScore + ' : ' + s.wScore + ' 白。' +
      (this.winner === 'draw' ? '平局' : (this.winner === 'B' ? '黑胜' : '白胜'));
    this.log.push(msg);
  };

  // ---------- 回合切换 (含债务到期跳过) ----------
  TimeGoEngine.prototype._endTurn = function () {
    if (this.gameOver) return;
    if (this.extraMoves > 0) {
      this.extraMoves--; // 同一玩家连下 (债务偿还惩罚后)
    } else {
      this.player = this.player === 'B' ? 'W' : 'B';
      // 检查新玩家是否债务到期需跳过
      var p = this.player;
      var debt = p === 'B' ? this.blackDebt : this.whiteDebt;
      var due = p === 'B' ? this.blackRepayDue : this.whiteRepayDue;
      if (debt > 0 && due > 0 && this.moveCount >= due) {
        this.log.push((p === 'B' ? '黑' : '白') + ' 时空债务到期, 跳过本手(对手连下两手)');
        if (p === 'B') this.blackRepayDue = this.moveCount + 10;
        else this.whiteRepayDue = this.moveCount + 10;
        this.player = p === 'B' ? 'W' : 'B'; // 改由对手连下
        this.extraMoves = 1; // 对手再连下一手 (共两手)
      }
    }
    // 终局: 当前方既无合法着又无法回溯 -> 直接终局
    if (!this.gameOver) {
      var lm = this.getLegalMoves();
      var bt = this.getBacktrackableMoves();
      var canOver = this.canBacktrack();
      if (lm.length === 0 && bt.length === 0 && !canOver) {
        this._finishGame('无棋可下且无法回溯');
      }
    }
  };

  // ---------- 计分 ----------
  TimeGoEngine.prototype.score = function () {
    var board = this.board;
    var visited = [];
    for (var i = 0; i < SIZE; i++) visited.push(new Array(SIZE).fill(false));
    var bTerr = 0, wTerr = 0;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (board[r][c] || visited[r][c]) continue;
        var stack = [[r, c]];
        visited[r][c] = true;
        var region = [];
        var borderColors = {};
        while (stack.length) {
          var cur = stack.pop();
          var cr = cur[0], cc = cur[1];
          region.push([cr, cc]);
          var ns = neighbors(cr, cc);
          for (var j = 0; j < ns.length; j++) {
            var nr = ns[j][0], nc = ns[j][1];
            var cell = board[nr][nc];
            if (!cell) { if (!visited[nr][nc]) { visited[nr][nc] = true; stack.push([nr, nc]); } }
            else if (cell.hole || cell.trace) { /* 空洞/时痕子不主张地域 */ }
            else { borderColors[cell.color] = true; }
          }
        }
        var keys = 0, only = null;
        for (var col in borderColors) { if (borderColors.hasOwnProperty(col)) { keys++; only = col; } }
        if (keys === 1) {
          if (only === 'B') bTerr += region.length; else wTerr += region.length;
        }
      }
    }
    var bScore = bTerr - this.blackDebt * 3;
    var wScore = wTerr + this.komi - this.whiteDebt * 3;
    return {
      bScore: bScore, wScore: wScore, bTerr: bTerr, wTerr: wTerr,
      blackDebt: this.blackDebt, whiteDebt: this.whiteDebt, komi: this.komi
    };
  };

  // ---------- 序列化 (供 UI) ----------
  TimeGoEngine.prototype.serialize = function () {
    var self = this;
    return {
      size: SIZE, komi: this.komi, mode: this.mode,
      player: this.player, gameOver: this.gameOver, winner: this.winner,
      endReason: this.endReason,
      blackRights: this.blackRights, whiteRights: this.whiteRights,
      blackDebt: this.blackDebt, whiteDebt: this.whiteDebt,
      blackRepayDue: this.blackRepayDue, whiteRepayDue: this.whiteRepayDue,
      activeId: this.activeId, viewId: this.viewId, moveCount: this.moveCount,
      consecutivePasses: this.consecutivePasses, canDeclareEnd: this.canDeclareEnd,
      extraMoves: this.extraMoves,
      finalScore: this.finalScore,
      timelines: this.timelines.map(function (t) {
        return {
          id: t.id, parentId: t.parentId, forkPoint: t.forkPoint,
          frozen: t.frozen, discarded: t.discarded,
          forkStoneCoord: t.forkStoneCoord,
          moves: t.moves.map(function (m) {
            return {
              idx: m.idx, globalIdx: m.globalIdx, type: m.type, color: m.color,
              coord: m.coord, targetHandIndex: m.targetHandIndex,
              isLocked: m.isLocked, note: m.note
            };
          })
        };
      }),
      log: this.log.slice(-60)
    };
  };

  // 暴露工具
  TimeGoEngine.SIZE = SIZE;
  TimeGoEngine.COLS = COLS;
  TimeGoEngine.coordToLabel = coordToLabel;
  TimeGoEngine.labelToCoord = labelToCoord;
  TimeGoEngine.inBounds = inBounds;

  global.TimeGoEngine = TimeGoEngine;
})(typeof window !== 'undefined' ? window : globalThis);
