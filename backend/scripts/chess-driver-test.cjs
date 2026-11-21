const assert = require('node:assert/strict');
const { chessDriver, chessLegalMovesForDiagnostics } = require('../dist/games/chess.js');

const ctx = {
  sessionId: 'chess-test', roomId: null, nowMs: Date.now(),
  rules: { turnTimeoutSeconds: 60 },
  players: [{ userId: 'white', position: 0 }, { userId: 'black', position: 1 }],
};
let state = chessDriver.initialState(ctx);
const move = (actorId, from, to) => {
  const result = chessDriver.applyAction(state, ctx, actorId, { type: 'MOVE', payload: { from, to } });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  state = result.state;
};
const reject = (actorId, from, to, code) => {
  const result = chessDriver.applyAction(state, ctx, actorId, { type: 'MOVE', payload: { from, to } });
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
};

assert.equal(state.board.length, 64);
assert.equal(state.board[60], 'K');
reject('white', 'e2', 'e5', 'illegal_move');
reject('white', 'z1', 'e4', 'bad_square');
reject('black', 'e7', 'e5', 'out_of_turn');

// Fool's Mate: the shortest ordinary checkmate, also proves turn ownership flips.
move('white', 'f2', 'f3');
move('black', 'e7', 'e5');
move('white', 'g2', 'g4');
move('black', 'd8', 'h4');
assert.equal(state.check, true);
console.log('CHESS_DIAGNOSTIC', JSON.stringify({turn:state.turn, board:state.board, legalMoves:chessLegalMovesForDiagnostics(state)}));
assert.equal(state.checkmate, true);
assert.equal(state.winnerPosition, 1);
assert.equal(chessDriver.isFinished(state, ctx), true);
reject('white', 'e2', 'e4', 'game_over');

console.log('PASS  chess: opening position, malformed/out-of-turn/illegal move rejection, Fool\'s Mate and terminal lock');
