// ai.js — 时空围棋 MCTS 人工智能 (白方, 无神经网络)
// 简化: 模拟中忽略分岔/修复, 时痕子按普通子处理 (按规则允许)
(function (global) {
  'use strict';

  var EMPTY = 0, BLACK = 1, WHITE = 2, HOLE = 9;

  // ---------- 快速棋盘 (Int8Array) ----------
  function FastBoard(size) {
    this.size = size;
    this.arr = new Int8Array(size * size);
  }
  FastBoard.prototype.clone = function () {
    var f = new FastBoard(this.size);
    f.arr.set(this.arr);
    return f;
  };
  FastBoard.prototype.get = function (r, c) { return this.arr[r * this.size + c]; };
  FastBoard.prototype.set = function (r, c, v) { this.arr[r * this.size + c] = v; };

  FastBoard.prototype.groupLibs = function (r, c) {
    var size = this.size, arr = this.arr;
    var color = arr[r * size + c];
    if (color === EMPTY || color === HOLE) return { stones: 0, libs: 0 };
    var seen = new Uint8Array(size * size);
    var libSet = new Uint8Array(size * size);
    var stack = [r * size + c];
    seen[r * size + c] = 1;
    var stones = 0, libs = 0;
    while (stack.length) {
      var idx = stack.pop();
      var cr = (idx / size) | 0, cc = idx - cr * size;
      stones++;
      // 四邻
      if (cr > 0) { var ni = (cr - 1) * size + cc; var v = arr[ni]; if (v === EMPTY) { if (!libSet[ni]) { libSet[ni] = 1; libs++; } } else if (v === color && !seen[ni]) { seen[ni] = 1; stack.push(ni); } }
      if (cr < size - 1) { var ni2 = (cr + 1) * size + cc; var v2 = arr[ni2]; if (v2 === EMPTY) { if (!libSet[ni2]) { libSet[ni2] = 1; libs++; } } else if (v2 === color && !seen[ni2]) { seen[ni2] = 1; stack.push(ni2); } }
      if (cc > 0) { var ni3 = cr * size + (cc - 1); var v3 = arr[ni3]; if (v3 === EMPTY) { if (!libSet[ni3]) { libSet[ni3] = 1; libs++; } } else if (v3 === color && !seen[ni3]) { seen[ni3] = 1; stack.push(ni3); } }
      if (cc < size - 1) { var ni4 = cr * size + (cc + 1); var v4 = arr[ni4]; if (v4 === EMPTY) { if (!libSet[ni4]) { libSet[ni4] = 1; libs++; } } else if (v4 === color && !seen[ni4]) { seen[ni4] = 1; stack.push(ni4); } }
    }
    return { stones: stones, libs: libs };
  };

  // 落子, 返回 {ok, captured}
  FastBoard.prototype.play = function (r, c, color) {
    var size = this.size, arr = this.arr;
    var idx = r * size + c;
    if (arr[idx] !== EMPTY) return { ok: false };
    arr[idx] = color;
    var opp = color === BLACK ? WHITE : BLACK;
    var captured = 0;
    var ns = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    for (var i = 0; i < 4; i++) {
      var nr = ns[i][0], nc = ns[i][1];
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (arr[nr * size + nc] !== opp) continue;
      var g = this.groupLibs(nr, nc);
      if (g.libs === 0) {
        // 提走对方整群
        this._removeGroup(nr, nc, opp);
        captured += g.stones;
      }
    }
    // 自杀检测
    var own = this.groupLibs(r, c);
    if (own.libs === 0 && captured === 0) {
      arr[idx] = EMPTY;
      return { ok: false };
    }
    return { ok: true, captured: captured };
  };

  FastBoard.prototype._removeGroup = function (r, c, color) {
    var size = this.size, arr = this.arr;
    var seen = new Uint8Array(size * size);
    var stack = [r * size + c];
    seen[r * size + c] = 1;
    while (stack.length) {
      var idx = stack.pop();
      arr[idx] = EMPTY;
      var cr = (idx / size) | 0, cc = idx - cr * size;
      if (cr > 0) { var ni = (cr - 1) * size + cc; if (arr[ni] === color && !seen[ni]) { seen[ni] = 1; stack.push(ni); } }
      if (cr < size - 1) { var ni2 = (cr + 1) * size + cc; if (arr[ni2] === color && !seen[ni2]) { seen[ni2] = 1; stack.push(ni2); } }
      if (cc > 0) { var ni3 = cr * size + (cc - 1); if (arr[ni3] === color && !seen[ni3]) { seen[ni3] = 1; stack.push(ni3); } }
      if (cc < size - 1) { var ni4 = cr * size + (cc + 1); if (arr[ni4] === color && !seen[ni4]) { seen[ni4] = 1; stack.push(ni4); } }
    }
  };

  // ---------- 候选着生成 ----------
  function genCandidates(fb) {
    var size = fb.size, arr = fb.arr;
    var mask = new Uint8Array(size * size);
    var out = [];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var v = arr[r * size + c];
        if (v === EMPTY || v === HOLE) continue;
        // 在曼哈顿距离<=2的空点生成候选
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            if (Math.abs(dr) + Math.abs(dc) > 2) continue;
            var nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var ni = nr * size + nc;
            if (arr[ni] === EMPTY && !mask[ni]) { mask[ni] = 1; out.push([nr, nc]); }
          }
        }
      }
    }
    return out;
  }

  // ---------- 局面估值 (地域+厚薄影响) ----------
  function evaluate(fb, aiColor) {
    var size = fb.size, arr = fb.arr;
    var visited = new Uint8Array(size * size);
    var bTerr = 0, wTerr = 0, bStones = 0, wStones = 0;
    for (var i = 0; i < size * size; i++) {
      if (arr[i] === BLACK) bStones++;
      else if (arr[i] === WHITE) wStones++;
    }
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var idx = r * size + c;
        if (arr[idx] !== EMPTY || visited[idx]) continue;
        var stack = [idx];
        visited[idx] = 1;
        var count = 0;
        var bB = 0, wB = 0;
        while (stack.length) {
          var cur = stack.pop();
          var cr = (cur / size) | 0, cc = cur - cr * size;
          count++;
          var ns = [[cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]];
          for (var j = 0; j < 4; j++) {
            var nr = ns[j][0], nc = ns[j][1];
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var ni = nr * size + nc;
            var v = arr[ni];
            if (v === EMPTY) { if (!visited[ni]) { visited[ni] = 1; stack.push(ni); } }
            else if (v === BLACK) bB = 1;
            else if (v === WHITE) wB = 1;
          }
        }
        if (bB && !wB) bTerr += count;
        else if (wB && !bB) wTerr += count;
      }
    }
    var bScore = bTerr + bStones;
    var wScore = wTerr + wStones + 6.5;
    if (aiColor === WHITE) return wScore - bScore;
    return bScore - wScore;
  }

  // ---------- MCTS 节点 ----------
  function Node(move, parent) {
    this.move = move; // [r,c] 或 null
    this.parent = parent;
    this.children = [];
    this.visits = 0;
    this.wins = 0;
    this.untried = null;
  }

  function ucb1(child, parentVisits, c) {
    if (child.visits === 0) return 1e9;
    return child.wins / child.visits + c * Math.sqrt(Math.log(parentVisits) / child.visits);
  }

  // ---------- AI 主体 ----------
  function TimeGoAI(engine) {
    this.engine = engine;
    this.size = engine.size;
    this.color = WHITE; // 白方
    this.maxSims = 700;
    this.budget = 2500; // ms
    this.thinking = false;
  }

  // 从引擎快照当前活动棋盘到 FastBoard (时痕子按其颜色普通子处理, 空洞标记)
  TimeGoAI.prototype._snapshot = function () {
    var fb = new FastBoard(this.size);
    var board = this.engine.board;
    for (var r = 0; r < this.size; r++) {
      for (var c = 0; c < this.size; c++) {
        var cell = board[r][c];
        if (!cell) fb.set(r, c, EMPTY);
        else if (cell.hole) fb.set(r, c, HOLE);
        else if (cell.color === 'B') fb.set(r, c, BLACK);
        else fb.set(r, c, WHITE);
      }
    }
    return fb;
  };

  // 选择最佳着法 (异步), 回调 cb({r,c}) 或 cb({pass:true})
  TimeGoAI.prototype.chooseMove = function (cb) {
    var self = this;
    this.thinking = true;
    // 异步启动, 留出 UI 显示 "思考中"
    setTimeout(function () { self._run(cb); }, 30);
  };

  TimeGoAI.prototype._run = function (cb) {
    var self = this;
    var fb = this._snapshot();
    var cands = genCandidates(fb);
    // 过滤明显不合法 (空洞等已在 genCandidates 排除); 再做简单合法性 (自杀) 过滤
    var legal = [];
    for (var i = 0; i < cands.length; i++) {
      var t = fb.clone();
      var res = t.play(cands[i][0], cands[i][1], this.color);
      if (res.ok) legal.push(cands[i]);
    }
    if (legal.length === 0) {
      this.thinking = false;
      cb({ pass: true });
      return;
    }
    // 限制候选规模 (优先靠近敌方/边缘冲突的点)
    if (legal.length > 90) legal.length = 90;

    var root = new Node(null, null);
    root.untried = legal.slice();
    var sims = 0;
    var start = Date.now();
    var aiColor = this.color;

    function runOne() {
      // 1. 选择
      var node = root;
      var simBoard = fb.clone();
      var curColor = aiColor;
      while (node.untried !== null && node.untried.length === 0 && node.children.length > 0) {
        var best = null, bestVal = -1e9;
        for (var i = 0; i < node.children.length; i++) {
          var v = ucb1(node.children[i], node.visits, 1.4);
          if (v > bestVal) { bestVal = v; best = node.children[i]; }
        }
        node = best;
        if (node.move) {
          simBoard.play(node.move[0], node.move[1], curColor);
          curColor = curColor === BLACK ? WHITE : BLACK;
        }
      }
      // 2. 扩展
      if (node.untried && node.untried.length > 0) {
        var mv = node.untried.pop();
        simBoard.play(mv[0], mv[1], curColor);
        var child = new Node(mv, node);
        child.untried = genCandidates(simBoard);
        if (child.untried.length > 40) child.untried.length = 40;
        node.children.push(child);
        node = child;
        curColor = curColor === BLACK ? WHITE : BLACK;
      }
      // 3. 模拟 (贪心+随机)
      var rollColor = curColor;
      var rollBoard = simBoard.clone();
      var depth = 0, maxDepth = 14;
      var passes = 0;
      while (depth < maxDepth && passes < 2) {
        var rc = genCandidates(rollBoard);
        if (rc.length === 0) { passes++; rollColor = rollColor === BLACK ? WHITE : BLACK; depth++; continue; }
        var pick = null;
        // 30% 贪心: 选立即提子最多或扩展己方气最多的点
        if (Math.random() < 0.3) {
          var bestR = null, bestScore = -1;
          for (var s = 0; s < rc.length; s++) {
            var tb = rollBoard.clone();
            var rr = tb.play(rc[s][0], rc[s][1], rollColor);
            if (!rr.ok) continue;
            var sc = rr.captured * 5;
            if (sc > bestScore) { bestScore = sc; bestR = rc[s]; }
          }
          pick = bestR;
        }
        if (!pick) pick = rc[(Math.random() * rc.length) | 0];
        var played = rollBoard.play(pick[0], pick[1], rollColor);
        if (!played.ok) { passes++; }
        rollColor = rollColor === BLACK ? WHITE : BLACK;
        depth++;
      }
      // 4. 估值
      var ev = evaluate(rollBoard, aiColor);
      var win = ev > 0 ? 1 : (ev === 0 ? 0.5 : 0);
      // 5. 回传
      while (node) {
        node.visits++;
        node.wins += win;
        node = node.parent;
      }
    }

    function tick() {
      var batch = 0;
      while (sims < self.maxSims && (Date.now() - start) < self.budget && batch < 50) {
        runOne();
        sims++; batch++;
      }
      if (sims < self.maxSims && (Date.now() - start) < self.budget) {
        setTimeout(tick, 0);
      } else {
        // 选访问次数最多的子
        var bestChild = null, bestVisits = -1;
        for (var i = 0; i < root.children.length; i++) {
          if (root.children[i].visits > bestVisits) {
            bestVisits = root.children[i].visits;
            bestChild = root.children[i];
          }
        }
        self.thinking = false;
        if (bestChild && bestChild.move) cb({ r: bestChild.move[0], c: bestChild.move[1] });
        else cb({ pass: true });
      }
    }
    tick();
  };

  global.TimeGoAI = TimeGoAI;
})(typeof window !== 'undefined' ? window : globalThis);
