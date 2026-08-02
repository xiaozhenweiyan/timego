// ui.js — 时空围棋 棋盘渲染与侧栏交互
(function (global) {
  'use strict';

  var COLS = TimeGoEngine.COLS;
  var SIZE = TimeGoEngine.SIZE;

  function TimeGoUI(opts) {
    this.engine = opts.engine;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.cell = 24;            // 单元格像素
    this.margin = 30;          // 边距
    this.canvas.width = this.margin * 2 + this.cell * (SIZE - 1);
    this.canvas.height = this.margin * 2 + this.cell * (SIZE - 1);

    // 侧栏 DOM
    this.elStatus = opts.elStatus;
    this.elHistory = opts.elHistory;
    this.elTimeline = opts.elTimeline;
    this.elLog = opts.elLog;
    this.elHint = opts.elHint;

    this.hover = null;         // {r,c}
    this.lastMove = null;      // {r,c}
    this.onBoardClick = null;  // 由 script 注入
    this.btSelectedHand = null; // 回溯流程选中的母手索引
    this.btSelectedCoord = null; // 回溯母手坐标 (棋盘上紫色标记)
    this.previewBoard = null;   // 回溯预览: 显示某手的历史局面
    this.previewLabel = null;   // 预览横幅文字

    this._bindEvents();
  }

  // 坐标换算: 棋盘 r(0=底) -> 画布 y(0=顶)
  TimeGoUI.prototype._x = function (c) { return this.margin + c * this.cell; };
  TimeGoUI.prototype._y = function (r) { return this.margin + (SIZE - 1 - r) * this.cell; };

  TimeGoUI.prototype._bindEvents = function () {
    var self = this;
    this.canvas.addEventListener('mousemove', function (e) {
      var pos = self._eventToCoord(e);
      if (pos && (!self.hover || self.hover.r !== pos.r || self.hover.c !== pos.c)) {
        self.hover = pos;
        self.render();
      } else if (!pos && self.hover) {
        self.hover = null;
        self.render();
      }
    });
    this.canvas.addEventListener('mouseleave', function () {
      self.hover = null;
      self.render();
    });
    this.canvas.addEventListener('click', function (e) {
      var pos = self._eventToCoord(e);
      if (pos && self.onBoardClick) self.onBoardClick(pos);
    });
  };

  TimeGoUI.prototype._eventToCoord = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    // 关键修正：画布内部分辨率与 CSS 显示尺寸可能不一致（如 max-width:100% 缩放），
    // 必须把鼠标坐标从 CSS 像素空间换算到画布内部像素空间，否则缩放后点击位置会错位。
    var scaleX = this.canvas.width / rect.width;
    var scaleY = this.canvas.height / rect.height;
    var x = (e.clientX - rect.left) * scaleX;
    var y = (e.clientY - rect.top) * scaleY;
    var c = Math.round((x - this.margin) / this.cell);
    var crr = Math.round((y - this.margin) / this.cell);
    var r = SIZE - 1 - crr;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    // 容差判定
    var dx = x - this._x(c), dy = y - this._y(r);
    if (Math.sqrt(dx * dx + dy * dy) > this.cell * 0.55) return null;
    return { r: r, c: c };
  };

  // 主渲染
  TimeGoUI.prototype.render = function () {
    var ctx = this.ctx;
    // 回溯预览模式优先显示历史局面; 其次查看时间线; 最后活动棋盘
    var board = this.previewBoard || this.engine.getBoardForView(this.engine.viewId) || this.engine.board;
    var W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#e8c27a';
    ctx.fillRect(0, 0, W, H);

    // 网格线
    ctx.strokeStyle = '#3a2a10';
    ctx.lineWidth = 1;
    for (var i = 0; i < SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(this._x(0), this._y(i));
      ctx.lineTo(this._x(SIZE - 1), this._y(i));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(this._x(i), this._y(0));
      ctx.lineTo(this._x(i), this._y(SIZE - 1));
      ctx.stroke();
    }

    // 星位
    var stars = [[3, 3], [3, 11], [3, 19], [11, 3], [11, 11], [11, 19], [19, 3], [19, 11], [19, 19]];
    ctx.fillStyle = '#3a2a10';
    for (var s = 0; s < stars.length; s++) {
      ctx.beginPath();
      ctx.arc(this._x(stars[s][1]), this._y(stars[s][0]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标标签
    ctx.fillStyle = '#3a2a10';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var cc = 0; cc < SIZE; cc++) {
      ctx.fillText(COLS[cc], this._x(cc), 12);
      ctx.fillText(COLS[cc], this._x(cc), H - 12);
    }
    for (var rr = 0; rr < SIZE; rr++) {
      ctx.fillText(String(rr + 1), 12, this._y(rr));
      ctx.fillText(String(rr + 1), W - 12, this._y(rr));
    }

    // 棋子 / 时痕子 / 空洞
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = board[r][c];
        if (!cell) continue;
        if (cell.hole) { this._drawHole(r, c); continue; }
        if (cell.trace) { this._drawTrace(r, c, cell); continue; }
        this._drawStone(r, c, cell.color);
      }
    }

    // 上一手标记
    if (this.lastMove) {
      var lm = this.lastMove;
      var lx = this._x(lm.c), ly = this._y(lm.r);
      ctx.strokeStyle = '#e23b3b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 回溯母手标记: 紫色十字圈, 提示当前选中的母手位置
    if (this.btSelectedCoord) {
      var bc = this.btSelectedCoord;
      var bx = this._x(bc.c), by = this._y(bc.r);
      ctx.strokeStyle = '#b14dff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(bx, by, this.cell * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      // 紫色十字
      ctx.beginPath();
      ctx.moveTo(bx - this.cell * 0.5, by); ctx.lineTo(bx + this.cell * 0.5, by);
      ctx.moveTo(bx, by - this.cell * 0.5); ctx.lineTo(bx, by + this.cell * 0.5);
      ctx.stroke();
    }

    // 悬停预览 (回溯预览模式下禁用, 因为显示的是历史局面)
    if (this.hover && !this.engine.gameOver && !this.previewBoard) {
      var hc = board[this.hover.r][this.hover.c];
      if (!hc) {
        ctx.globalAlpha = 0.4;
        this._drawStone(this.hover.r, this.hover.c, this.engine.player);
        ctx.globalAlpha = 1;
      }
    }

    // 查看历史时间线提示: 醒目蓝色边框 + 顶部横幅
    if (this.engine.viewId !== this.engine.activeId) {
      // 蓝色边框包围整个棋盘, 表示正在查看历史时间线
      ctx.strokeStyle = '#4a90d9';
      ctx.lineWidth = 5;
      ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
      // 顶部蓝色横幅
      ctx.fillStyle = 'rgba(74,144,217,0.95)';
      ctx.fillRect(0, 0, W, 26);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('👁 查看时间线 #' + this.engine.viewId + '（落子仍在活动时间线 #' + this.engine.activeId + '）', 8, 13);
      ctx.textAlign = 'right';
      ctx.fillText('点右侧「返回活动时间线」', W - 8, 13);
      ctx.textBaseline = 'alphabetic';
    }

    // 回溯预览横幅: 紫色边框 + 顶部横幅, 显示正在查看的历史局面
    if (this.previewBoard) {
      ctx.strokeStyle = '#b14dff';
      ctx.lineWidth = 5;
      ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
      ctx.fillStyle = 'rgba(177,77,255,0.95)';
      ctx.fillRect(0, 0, W, 26);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('⏮ 回溯预览: ' + (this.previewLabel || '历史局面') + '（这是过去的样子）', 8, 13);
      ctx.textAlign = 'right';
      ctx.fillText('落子判定仍基于当前最新局面', W - 8, 13);
      ctx.textBaseline = 'alphabetic';
    }
  };

  TimeGoUI.prototype._drawStone = function (r, c, color) {
    var ctx = this.ctx;
    var x = this._x(c), y = this._y(r);
    var rad = this.cell * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    if (color === 'B') {
      var g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.1, x, y, rad);
      g.addColorStop(0, '#555'); g.addColorStop(1, '#000');
      ctx.fillStyle = g; ctx.fill();
    } else {
      var g2 = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.1, x, y, rad);
      g2.addColorStop(0, '#fff'); g2.addColorStop(1, '#cfcfcf');
      ctx.fillStyle = g2; ctx.fill();
      ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.stroke();
    }
  };

  // 时痕子: 半透明光晕 + 寿命数字
  TimeGoUI.prototype._drawTrace = function (r, c, cell) {
    var ctx = this.ctx;
    var x = this._x(c), y = this._y(r);
    var rad = this.cell * 0.45;
    var stable = cell.life <= 20;
    var inert = cell.life > 20 && cell.life < 41;
    // 光晕
    ctx.beginPath();
    ctx.arc(x, y, rad + 4, 0, Math.PI * 2);
    ctx.fillStyle = cell.color === 'B' ? 'rgba(80,180,255,0.25)' : 'rgba(255,180,80,0.25)';
    ctx.fill();
    // 主体 (半透明)
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = cell.color === 'B' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
    ctx.fill();
    ctx.strokeStyle = cell.color === 'B' ? '#00bfff' : '#ff8c00';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 寿命数字 (距下一衰减阈值的剩余拍数)
    var remain;
    if (stable) remain = 20 - cell.life;       // 距惰性
    else if (inert) remain = 40 - cell.life;   // 距湮灭
    else remain = 0;
    ctx.fillStyle = stable ? '#0a0' : '#a00';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(remain), x, y);
  };

  // 永久空洞: 黑色叉号
  TimeGoUI.prototype._drawHole = function (r, c) {
    var ctx = this.ctx;
    var x = this._x(c), y = this._y(r);
    var s = this.cell * 0.35;
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, s + 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(80,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  // 设置上一手 (用于高亮)
  TimeGoUI.prototype.setLastMove = function (coord) {
    this.lastMove = coord ? { r: coord.r, c: coord.c } : null;
  };

  // ---------- 侧栏渲染 ----------
  TimeGoUI.prototype.renderPanels = function () {
    this._renderStatus();
    this._renderHistory();
    this._renderTimeline();
    this._renderLog();
  };

  TimeGoUI.prototype._renderStatus = function () {
    var e = this.engine;
    var s = e.serialize();
    var pName = s.player === 'B' ? '黑方' : '白方';
    var turnExtra = s.extraMoves > 0 ? ' (连下中)' : '';
    var html = '';
    html += '<div class="st-line"><b>模式:</b> ' + (s.mode === 'ai' ? '人机对战(执黑)' : '双人本地对战') + '</div>';
    html += '<div class="st-line"><b>当前回合:</b> ' + pName + turnExtra + (e.gameOver ? ' — 已结束' : '') + '</div>';
    html += '<div class="st-line"><b>活动时间线:</b> #' + s.activeId + ' ｜ <b>总手数:</b> ' + s.moveCount + '</div>';
    html += '<div class="st-line"><b>贴目:</b> 白 +' + s.komi + '</div>';
    html += '<hr/>';
    html += '<div class="st-line"><b>黑方</b> 回溯权:' + s.blackRights + ' 债务:' + s.blackDebt +
      (s.blackRepayDue > 0 ? ' 追偿点:第' + s.blackRepayDue + '手' : '') + '</div>';
    html += '<div class="st-line"><b>白方</b> 回溯权:' + s.whiteRights + ' 债务:' + s.whiteDebt +
      (s.whiteRepayDue > 0 ? ' 追偿点:第' + s.whiteRepayDue + '手' : '') + '</div>';
    if (s.canDeclareEnd && !e.gameOver) html += '<div class="st-line st-warn">双方连续弃权, 可点击「声明终局」结束。</div>';
    if (e.gameOver) {
      var fs = s.finalScore;
      var winText = s.winner === 'draw' ? '平局' : (s.winner === 'B' ? '黑胜' : '白胜');
      html += '<hr/><div class="st-line st-end">对局结束(' + s.endReason + ')<br/>';
      if (fs) html += '黑 ' + fs.bScore + ' : ' + fs.wScore + ' 白 → ' + winText;
      else html += winText;
      html += '</div>';
    }
    this.elStatus.innerHTML = html;
  };

  TimeGoUI.prototype._renderHistory = function () {
    var moves = this.engine.active.moves;
    var html = '';
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var label = m.coord ? TimeGoEngine.coordToLabel(m.coord.r, m.coord.c) : '—';
      var p = m.color === 'B' ? '黑' : '白';
      var cls = 'hist-item';
      if (m.isLocked) cls += ' hist-locked';
      if (m.type === 'backtrack') cls += ' hist-bt';
      if (m.type === 'fork') cls += ' hist-fork';
      if (m.type === 'pass') cls += ' hist-pass';
      var note = m.note ? ' (' + m.note + ')' : '';
      html += '<div class="' + cls + '" data-idx="' + m.idx + '"><span class="hist-no">' + (m.globalIdx + 1) + '.</span> ' +
        p + ' ' + label + note + (m.isLocked ? ' 🔒' : '') + '</div>';
    }
    if (!html) html = '<div class="hist-empty">尚无着手</div>';
    this.elHistory.innerHTML = html;
  };

  // 时间线树形可视化: 按父子关系缩进, 每条时间线带迷你棋盘缩略图
  TimeGoUI.prototype._renderTimeline = function () {
    var tls = this.engine.timelines;
    var self = this;

    // 构建父子关系
    var children = {};
    var roots = [];
    for (var i = 0; i < tls.length; i++) {
      var t = tls[i];
      if (t.parentId === null || t.parentId === undefined) {
        roots.push(t.id);
      } else {
        if (!children[t.parentId]) children[t.parentId] = [];
        children[t.parentId].push(t.id);
      }
    }

    var html = '<div class="tl-tree">';
    // 查看非活动时间线时, 顶部显示"返回活动时间线"按钮
    if (this.engine.viewId !== this.engine.activeId) {
      html += '<div class="tl-back" data-tl="' + this.engine.activeId + '">⟲ 返回活动时间线 #' + this.engine.activeId + '</div>';
    }
    // 深度优先遍历, 渲染树形
    function walk(id, depth) {
      var tl = tls[id];
      var cls = 'tl-item';
      if (tl.id === self.engine.activeId) cls += ' tl-active';
      else if (tl.frozen && !tl.discarded) cls += ' tl-frozen';
      if (tl.discarded) cls += ' tl-discarded';
      if (tl.id === self.engine.viewId) cls += ' tl-view';
      var status = tl.id === self.engine.activeId ? '活动' : (tl.discarded ? '已弃' : (tl.frozen ? '冻结' : '可查看'));
      var forkNote = (tl.parentId !== null && tl.parentId !== undefined)
        ? '分岔自 #' + tl.parentId + ' 第' + (tl.forkPoint + 1) + '手'
        : '主时间线';
      html += '<div class="' + cls + '" data-tl="' + tl.id + '" style="margin-left:' + (depth * 16) + 'px">';
      html += '<canvas class="tl-thumb" data-tl="' + tl.id + '" width="56" height="56"></canvas>';
      html += '<div class="tl-meta"><span class="tl-id">#' + tl.id + '</span> ' +
              '<span class="tl-status">' + status + '</span> · ' + tl.moves.length + '手' +
              '<br><span class="tl-note">' + forkNote + '</span></div>';
      html += '</div>';
      var kids = children[id] || [];
      for (var k = 0; k < kids.length; k++) walk(kids[k], depth + 1);
    }
    for (var r = 0; r < roots.length; r++) walk(roots[r], 0);
    if (roots.length === 0) html += '<div class="hist-empty">无时间线</div>';
    html += '</div>';
    this.elTimeline.innerHTML = html;

    // 绘制每个缩略图
    var nodes = this.elTimeline.querySelectorAll('canvas.tl-thumb');
    for (var j = 0; j < nodes.length; j++) {
      var cv = nodes[j];
      var tid = parseInt(cv.getAttribute('data-tl'), 10);
      var board = this.engine.getBoardForView(tid);
      if (!board) continue;
      this._drawThumb(cv.getContext('2d'), board, cv.width);
    }
  };

  // 迷你棋盘缩略图: 在小 canvas 上绘制时间线的最新局面
  TimeGoUI.prototype._drawThumb = function (ctx, board, size) {
    var n = SIZE;
    var step = size / n;
    // 背景
    ctx.fillStyle = '#e8c27a';
    ctx.fillRect(0, 0, size, size);
    // 棋子 (y 轴翻转: 棋盘 r=0 在底, 画布 y=0 在顶)
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var cell = board[r][c];
        if (!cell) continue;
        var x = (c + 0.5) * step;
        var y = (n - 1 - r + 0.5) * step;
        if (cell.hole) {
          ctx.fillStyle = '#1a1a1a';
          ctx.fillRect(x - step * 0.35, y - step * 0.35, step * 0.7, step * 0.7);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, step * 0.45, 0, Math.PI * 2);
          if (cell.trace) {
            // 时痕子: 带颜色光圈
            ctx.fillStyle = cell.color === 'B' ? '#1aa3ff' : '#ff9a1a';
          } else {
            ctx.fillStyle = cell.color === 'B' ? '#000' : '#fff';
          }
          ctx.fill();
          if (cell.color === 'W' || cell.trace) {
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    }
  };

  TimeGoUI.prototype._renderLog = function () {
    var log = this.engine.log;
    var html = '';
    var start = Math.max(0, log.length - 50);
    for (var i = start; i < log.length; i++) {
      html += '<div class="log-line">' + log[i] + '</div>';
    }
    this.elLog.innerHTML = html;
    this.elLog.scrollTop = this.elLog.scrollHeight;
  };

  TimeGoUI.prototype.setHint = function (text, warn) {
    this.elHint.textContent = text || '';
    this.elHint.className = 'hint' + (warn ? ' hint-warn' : '');
  };

  TimeGoUI.prototype.refresh = function () {
    this.render();
    this.renderPanels();
  };

  global.TimeGoUI = TimeGoUI;
})(typeof window !== 'undefined' ? window : globalThis);
