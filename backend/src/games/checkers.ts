import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

type Side = 'r' | 'b';
type Piece = 'r' | 'R' | 'b' | 'B' | null;
export type CheckersState = {
  board: Piece[];
  turn: Side;
  turnPosition: number;
  winnerPosition: number | null;
  draw: boolean;
  forcedFrom: number | null;
  moveCount: number;
  timeoutPosition: number | null;
};
const inside = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8;
const sideOf = (p: Piece): Side | null => p ? p.toLowerCase() as Side : null;
const king = (p: Piece): boolean => p !== null && p === p.toUpperCase();
const index = (x: number, y: number) => y * 8 + x;
const xy = (n: number) => [n % 8, Math.floor(n / 8)] as const;
const directions = (p: Piece): Array<[number, number]> => {
  if (!p) return [];
  if (king(p)) return [[-1,-1],[1,-1],[-1,1],[1,1]];
  return p === 'r' ? [[-1,-1],[1,-1]] : [[-1,1],[1,1]];
};
type Move = { from: number; to: number; captured: number | null };
function movesFor(board: Piece[], from: number): Move[] {
  const piece = board[from];
  if (!piece) return [];
  const [x,y] = xy(from);
  const side = sideOf(piece)!;
  const moves: Move[] = [];
  for (const [dx,dy] of directions(piece)) {
    const nx=x+dx, ny=y+dy;
    if (!inside(nx,ny)) continue;
    const adjacent=index(nx,ny), target=board[adjacent];
    if (target === null) moves.push({from,to:adjacent,captured:null});
    else if (sideOf(target)!==side) {
      const lx=nx+dx, ly=ny+dy;
      if (inside(lx,ly) && board[index(lx,ly)]===null) moves.push({from,to:index(lx,ly),captured:adjacent});
    }
  }
  return moves;
}
function legalMoves(s: CheckersState): Move[] {
  const all: Move[]=[];
  for(let i=0;i<64;i++) if(sideOf(s.board[i])===s.turn) all.push(...movesFor(s.board,i));
  const captures=all.filter(m=>m.captured!==null);
  return captures.length ? captures : all.filter(m=>m.captured===null);
}
function captureMovesFrom(board: Piece[], from: number): Move[] {
  return movesFor(board,from).filter(m=>m.captured!==null);
}
function nextTurn(s: CheckersState, ctx: DriverContext): CheckersState {
  const turn: Side=s.turn==='r'?'b':'r';
  const position=ctx.players.find(p=>p.position!==s.turnPosition)?.position ?? (s.turnPosition===0?1:0);
  const next={...s,turn,turnPosition:position,forcedFrom:null};
  const remaining=next.board.some(p=>sideOf(p)===turn);
  const hasMove=legalMoves(next).length>0;
  if(!remaining||!hasMove) next.winnerPosition=s.turnPosition;
  return next;
}
export const checkersDriver: GameDriver = {
  key:'CHECKERS',
  initialState(ctx:DriverContext):CheckersState {
    const board:Piece[]=Array(64).fill(null);
    for(let y=0;y<3;y++)for(let x=0;x<8;x++)if((x+y)%2===1)board[index(x,y)]='b';
    for(let y=5;y<8;y++)for(let x=0;x<8;x++)if((x+y)%2===1)board[index(x,y)]='r';
    return {board,turn:'r',turnPosition:ctx.players[0]?.position??0,winnerPosition:null,draw:false,forcedFrom:null,moveCount:0,timeoutPosition:null};
  },
  turnOwner(state:unknown,ctx:DriverContext) {
    const s=state as CheckersState;
    if(s.winnerPosition!==null||s.draw||s.timeoutPosition!==null)return null;
    const p=ctx.players.find(x=>x.position===s.turnPosition);
    return {userId:p?.userId??null,seconds:ctx.rules.turnTimeoutSeconds};
  },
  applyAction(state:unknown,ctx:DriverContext,actorId:string,action:GameAction):DriverResult {
    const s=state as CheckersState;
    if(action.type!=='MOVE')return {ok:false,code:'unknown_action',message:'Checkers only accepts MOVE'};
    if(s.winnerPosition!==null||s.draw||s.timeoutPosition!==null)return {ok:false,code:'game_over',message:'This match is already over'};
    const actor=ctx.players.find(p=>p.userId===actorId);
    if(!actor)return {ok:false,code:'not_a_player',message:'Only the two players can move'};
    if(actor.position!==s.turnPosition)return {ok:false,code:'out_of_turn',message:'Wait for your turn'};
    const from=action.payload.from, to=action.payload.to;
    if(typeof from!=='number'||typeof to!=='number'||!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>63||to<0||to>63||from===to)
      return {ok:false,code:'bad_square',message:'Use board indexes from 0 to 63'};
    if(s.forcedFrom!==null&&from!==s.forcedFrom)return {ok:false,code:'must_continue_capture',message:'Continue the multi-jump with the same piece'};
    const available=s.forcedFrom===null?legalMoves(s):captureMovesFrom(s.board,s.forcedFrom);
    const move=available.find(m=>m.from===from&&m.to===to);
    if(!move)return {ok:false,code:'illegal_move',message:'That move is not legal; captures are mandatory'};
    const board=[...s.board],piece=board[from]!;
    board[from]=null;board[to]=piece;if(move.captured!==null)board[move.captured]=null;
    const [,ty]=xy(to),promoted=!king(piece)&&((piece==='r'&&ty===0)||(piece==='b'&&ty===7));
    if(promoted)board[to]=piece==='r'?'R':'B';
    let next:CheckersState={...s,board,moveCount:s.moveCount+1,forcedFrom:null};
    const more=move.captured!==null&&!promoted?captureMovesFrom(board,to):[];
    if(more.length) next.forcedFrom=to;
    else next=nextTurn(next,ctx);
    const events:DriverEvent[]=[{type:'MOVE',actorId,payload:{from,to,captured:move.captured,promoted,multiJump:more.length>0,moveCount:next.moveCount}}];
    if(next.winnerPosition!==null)events.push({type:'WON',actorId:null,payload:{winnerPosition:next.winnerPosition}});
    return {ok:true,state:next,events};
  },
  onTimeout(state:unknown,ctx:DriverContext) {
    const s=state as CheckersState;
    if(s.winnerPosition!==null||s.draw||s.timeoutPosition!==null)return {state:s,events:[]};
    const winner=ctx.players.find(p=>p.position!==s.turnPosition);
    return {state:{...s,winnerPosition:winner?.position??null,timeoutPosition:s.turnPosition},events:[{type:'TIMEOUT',actorId:null,payload:{position:s.turnPosition,winnerPosition:winner?.position??null}}]};
  },
  rankings(state:unknown,ctx:DriverContext):GameStandings {
    const s=state as CheckersState;
    return [...ctx.players].sort((a,b)=>(s.winnerPosition===b.position?1:0)-(s.winnerPosition===a.position?1:0)||a.position-b.position)
      .map(p=>({userId:p.userId,score:s.winnerPosition===p.position?1:0,tieBreakMs:0}));
  },
  isFinished(state:unknown) {const s=state as CheckersState;return s.winnerPosition!==null||s.draw||s.timeoutPosition!==null;},
};
