// script.js — 时空围棋 主入口: 串联引擎 / AI / UI 与按钮交互
(function () {
  'use strict';

  var engine = new TimeGoEngine({ mode: 'ai' });
  var ai = new TimeGoAI(engine);
  var ui;

  // 交互状态
  var mode = 'play'; // 'play' | 'bt-select-hand' | 'bt-select-target'
  var btHand = null; // 回溯流程选定的母手索引

  function $(id) { return document.getElementById(id); }

  function init() {
    ui = new TimeGoUI({
      engine: engine,
      canvas: $('board'),
      elStatus: $('status'),
      elHistory: $('history'),
      elTimeline: $('timeline'),
      elLog: $('log'),
      elHint: $('hint')
    });

    ui.onBoardClick = onBoardClick;
    bindButtons();
    bindHistory();
    bindTimeline();
    ui.refresh();
    updateHint();
    // 暴露调试对象, 方便在控制台探索引擎/测试分叉等
    window.__timego = { engine: engine, ui: ui, ai: ai };
  }

  // ---------- 按钮绑定 ----------
  function bindButtons() {
    $('btn-backtrack').addEventListener('click', startBacktrack);
    $('btn-pass').addEventListener('click', function () { doPass(); });
    $('btn-resign').addEventListener('click', function () {
      if (engine.gameOver) return;
      if (confirm('确认认输?')) { engine.resign(); afterMove(null); }
    });
    $('btn-end').addEventListener('click', function () {
      if (engine.gameOver) return;
      engine.declareEnd(); afterMove(null);
    });
    $('btn-mode').addEventListener('click', toggleMode);
    $('btn-new').addEventListener('click', function () {
      if (confirm('开始新对局?')) newGame();
    });
  }

  function bindHistory() {
    $('history').addEventListener('click', function (e) {
      var el = e.target.closest('[data-idx]');
      if (!el) return;
      var idx = parseInt(el.getAttribute('data-idx'), 10);
      if (mode === 'bt-select-hand') {
        selectBacktrackHand(idx);
      }
    });
  }

  function bindTimeline() {
    $('timeline').addEventListener('click', function (e) {
      var el = e.target.closest('[data-tl]');
      if (!el) return;
      var id = parseInt(el.getAttribute('data-tl'), 10);
      engine.viewId = id;
      ui.refresh();
    });
  }

  // ---------- 棋盘点击 ----------
  function onBoardClick(coord) {
    if (engine.gameOver) { ui.setHint('对局已结束', true); return; }
    // AI 思考中禁操作
    if (ai.thinking) { ui.setHint('白方思考中, 请稍候...', true); return; }
    // 人机模式: 仅黑方(人)可手动操作
    if (engine.mode === 'ai' && engine.player === 'W') { ui.setHint('当前为白方(AI)回合', true); return; }

    if (mode === 'bt-select-target') {
      doBacktrack(coord);
      return;
    }
    // 普通落子
    var res = engine.makeMove(coord);
    if (!res.ok) {
      ui.setHint('非法着: ' + res.reason, true);
      return;
    }
    afterMove(coord);
  }

  // ---------- 弃权 ----------
  function doPass() {
    if (engine.gameOver) return;
    if (ai.thinking) { ui.setHint('白方思考中...', true); return; }
    if (engine.mode === 'ai' && engine.player === 'W') return;
    engine.pass();
    afterMove(null);
  }

  // ---------- 回溯流程 ----------
  function startBacktrack() {
    if (engine.gameOver) { ui.setHint('对局已结束', true); return; }
    if (engine.mode === 'ai' && engine.player === 'W') { ui.setHint('白方回合不可回溯', true); return; }
    if (ai.thinking) { ui.setHint('白方思考中...', true); return; }
    var bt = engine.getBacktrackableMoves();
    if (bt.length === 0) { ui.setHint('没有可回溯的自己下过的手', true); return; }
    if (!engine.canBacktrack()) { ui.setHint('回溯权不足且债务已满', true); return; }
    mode = 'bt-select-hand';
    btHand = null;
    ui.setHint('回溯: 请在右侧「着手记录」中点击一个你下过的手(母手)');
  }

  function selectBacktrackHand(idx) {
    var moves = engine.active.moves;
    var m = moves[idx];
    if (!m) { ui.setHint('母手无效', true); return; }
    if (m.color !== engine.player) { ui.setHint('只能回溯自己下过的手', true); return; }
    if (m.isLocked) { ui.setHint('该手已锁定', true); return; }
    btHand = idx;
    mode = 'bt-select-target';
    ui.setHint('已选母手第' + (idx + 1) + '手。请在棋盘上点击目标交点(空点/己方子→时痕子; 对方子→时间线分岔)');
  }

  function doBacktrack(coord) {
    if (btHand === null) { ui.setHint('请先选择母手', true); return; }
    var res = engine.timeBack(btHand, coord);
    mode = 'play';
    btHand = null;
    if (!res.ok) {
      ui.setHint('回溯失败: ' + res.reason, true);
      ui.refresh();
      return;
    }
    afterMove(coord);
  }

  function cancelBacktrack() {
    mode = 'play';
    btHand = null;
    updateHint();
  }

  // ---------- 模式切换 / 新对局 ----------
  function toggleMode() {
    if (ai.thinking) { ui.setHint('白方思考中, 暂不可切换', true); return; }
    engine.mode = engine.mode === 'ai' ? 'pvp' : 'ai';
    engine.log.push('模式切换为: ' + (engine.mode === 'ai' ? '人机对战' : '双人本地对战'));
    $('btn-mode').textContent = '模式: ' + (engine.mode === 'ai' ? '人机' : '双人');
    mode = 'play';
    btHand = null;
    ui.refresh();
    maybeTriggerAI();
    updateHint();
  }

  function newGame() {
    var m = engine.mode;
    engine = new TimeGoEngine({ mode: m });
    ai = new TimeGoAI(engine);
    ui.engine = engine;
    ui.setLastMove(null);
    mode = 'play';
    btHand = null;
    ui.refresh();
    updateHint();
    maybeTriggerAI();
  }

  // ---------- 落子后处理 ----------
  function afterMove(coord) {
    ui.setLastMove(coord);
    ui.refresh();
    if (engine.gameOver) { ui.setHint('对局结束', false); return; }
    maybeTriggerAI();
    updateHint();
  }

  // AI 自动出手
  function maybeTriggerAI() {
    if (engine.gameOver) return;
    if (engine.mode !== 'ai') return;
    if (engine.player !== 'W') return;
    if (ai.thinking) return;
    ui.setHint('白方(AI)思考中...');
    ui.refresh();
    ai.chooseMove(function (move) {
      if (engine.gameOver) return;
      if (move.pass) {
        engine.pass();
        ui.setLastMove(null);
      } else {
        var res = engine.makeMove(move);
        if (!res.ok) {
          // 兜底: AI 选了非法着则弃权
          engine.pass();
          ui.setLastMove(null);
        } else {
          ui.setLastMove(move);
        }
      }
      ui.refresh();
      // 若 AI 落子后仍轮到白方 (债务惩罚连下), 继续
      if (!engine.gameOver && engine.player === 'W' && engine.mode === 'ai') {
        setTimeout(maybeTriggerAI, 80);
      } else {
        updateHint();
      }
    });
  }

  function updateHint() {
    if (engine.gameOver) { ui.setHint('对局结束', false); return; }
    if (mode === 'bt-select-hand') { ui.setHint('回溯: 请在右侧选择一个你下过的母手'); return; }
    if (mode === 'bt-select-target') { ui.setHint('回溯: 请在棋盘点击目标交点'); return; }
    if (engine.mode === 'ai' && engine.player === 'W') { ui.setHint('白方(AI)思考中...'); return; }
    var p = engine.player === 'B' ? '黑方' : '白方';
    ui.setHint(p + '回合: 点击棋盘落子, 或使用右侧按钮(回溯/弃权/认输/声明终局)');
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
