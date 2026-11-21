const assert = require('node:assert/strict');
const { checkersDriver } = require('../dist/games/checkers.js');
const ctx = {
  sessionId: 'checkers-test', roomId: null, nowMs: Date.now(),
  rules: { turnTimeoutSeconds: 60 },
  players: [{ userId: 'red', position: 0 }, { userId: 'black', position: 1 }],
};
const initial = checkersDriver.initialState(ctx);
assert.equal(initial.board.length, 64);
assert.equal(initial.board.filter(Boolean).length, 24);
assert.equal(initial.board[40], 'r');
assert.equal(initial.board[17], 'b');
let result = checkersDriver.applyAction(initial, ctx, 'black', { type: 'MOVE', payload: { from: 40, to: 33 } });
assert.equal(result.ok, false);
assert.equal(result.code, 'out_of_turn');
result = checkersDriver.applyAction(initial, ctx, 'red', { type: 'MOVE', payload: { from: 40, to: 24 } });
assert.equal(result.ok, false);
assert.equal(result.code, 'illegal_move');
result = checkersDriver.applyAction(initial, ctx, 'red', { type: 'MOVE', payload: { from: 40, to: 33 } });
assert.equal(result.ok, true);
assert.equal(result.state.turn, 'b');

// A mandatory two-jump capture; the same piece must complete the sequence.
let chain = { ...initial, board: Array(64).fill(null), board: initial.board.map(() => null) };
chain.board[42] = 'r';
chain.board[35] = 'b';
chain.board[21] = 'b';
result = checkersDriver.applyAction(chain, ctx, 'red', { type: 'MOVE', payload: { from: 42, to: 28 } });
assert.equal(result.ok, true);
assert.equal(result.state.forcedFrom, 28);
assert.equal(result.state.board[35], null);
let blocked = checkersDriver.applyAction(result.state, ctx, 'red', { type: 'MOVE', payload: { from: 42, to: 28 } });
assert.equal(blocked.ok, false);
assert.equal(blocked.code, 'must_continue_capture');
result = checkersDriver.applyAction(result.state, ctx, 'red', { type: 'MOVE', payload: { from: 28, to: 14 } });
assert.equal(result.ok, true);
assert.equal(result.state.board[21], null);
assert.equal(result.state.winnerPosition, 0);
assert.equal(checkersDriver.isFinished(result.state, ctx), true);

// Promotion to king at the far rank.
let promotion = { ...initial, board: Array(64).fill(null), turn: 'r', turnPosition: 0, winnerPosition: null, forcedFrom: null };
promotion.board[10] = 'r';
promotion.board[63] = 'b';
result = checkersDriver.applyAction(promotion, ctx, 'red', { type: 'MOVE', payload: { from: 10, to: 1 } });
assert.equal(result.ok, true);
assert.equal(result.state.board[1], 'R');
console.log('PASS  checkers: opening setup, turn ownership, illegal moves, mandatory multi-jump, capture completion, king promotion and terminal state');
