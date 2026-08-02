# -*- coding: utf-8 -*-
"""
《时空围棋》(TimeGo) 后端实现
- TimeGoEngine: 完整规则引擎（镜像 JS 规则）
- MCTS AI（白方）
- Flask + SocketIO 服务器（eventlet 异步模式）

运行: python server/server.py  (监听 0.0.0.0:5000)
"""

import os
import sys
import copy
import math
import json
import random
import hashlib
from collections import deque, defaultdict

# 尝试启用 eventlet 异步模式
try:
    import eventlet
    eventlet.monkey_patch()
    ASYNC_MODE = 'eventlet'
except Exception:
    ASYNC_MODE = 'threading'

from flask import Flask, send_from_directory, jsonify, request
from flask_socketio import SocketIO, emit

# ===========================================================================
# 全局常量
# ===========================================================================
BOARD_SIZE = 25          # 25×25 棋盘
KOMI = 6.5               # 贴目 6.5
DEBT_LIMIT = 3           # 时空债务上限
DEBT_REPAY_WINDOW = 20   # 债务到期窗口（当前手 + 20）
DEBT_RECUR = 10          # 到期后每 10 手再次触发
MAX_DEBT_PENALTY = 3     # 终局每点债务扣 3 目
TIME_TRACE_STABLE_MAX = 20   # 时痕子稳定期 0–20
TIME_TRACE_INERT_MAX = 40    # 失联期 21–40
RESONANCE_THRESHOLD = 3      # 共振阈值：≥3 时痕子共线


# ===========================================================================
# TimeGoEngine —— 规则引擎
# ===========================================================================
class TimeGoEngine:
    """时空围棋核心引擎。棋盘值: None / 'B' / 'W' / 'TB' / 'TW'（时痕子）。"""

    def __init__(self):
        self.size = BOARD_SIZE
        self.reset()

    # ----------------------- 初始化 / 重置 -----------------------
    def reset(self):
        # 棋盘: board[x][y]，x 为第一维（行），y 为第二维（列）
        self.board = [[None] * self.size for _ in range(self.size)]
        self.turn = 'B'                       # 黑先
        self.history = []                     # 当前活跃时间线着法列表
        self.timelines = {                    # 时间线树
            0: {'moves': [], 'parent': None, 'fork_point': None,
                'frozen': False, 'lesion': None}
        }
        self.active_timeline = 0
        self.rights = {'B': 0, 'W': 0}        # 回溯权
        self.debt = {'B': 0, 'W': 0}          # 时空债务
        self.repayment_due = {'B': None, 'W': None}  # 债务到期手数
        self.position_hashes = set()          # 位置超劫（当前时间线历史局面哈希）
        self.permanent_holes = set()          # 永久空洞（不可落子）
        self.time_trace_info = {}             # (x,y) -> {color, age, mother}
        self.game_over = False
        self.winner = None
        self.score = None
        self.end_reason = None
        self.consecutive_passes = 0
        self.give_up_backtrack = {'B': False, 'W': False}
        self.move_count = 0
        self._record_position()               # 记录初始空局

    # ----------------------- 基础工具 -----------------------
    def _in_bounds(self, x, y):
        return 0 <= x < self.size and 0 <= y < self.size

    def _neighbors(self, x, y):
        res = []
        if x > 0:
            res.append((x - 1, y))
        if x < self.size - 1:
            res.append((x + 1, y))
        if y > 0:
            res.append((x, y - 1))
        if y < self.size - 1:
            res.append((x, y + 1))
        return res

    @staticmethod
    def _stone_color(s):
        """返回棋子的归属色 'B'/'W'，空则 None。"""
        if s is None:
            return None
        if s in ('B', 'W'):
            return s
        if s in ('TB', 'TW'):
            return s[1]   # 时痕子归属色
        return None

    def _connects(self, board, x, y):
        """
        判断 (x,y) 处棋子对组连通性的贡献：
        - 'EMPTY' 表示空点（气）
        - 'B'/'W' 表示可连通的同色锚点
        - None 表示阻断（异色，或失联时痕子）
        """
        s = board[x][y]
        if s is None:
            return 'EMPTY'
        sc = self._stone_color(s)
        if s in ('TB', 'TW'):
            info = self.time_trace_info.get((x, y))
            if info and TIME_TRACE_STABLE_MAX < info['age'] <= TIME_TRACE_INERT_MAX:
                return None   # 失联：截断连通
        return sc

    def _group_and_libs(self, board, sx, sy):
        """BFS 求包含 (sx,sy) 的棋链及其气数。时痕子不可被提取但参与连通（失联除外）。"""
        if board[sx][sy] is None:
            return [], 0
        start_color = self._connects(board, sx, sy)
        if start_color is None:
            return [(sx, sy)], 0   # 失联时痕子：单子零气
        visited = {(sx, sy)}
        group = []
        libs = set()
        queue = deque([(sx, sy)])
        while queue:
            cx, cy = queue.popleft()
            group.append((cx, cy))
            for nx, ny in self._neighbors(cx, cy):
                if (nx, ny) in visited:
                    continue
                conn = self._connects(board, nx, ny)
                if conn == 'EMPTY':
                    libs.add((nx, ny))
                elif conn == start_color:
                    visited.add((nx, ny))
                    queue.append((nx, ny))
                # 否则阻断，跳过
        return group, len(libs)

    def _board_hash(self, board=None):
        """对当前局面（含时痕子年龄、空洞）生成哈希，用于位置超劫。"""
        if board is None:
            board = self.board
        parts = []
        for x in range(self.size):
            for y in range(self.size):
                s = board[x][y]
                if s is None:
                    if (x, y) in self.permanent_holes:
                        parts.append('%d,%d:H' % (x, y))
                    continue
                age = ''
                if s in ('TB', 'TW'):
                    info = self.time_trace_info.get((x, y))
                    if info:
                        age = '_%d' % info['age']
                parts.append('%d,%d:%s%s' % (x, y, s, age))
        return hashlib.md5('|'.join(sorted(parts)).encode()).hexdigest()

    def _record_position(self):
        self.position_hashes.add(self._board_hash())

    # ----------------------- 合法性判定 -----------------------
    def _is_legal(self, coord, color):
        """模拟落子，判断是否合法（禁着/自杀/超劫）。"""
        x, y = coord
        if not self._in_bounds(x, y):
            return False
        if (x, y) in self.permanent_holes:
            return False
        if self.board[x][y] is not None:
            return False
        new_board = [row[:] for row in self.board]
        new_board[x][y] = color
        opp = 'W' if color == 'B' else 'B'
        captured = 0
        for nx, ny in self._neighbors(x, y):
            if new_board[nx][ny] == opp:
                _, libs = self._group_and_libs(new_board, nx, ny)
                if libs == 0:
                    grp, _ = self._group_and_libs(new_board, nx, ny)
                    for gx, gy in grp:
                        if new_board[gx][gy] == opp:   # 仅提普通子
                            new_board[gx][gy] = None
                            captured += 1
        _, libs = self._group_and_libs(new_board, x, y)
        if libs == 0 and captured == 0:
            return False   # 自杀（除非已提子）
        h = self._board_hash(new_board)
        if h in self.position_hashes:
            return False   # 位置超劫
        return True

    def get_legal_moves(self):
        """返回当前轮所有合法落点。"""
        moves = []
        color = self.turn
        for x in range(self.size):
            for y in range(self.size):
                if self.board[x][y] is None and (x, y) not in self.permanent_holes:
                    if self._is_legal((x, y), color):
                        moves.append((x, y))
        return moves

    # ----------------------- 落子主流程 -----------------------
    def make_move(self, coord):
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        x, y = coord
        if not self._in_bounds(x, y):
            return {'ok': False, 'error': 'out_of_bounds'}
        if (x, y) in self.permanent_holes:
            return {'ok': False, 'error': 'permanent_hole'}
        if self.board[x][y] is not None:
            return {'ok': False, 'error': 'occupied'}
        if not self._is_legal((x, y), self.turn):
            return {'ok': False, 'error': 'illegal'}

        color = self.turn
        opp = 'W' if color == 'B' else 'B'
        self.board[x][y] = color
        captured = []
        for nx, ny in self._neighbors(x, y):
            if self.board[nx][ny] == opp:
                grp, libs = self._group_and_libs(self.board, nx, ny)
                if libs == 0:
                    for gx, gy in grp:
                        if self.board[gx][gy] == opp:   # 仅提普通子，时痕子留存
                            captured.append((gx, gy))
                            self.board[gx][gy] = None
        # 时痕子年龄推进
        self._advance_time_traces()
        # 记录局面
        self._record_position()
        self.consecutive_passes = 0
        # 提子结算：先还债，再累积回溯权
        self._settle_captures(color, len(captured))
        # 记录着法
        self._add_move({
            'type': 'normal', 'coord': (x, y), 'color': color,
            'captured': captured
        })
        # 修复检测（病灶子被提）
        self._check_repair(captured)
        # 破坏性共振
        self._check_resonance()
        # 推进轮次（含债务到期跳过）
        self._advance_turn()
        self._check_end_conditions()
        return {'ok': True, 'captured': captured}

    def _settle_captures(self, color, n):
        """提子先偿还债务，剩余转化为回溯权。"""
        if n <= 0:
            return
        if self.debt[color] > 0:
            repaid = min(self.debt[color], n)
            self.debt[color] -= repaid
            n -= repaid
            if self.debt[color] == 0:
                self.repayment_due[color] = None
        self.rights[color] += n   # 累积回溯权

    # ----------------------- 时痕子生命周期 -----------------------
    def _advance_time_traces(self):
        """推进所有时痕子年龄，处理湮灭。"""
        to_remove = []
        for pos, info in self.time_trace_info.items():
            info['age'] += 1
            if info['age'] > TIME_TRACE_INERT_MAX:
                to_remove.append(pos)   # 湮灭：变空点
        for pos in to_remove:
            x, y = pos
            self.board[x][y] = None
            del self.time_trace_info[pos]

    def _recharge_adjacent(self, x, y):
        """回溯落子相邻 4 格的时痕子重置为稳定。"""
        for nx, ny in self._neighbors(x, y):
            if (nx, ny) in self.time_trace_info:
                self.time_trace_info[(nx, ny)]['age'] = 0

    def _cleanup_traces(self):
        """母着法被锁定后，其绑定的时痕子消散。"""
        for pos in list(self.time_trace_info.keys()):
            mother = self.time_trace_info[pos]['mother']
            if 0 <= mother < len(self.history) and self.history[mother].get('locked'):
                x, y = pos
                if self.board[x][y] in ('TB', 'TW'):
                    self.board[x][y] = None
                del self.time_trace_info[pos]

    # ----------------------- 回溯（时光倒流） -----------------------
    def time_back(self, target_hand_index, coord):
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        color = self.turn
        if target_hand_index < 0 or target_hand_index >= len(self.history):
            return {'ok': False, 'error': 'invalid_target'}
        target_move = self.history[target_hand_index]
        if target_move['color'] != color:
            return {'ok': False, 'error': 'not_your_move'}
        if target_move.get('locked'):
            return {'ok': False, 'error': 'target_locked'}
        if target_move['type'] not in ('normal', 'time_back', 'fork'):
            return {'ok': False, 'error': 'not_backtrackable'}
        x, y = coord
        if not self._in_bounds(x, y) or (x, y) in self.permanent_holes:
            return {'ok': False, 'error': 'invalid_coord'}

        # 回溯权 / 债务结算
        used_debt = False
        if self.rights[color] > 0:
            self.rights[color] -= 1
        else:
            if self.debt[color] >= DEBT_LIMIT:
                return {'ok': False, 'error': 'debt_limit'}
            self.debt[color] += 1
            used_debt = True
            self.repayment_due[color] = self.move_count + DEBT_REPAY_WINDOW

        existing = self.board[x][y]
        own = (self._stone_color(existing) == color)

        if existing is None:
            # 空点 → 放置时痕子
            self._advance_time_traces()
            self.board[x][y] = 'T' + color
            self.time_trace_info[(x, y)] = {
                'color': color, 'age': 0, 'mother': target_hand_index
            }
            self._recharge_adjacent(x, y)
            move_type = 'time_back'
            captured = []
        elif own:
            # 己方子 → 替换为时痕子
            self._advance_time_traces()
            self.board[x][y] = 'T' + color
            self.time_trace_info[(x, y)] = {
                'color': color, 'age': 0, 'mother': target_hand_index
            }
            self._recharge_adjacent(x, y)
            move_type = 'time_back_replace'
            captured = []
        else:
            # 敌方子 → 时间线分叉
            # 退还回溯权/债务（分叉不计回溯权，由分叉流程处理）
            if used_debt:
                self.debt[color] -= 1
                self.repayment_due[color] = None
            else:
                self.rights[color] += 1
            return self._fork_timeline(target_hand_index, coord, color)

        target_move['bound_trace'] = (x, y)
        self._record_position()
        self.consecutive_passes = 0
        self._add_move({
            'type': move_type, 'coord': (x, y), 'color': color,
            'captured': captured, 'target': target_hand_index
        })
        self._check_resonance()
        self._advance_turn()
        self._check_end_conditions()
        return {'ok': True}

    # ----------------------- 时间线分叉与修复 -----------------------
    def _fork_timeline(self, target_hand_index, coord, color):
        """从回溯目标局面分叉新时间线，落子作为普通子；原线冻结。"""
        target_move = self.history[target_hand_index]
        fork_board = [row[:] for row in target_move['board']]
        x, y = coord
        opp = 'W' if color == 'B' else 'B'
        fork_board[x][y] = color
        captured = []
        for nx, ny in self._neighbors(x, y):
            if fork_board[nx][ny] == opp:
                grp, libs = self._group_and_libs(fork_board, nx, ny)
                if libs == 0:
                    for gx, gy in grp:
                        if fork_board[gx][gy] == opp:
                            captured.append((gx, gy))
                            fork_board[gx][gy] = None
        _, libs = self._group_and_libs(fork_board, x, y)
        if libs == 0 and not captured:
            return {'ok': False, 'error': 'suicide_fork'}

        # 冻结原时间线
        self.timelines[self.active_timeline]['frozen'] = True
        new_id = max(self.timelines.keys()) + 1
        self.timelines[new_id] = {
            'moves': [], 'parent': self.active_timeline,
            'fork_point': target_hand_index, 'frozen': False,
            'lesion': (x, y)   # 病灶子位置
        }
        self.active_timeline = new_id
        self.history = self.timelines[new_id]['moves']
        self.board = fork_board
        # 新时间线重置超劫记录
        self.position_hashes = set()
        self._record_position()
        self.consecutive_passes = 0
        self._add_move({
            'type': 'fork', 'coord': (x, y), 'color': color,
            'captured': captured, 'target': target_hand_index, 'lesion': True
        })
        self._check_resonance()
        self._advance_turn()
        self._check_end_conditions()
        return {'ok': True}

    def _check_repair(self, captured):
        """若当前时间线的病灶子被提，触发时间线修复。"""
        tl = self.timelines.get(self.active_timeline)
        if not tl or not tl.get('lesion'):
            return
        if tl['lesion'] not in captured:
            return
        self._do_repair(tl)

    def _do_repair(self, tl):
        """修复：跳回原线，锁定原线 1..分叉点，锁定提子着法，丢弃余下，时痕消散。"""
        parent_id = tl['parent']
        fork_point = tl['fork_point']
        parent_moves = self.timelines[parent_id]['moves']
        # 锁定原线 0..fork_point
        for i in range(min(fork_point + 1, len(parent_moves))):
            parent_moves[i]['locked'] = True
        # 锁定当前提子着法
        if self.history:
            self.history[-1]['locked'] = True
        # 丢弃分叉余下（冻结分叉线）
        tl['frozen'] = True
        tl['lesion'] = None
        # 切回原线
        self.active_timeline = parent_id
        self.history = parent_moves
        # 恢复原线最新局面
        if parent_moves:
            self.board = [row[:] for row in parent_moves[-1]['board']]
        else:
            self.board = [[None] * self.size for _ in range(self.size)]
        # 重建超劫记录
        self.position_hashes = set()
        self._record_position()
        # 时痕子因母着法锁定而消散
        self._cleanup_traces()
        self._check_resonance()

    # ----------------------- 破坏性共振 -----------------------
    def _check_resonance(self):
        """≥3 时痕子共线（横/竖/斜，任意间距）→ 清除该线所有棋子并标记永久空洞。"""
        traces = list(self.time_trace_info.keys())
        if len(traces) < RESONANCE_THRESHOLD:
            return
        rows = defaultdict(list)
        cols = defaultdict(list)
        diags = defaultdict(list)       # x - y 常数
        antidiags = defaultdict(list)   # x + y 常数
        for (x, y) in traces:
            rows[x].append((x, y))
            cols[y].append((x, y))
            diags[x - y].append((x, y))
            antidiags[x + y].append((x, y))
        lines = []
        for x, pts in rows.items():
            if len(pts) >= RESONANCE_THRESHOLD:
                lines.append(('row', x))
        for y, pts in cols.items():
            if len(pts) >= RESONANCE_THRESHOLD:
                lines.append(('col', y))
        for d, pts in diags.items():
            if len(pts) >= RESONANCE_THRESHOLD:
                lines.append(('diag', d))
        for d, pts in antidiags.items():
            if len(pts) >= RESONANCE_THRESHOLD:
                lines.append(('antidiag', d))
        if not lines:
            return

        holes_to_add = set()
        for ltype, val in lines:
            if ltype == 'row':
                for yy in range(self.size):
                    holes_to_add.add((val, yy))
            elif ltype == 'col':
                for xx in range(self.size):
                    holes_to_add.add((xx, val))
            elif ltype == 'diag':
                for xx in range(self.size):
                    yy = xx - val
                    if 0 <= yy < self.size:
                        holes_to_add.add((xx, yy))
            elif ltype == 'antidiag':
                for xx in range(self.size):
                    yy = val - xx
                    if 0 <= yy < self.size:
                        holes_to_add.add((xx, yy))
        # 清除线上所有棋子
        for (x, y) in holes_to_add:
            if self.board[x][y] is not None:
                self.board[x][y] = None
            if (x, y) in self.time_trace_info:
                del self.time_trace_info[(x, y)]
        self.permanent_holes.update(holes_to_add)

    # ----------------------- 着法记录 / 轮次推进 -----------------------
    def _add_move(self, move):
        move['index'] = len(self.history)
        move['board'] = [row[:] for row in self.board]
        move['next_turn'] = 'W' if move['color'] == 'B' else 'B'
        move['locked'] = move.get('locked', False)
        self.history.append(move)
        self.timelines[self.active_timeline]['moves'] = self.history

    def _advance_turn(self):
        """推进手数并切换轮次；处理债务到期跳过（对手连下两手）。"""
        self.move_count += 1
        next_color = 'W' if self.turn == 'B' else 'B'
        # 债务到期：下一手方跳过，对手连下
        if (self.debt[next_color] > 0
                and self.repayment_due[next_color] is not None
                and self.move_count >= self.repayment_due[next_color]):
            self.repayment_due[next_color] = self.move_count + DEBT_RECUR
            # next_color 跳过 → 当前方再下一手
            self.turn = self.turn
            return
        self.turn = next_color

    def _has_backtrackable(self, color):
        for m in self.history:
            if (m['color'] == color and not m.get('locked')
                    and m['type'] in ('normal', 'time_back', 'fork')):
                return True
        return False

    def _check_end_conditions(self):
        """无合法着法且无可回溯节点 → 终局。"""
        if self.game_over:
            return
        legal = self.get_legal_moves()
        if not legal and not self._has_backtrackable(self.turn):
            self._end_game('no_moves')

    # ----------------------- 弃权 / 认输 / 终局 -----------------------
    def pass_turn(self):
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        color = self.turn
        self.consecutive_passes += 1
        # 弃权仍算一手，时痕子年龄推进
        self._advance_time_traces()
        self._add_move({'type': 'pass', 'coord': None, 'color': color, 'captured': []})
        if self.consecutive_passes >= 2:
            # 双方弃权且放弃回溯 → 终局
            self._end_game('both_pass')
            return {'ok': True}
        self._advance_turn()
        self._check_end_conditions()
        return {'ok': True}

    def resign(self):
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        loser = self.turn
        self._end_game('resign', loser=loser)
        return {'ok': True}

    def declare_end(self):
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        self._end_game('declared')
        return {'ok': True}

    def give_up_backtrack(self):
        """显式放弃回溯（满足终局条件）。"""
        if self.game_over:
            return {'ok': False, 'error': 'game_over'}
        self.give_up_backtrack[self.turn] = True
        return {'ok': True}

    def _end_game(self, reason, loser=None):
        self.game_over = True
        self.end_reason = reason
        self.score = self._score()
        if reason == 'resign' and loser:
            self.winner = 'W' if loser == 'B' else 'B'
        else:
            self.winner = 'B' if self.score['B'] > self.score['W'] else 'W'

    # ----------------------- 计分 -----------------------
    def _score(self):
        """数目法：地+子；时痕子=0；纯时痕子包围区=0；扣债务×3；白加贴目。"""
        score = {'B': 0.0, 'W': 0.0}
        # 子数（时痕子计 0）
        for x in range(self.size):
            for y in range(self.size):
                s = self.board[x][y]
                if s in ('B', 'W'):
                    score[s] += 1
        # 空区归属（洪水填充）
        visited = set()
        for x in range(self.size):
            for y in range(self.size):
                if (x, y) in visited:
                    continue
                if self.board[x][y] is not None:
                    continue
                if (x, y) in self.permanent_holes:
                    visited.add((x, y))   # 空洞中立
                    continue
                region = []
                borders = set()
                queue = deque([(x, y)])
                visited.add((x, y))
                while queue:
                    cx, cy = queue.popleft()
                    region.append((cx, cy))
                    for nx, ny in self._neighbors(cx, cy):
                        if (nx, ny) in self.permanent_holes:
                            continue   # 空洞为中立边界
                        if (nx, ny) in visited:
                            continue
                        s = self.board[nx][ny]
                        if s is None:
                            visited.add((nx, ny))
                            queue.append((nx, ny))
                        else:
                            sc = self._stone_color(s)
                            if sc in ('B', 'W'):
                                borders.add(sc)
                            # 时痕子边界不计入归属色（纯时痕子区=0）
                if len(borders) == 1:
                    owner = next(iter(borders))
                    score[owner] += len(region)
                # 否则中立（双活/混合）
        # 扣债务
        score['B'] -= self.debt['B'] * MAX_DEBT_PENALTY
        score['W'] -= self.debt['W'] * MAX_DEBT_PENALTY
        # 贴目
        score['W'] += KOMI
        return score

    # ----------------------- 序列化 -----------------------
    def _board_to_serial(self):
        return [[self.board[x][y] for y in range(self.size)]
                for x in range(self.size)]

    def _move_to_serial(self, m):
        return {
            'index': m.get('index'),
            'type': m.get('type'),
            'color': m.get('color'),
            'coord': list(m['coord']) if m.get('coord') is not None else None,
            'captured': [list(c) for c in m.get('captured', [])],
            'locked': m.get('locked', False),
            'target': m.get('target'),
            'next_turn': m.get('next_turn'),
        }

    def _timelines_to_serial(self):
        out = {}
        for tid, tl in self.timelines.items():
            out[tid] = {
                'parent': tl['parent'],
                'fork_point': tl['fork_point'],
                'frozen': tl['frozen'],
                'lesion': list(tl['lesion']) if tl.get('lesion') else None,
                'move_count': len(tl['moves']),
                'moves': [self._move_to_serial(m) for m in tl['moves']],
            }
        return out

    def serialize(self):
        return {
            'board': self._board_to_serial(),
            'size': self.size,
            'metadata': {
                'turn': self.turn,
                'rights': dict(self.rights),
                'debt': dict(self.debt),
                'repayment_due': dict(self.repayment_due),
                'move_count': self.move_count,
                'game_over': self.game_over,
                'winner': self.winner,
                'end_reason': self.end_reason,
            },
            'history': [self._move_to_serial(m) for m in self.history],
            'timelines': self._timelines_to_serial(),
            'active_timeline': self.active_timeline,
            'permanent_holes': [list(h) for h in self.permanent_holes],
            'time_trace': {
                '%d,%d' % (x, y): dict(info)
                for (x, y), info in self.time_trace_info.items()
            },
            'score': self._score(),
            'komi': KOMI,
        }


# ===========================================================================
# MCTS AI（白方）
# ===========================================================================
def _fast_neighbors(x, y, size):
    res = []
    if x > 0:
        res.append((x - 1, y))
    if x < size - 1:
        res.append((x + 1, y))
    if y > 0:
        res.append((x, y - 1))
    if y < size - 1:
        res.append((x, y + 1))
    return res


def _fast_group_libs(board, x, y, size):
    """快速棋链/气计算（仅普通子，时痕子视为同色普通子）。"""
    color = board[x][y]
    if color is None or color == 'H':
        return set(), 0
    visited = set()
    stack = [(x, y)]
    group = set()
    libs = set()
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in visited:
            continue
        visited.add((cx, cy))
        group.add((cx, cy))
        for nx, ny in _fast_neighbors(cx, cy, size):
            v = board[nx][ny]
            if v is None:
                libs.add((nx, ny))
            elif v == color and (nx, ny) not in visited:
                stack.append((nx, ny))
    return group, len(libs)


def _fast_place(board, x, y, color, size):
    """快速落子（含提子），返回 (合法, 提子数)。"""
    if board[x][y] is not None:
        return False, 0
    board[x][y] = color
    opp = 'W' if color == 'B' else 'B'
    captured = 0
    for nx, ny in _fast_neighbors(x, y, size):
        if board[nx][ny] == opp:
            g, libs = _fast_group_libs(board, nx, ny, size)
            if libs == 0:
                for gx, gy in g:
                    board[gx][gy] = None
                    captured += 1
    _, libs = _fast_group_libs(board, x, y, size)
    if libs == 0 and captured == 0:
        board[x][y] = None
        return False, 0
    return True, captured


def _engine_to_fast(engine):
    """引擎局面转快速棋盘（时痕子视为同色普通子，空洞为 'H'）。"""
    board = [[None] * engine.size for _ in range(engine.size)]
    for x in range(engine.size):
        for y in range(engine.size):
            s = engine.board[x][y]
            if s in ('B', 'W'):
                board[x][y] = s
            elif s in ('TB', 'TW'):
                board[x][y] = s[1]
            if (x, y) in engine.permanent_holes:
                board[x][y] = 'H'
    return board


def _hotspots(engine, target_move):
    """回溯候选热点：目标着法周围 2 步内的空点。"""
    if not target_move.get('coord'):
        return []
    cx, cy = target_move['coord']
    pts = []
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            if abs(dx) + abs(dy) <= 2:
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < engine.size and 0 <= ny < engine.size:
                    if (engine.board[nx][ny] is None
                            and (nx, ny) not in engine.permanent_holes):
                        pts.append((nx, ny))
    random.shuffle(pts)
    return pts[:3]


def generate_candidates(engine, color):
    """候选生成：邻近普通着法 + 自身近 15 手的回溯候选，总量 200–400。"""
    candidates = []
    size = engine.size
    near = set()
    for x in range(size):
        for y in range(size):
            if engine.board[x][y] is not None:
                for dx in range(-2, 3):
                    for dy in range(-2, 3):
                        if abs(dx) + abs(dy) <= 2:
                            nx, ny = x + dx, y + dy
                            if 0 <= nx < size and 0 <= ny < size:
                                near.add((nx, ny))
    for (x, y) in near:
        if engine.board[x][y] is None and (x, y) not in engine.permanent_holes:
            if engine._is_legal((x, y), color):
                candidates.append(('move', (x, y)))
    # 回溯候选
    can_backtrack = engine.rights[color] > 0 or engine.debt[color] < DEBT_LIMIT
    if can_backtrack:
        recent = engine.history[-15:]
        back_cands = []
        for m in recent:
            if (m['color'] == color and not m.get('locked')
                    and m['type'] in ('normal', 'time_back', 'fork')):
                for spot in _hotspots(engine, m):
                    back_cands.append(('time_back', (m['index'], spot)))
        random.shuffle(back_cands)
        candidates.extend(back_cands[:30])
    # 限量 200–400
    if len(candidates) > 400:
        candidates = random.sample(candidates, 400)
    if not candidates:
        candidates.append(('pass', None))
    return candidates


def _territory_fast(board, size):
    """快速地盘归属。"""
    visited = set()
    res = {'B': 0, 'W': 0}
    for x in range(size):
        for y in range(size):
            if (x, y) in visited or board[x][y] is not None:
                continue
            region = []
            borders = set()
            stack = [(x, y)]
            visited.add((x, y))
            while stack:
                cx, cy = stack.pop()
                region.append((cx, cy))
                for nx, ny in _fast_neighbors(cx, cy, size):
                    v = board[nx][ny]
                    if v is None:
                        if (nx, ny) not in visited:
                            visited.add((nx, ny))
                            stack.append((nx, ny))
                    elif v in ('B', 'W'):
                        borders.add(v)
            if len(borders) == 1:
                res[next(iter(borders))] += len(region)
    return res


def _evaluate(board, color, opp, size, engine):
    """手工评估：势力（距离衰减）+ 厚薄 + 时痕 + 资源 + 共振威胁。"""
    val = 0.0
    stones = 0
    for x in range(size):
        for y in range(size):
            v = board[x][y]
            if v == color:
                val += 1.0
                stones += 1
            elif v == opp:
                val -= 1.0
    # 地盘
    terr = _territory_fast(board, size)
    val += (terr[color] - terr[opp]) * 1.0
    # 厚薄：每组气数与眼位近似
    visited = set()
    for x in range(size):
        for y in range(size):
            v = board[x][y]
            if v in ('B', 'W') and (x, y) not in visited:
                g, libs = _fast_group_libs(board, x, y, size)
                visited |= g
                sign = 1.0 if v == color else -1.0
                if libs == 1:
                    val -= sign * 3.0   # 打吃风险
                else:
                    val += sign * min(libs, 6) * 0.3
    # 资源（回溯权 / 债务）
    val += (engine.rights[color] - engine.rights[opp]) * 2.0
    val -= (engine.debt[color] - engine.debt[opp]) * 3.0
    # 时痕子价值（稳定期有价值，失联/将湮灭贬值）
    for pos, info in engine.time_trace_info.items():
        sign = 1.0 if info['color'] == color else -1.0
        age = info['age']
        if age <= TIME_TRACE_STABLE_MAX:
            val += sign * 1.5
        elif age <= TIME_TRACE_INERT_MAX:
            val += sign * 0.3
    # 共振威胁：己方共线时痕子越多越危险（负权）
    traces = [p for p, i in engine.time_trace_info.items() if i['color'] == color]
    if len(traces) >= 2:
        val -= len(traces) * 0.5
    return val


def _rollout_pick(board, color, size):
    """贪心+随机选点（邻近已有棋子）。"""
    empties = []
    for x in range(size):
        for y in range(size):
            if board[x][y] is None:
                for nx, ny in _fast_neighbors(x, y, size):
                    if board[nx][ny] in ('B', 'W'):
                        empties.append((x, y))
                        break
    if not empties:
        return None
    if random.random() < 0.3 and len(empties) > 1:
        best = None
        bestv = -1e9
        sample = empties[:30] if len(empties) > 30 else empties
        for (x, y) in sample:
            b2 = [r[:] for r in board]
            ok, cap = _fast_place(b2, x, y, color, size)
            if not ok:
                continue
            v = cap * 10 + random.random()
            if v > bestv:
                bestv = v
                best = (x, y)
        return best if best else random.choice(empties)
    return random.choice(empties[:50] if len(empties) > 50 else empties)


def _rollout_value(base_board, action, color, opp, size, engine):
    """对候选动作执行快速模拟，返回 sigmoid 化的价值（color 视角）。"""
    board = [r[:] for r in base_board]
    if action[0] == 'move':
        ok, _ = _fast_place(board, action[1][0], action[1][1], color, size)
        if not ok:
            return -1.0
    elif action[0] == 'time_back':
        # 模拟中忽略分叉/修复，时痕子按普通子放置
        tx, ty = action[1][1]
        if board[tx][ty] is None:
            _fast_place(board, tx, ty, color, size)
    # 贪心+随机 rollout
    cur = opp
    for _ in range(6):
        mv = _rollout_pick(board, cur, size)
        if mv is None:
            break
        _fast_place(board, mv[0], mv[1], cur, size)
        cur = 'W' if cur == 'B' else 'B'
    val = _evaluate(board, color, opp, size, engine)
    return 1.0 / (1.0 + math.exp(-val / 20.0))


def ai_select_move(engine):
    """MCTS（UCB1）选择白方着法。800 次模拟，扁平树 + 浅 rollout。"""
    color = engine.turn
    opp = 'W' if color == 'B' else 'B'
    candidates = generate_candidates(engine, color)
    if not candidates or candidates == [('pass', None)]:
        return ('pass', None)
    if len(candidates) > 200:
        candidates = random.sample(candidates, 200)

    base_board = _engine_to_fast(engine)
    SIMS = 800
    n = len(candidates)
    visits = [0] * n
    values = [0.0] * n

    # 初始每候选一次 rollout
    for i, action in enumerate(candidates):
        v = _rollout_value(base_board, action, color, opp, engine.size, engine)
        visits[i] = 1
        values[i] = v

    C = 1.4
    total = n
    for _ in range(max(0, SIMS - n)):
        best_i = 0
        best_ucb = -1e9
        ln_total = math.log(total + 1)
        for i in range(n):
            if visits[i] == 0:
                ucb = 1e9
            else:
                ucb = values[i] / visits[i] + C * math.sqrt(ln_total / visits[i])
            if ucb > best_ucb:
                best_ucb = ucb
                best_i = i
        v = _rollout_value(base_board, candidates[best_i], color, opp, engine.size, engine)
        visits[best_i] += 1
        values[best_i] += v
        total += 1

    # 选均值最高
    best_i = max(range(n), key=lambda i: values[i] / visits[i])
    return candidates[best_i]


# ===========================================================================
# Flask + SocketIO 服务器
# ===========================================================================
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(PARENT_DIR, 'static')

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='/static')
app.config['SECRET_KEY'] = 'timego-secret'
socketio = SocketIO(app, async_mode=ASYNC_MODE, cors_allowed_origins='*')

# 全局唯一对局
engine = TimeGoEngine()
GAME_MODE = {'mode': 'human_vs_ai'}   # 'human_vs_ai' 或 'two_player'


def parse_coord(c):
    """兼容 [x,y] 与 {x,y} 两种坐标格式。"""
    if c is None:
        return None
    if isinstance(c, dict):
        return (int(c['x']), int(c['y']))
    return (int(c[0]), int(c[1]))


def broadcast_state():
    state = engine.serialize()
    state['mode'] = GAME_MODE['mode']
    state['gameOver'] = engine.game_over
    socketio.emit('update_state', state)


def apply_ai_action(action):
    """应用 AI 选定的动作。"""
    if action is None:
        return
    if action[0] == 'pass':
        engine.pass_turn()
    elif action[0] == 'move':
        engine.make_move(action[1])
    elif action[0] == 'time_back':
        target_idx, coord = action[1]
        engine.time_back(target_idx, coord)


def maybe_run_ai():
    """人机模式下若轮到 AI（白），后台执行。"""
    if (GAME_MODE['mode'] == 'human_vs_ai'
            and engine.turn == 'W' and not engine.game_over):
        socketio.start_background_task(ai_turn)


def ai_turn():
    """AI 回合：选择并应用着法后广播。"""
    try:
        action = ai_select_move(engine)
        apply_ai_action(action)
    except Exception as e:
        # 出错则弃权以避免卡死
        try:
            engine.pass_turn()
        except Exception:
            pass
    broadcast_state()


@app.route('/')
def index():
    """提供前端入口 ../index.html。"""
    return send_from_directory(PARENT_DIR, 'index.html')


@app.route('/state')
def state_route():
    return jsonify(engine.serialize())


@app.route('/newgame')
def new_game_route():
    engine.reset()
    return jsonify(engine.serialize())


@socketio.on('connect')
def on_connect():
    state = engine.serialize()
    state['mode'] = GAME_MODE['mode']
    state['gameOver'] = engine.game_over
    emit('update_state', state)


@socketio.on('disconnect')
def on_disconnect():
    pass


@socketio.on('set_mode')
def on_set_mode(data):
    """设置对局模式并重开。"""
    mode = data.get('mode', 'human_vs_ai') if isinstance(data, dict) else 'human_vs_ai'
    GAME_MODE['mode'] = mode if mode in ('human_vs_ai', 'two_player') else 'human_vs_ai'
    engine.reset()
    broadcast_state()


@socketio.on('reset')
def on_reset(data=None):
    engine.reset()
    broadcast_state()


@socketio.on('make_move')
def on_make_move(data):
    coord = parse_coord(data.get('coord'))
    result = engine.make_move(coord)
    if not result.get('ok'):
        emit('error', {'message': result.get('error', 'illegal')})
        broadcast_state()
        return
    broadcast_state()
    maybe_run_ai()


@socketio.on('time_back')
def on_time_back(data):
    target = data.get('target_hand_index')
    coord = parse_coord(data.get('coord'))
    result = engine.time_back(target, coord)
    if not result.get('ok'):
        emit('error', {'message': result.get('error', 'illegal')})
        broadcast_state()
        return
    broadcast_state()
    maybe_run_ai()


@socketio.on('pass_turn')
def on_pass_turn(data=None):
    engine.pass_turn()
    broadcast_state()
    maybe_run_ai()


@socketio.on('resign')
def on_resign(data=None):
    engine.resign()
    broadcast_state()


@socketio.on('declare_end')
def on_declare_end(data=None):
    engine.declare_end()
    broadcast_state()


@socketio.on('give_up_backtrack')
def on_give_up(data=None):
    engine.give_up_backtrack()
    broadcast_state()


if __name__ == '__main__':
    print('TimeGo server running on http://0.0.0.0:5000  (mode=%s)' % ASYNC_MODE)
    socketio.run(app, host='0.0.0.0', port=5000)
