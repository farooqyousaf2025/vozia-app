import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

type Color = 'w' | 'b';
type Piece = string | null;
export type ChessState = {
  board: Piece[]; turn: Color; turnPosition: number; winnerPosition: number | null;
  draw: boolean; check: boolean; checkmate: boolean; stalemate: boolean;
  castling: string; enPassant: number | null; halfmove: number; fullmove: number;
  moveCount: number; timeoutPosition: number | null; lastMove: { from: number; to: number; san: string } | null;
};
const START = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';
const FILES = 'abcdefgh';
const inside = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
const color = (p: Piece): Color | null => p ? (p === p.toUpperCase() ? 'w' : 'b') : null;
const pos = (f: number, r: number) => r * 8 + f;
const algebraic = (n: number) => FILES[n % 8] + String(8 - Math.floor(n / 8));
function attacked(board: Piece[], sq: number, by: Color): boolean {
  const f=sq%8, r=Math.floor(sq/8), pawn=by==='w'?-1:1, pr=r-pawn;
  for (const df of [-1,1]) if (inside(f+df,pr) && board[pos(f+df,pr)] === (by==='w'?'P':'p')) return true;
  for (const [df,dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    if (inside(f+df,r+dr) && board[pos(f+df,r+dr)] === (by==='w'?'N':'n')) return true;
  }
  for (const [df,dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let x=f+df,y=r+dr,d=1;
    while(inside(x,y)) { const p=board[pos(x,y)]; if(p){ if(color(p)===by && (p.toLowerCase()==='q' || (d===1 && p.toLowerCase()==='k') || (d>0 && ((df===0||dr===0)?p.toLowerCase()==='r':p.toLowerCase()==='b'))) ) return true; break; } x+=df;y+=dr;d++; }
  }
  return false;
}
function kingSquare(board: Piece[], side: Color): number { return board.findIndex(p => p === (side==='w'?'K':'k')); }
function inCheck(board: Piece[], side: Color): boolean { const k=kingSquare(board,side); return k<0 || attacked(board,k,side==='w'?'b':'w'); }
function pseudo(s: ChessState, from: number): number[] {
  const p=s.board[from]; if(!p) return []; const side=color(p)!, f=from%8,r=Math.floor(from/8), kind=p.toLowerCase(), out:number[]=[];
  const add=(x:number,y:number)=>{if(inside(x,y)){const t=s.board[pos(x,y)];if((!t||color(t)!==side)&&t?.toLowerCase()!=='k')out.push(pos(x,y));}};
  if(kind==='p'){
    const d=side==='w'?-1:1, start=side==='w'?6:1;
    if(inside(f,r+d)&&!s.board[pos(f,r+d)]){out.push(pos(f,r+d));if(r===start&&!s.board[pos(f,r+2*d)])out.push(pos(f,r+2*d));}
    for(const df of [-1,1]) if(inside(f+df,r+d)){const to=pos(f+df,r+d);if((s.board[to]&&color(s.board[to])!==side)||s.enPassant===to)out.push(to);}
  } else if(kind==='n'){for(const [df,dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]])add(f+df,r+dr);}
  else {
    const dirs=kind==='b'?[[1,1],[1,-1],[-1,1],[-1,-1]]:kind==='r'?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    for(const [df,dr] of dirs){let x=f+df,y=r+dr;while(inside(x,y)){const to=pos(x,y),t=s.board[to];if(!t)out.push(to);else{if(color(t)!==side&&t.toLowerCase()!=='k')out.push(to);break;}if(kind==='k')break;x+=df;y+=dr;}}
    if(kind==='k'&&r===(side==='w'?7:0)&&f===4&&!inCheck(s.board,side)){
      const rank=side==='w'?7:0, enemy=side==='w'?'b':'w';
      if(s.castling.includes(side==='w'?'K':'k')&&!s.board[pos(5,rank)]&&!s.board[pos(6,rank)]&&s.board[pos(7,rank)]===(side==='w'?'R':'r')&&!attacked(s.board,pos(5,rank),enemy)&&!attacked(s.board,pos(6,rank),enemy))out.push(pos(6,rank));
      if(s.castling.includes(side==='w'?'Q':'q')&&!s.board[pos(1,rank)]&&!s.board[pos(2,rank)]&&!s.board[pos(3,rank)]&&s.board[pos(0,rank)]===(side==='w'?'R':'r')&&!attacked(s.board,pos(3,rank),enemy)&&!attacked(s.board,pos(2,rank),enemy))out.push(pos(2,rank));
    }
  }
  return out;
}
function apply(s:ChessState,from:number,to:number,promotion:string):ChessState{
  const board=[...s.board], piece=board[from]!, side=color(piece)!, kind=piece.toLowerCase(), captured=board[to];
  board[to]=piece;board[from]=null;
  if(kind==='p'&&to===s.enPassant&&from%8!==to%8)board[to+(side==='w'?8:-8)]=null;
  if(kind==='k'&&Math.abs(to-from)===2){const rank=Math.floor(from/8);if(to%8===6){board[pos(5,rank)]=board[pos(7,rank)];board[pos(7,rank)]=null;}else{board[pos(3,rank)]=board[pos(0,rank)];board[pos(0,rank)]=null;}}
  if(kind==='p'&&(Math.floor(to/8)===0||Math.floor(to/8)===7)){const pr=(promotion||'q').toLowerCase();board[to]=side==='w'?pr.toUpperCase():pr;}
  let castling=s.castling;
  if(kind==='k')castling=castling.replace(side==='w'?/[KQ]/g:/[kq]/g,'');
  if(from===63||to===63)castling=castling.replace('K','');if(from===56||to===56)castling=castling.replace('Q','');
  if(from===7||to===7)castling=castling.replace('k','');if(from===0||to===0)castling=castling.replace('q','');
  return {...s,board,turn:side==='w'?'b':'w',castling:castling||'-',enPassant:kind==='p'&&Math.abs(to-from)===16?(from+to)/2:null,halfmove:kind==='p'||captured?0:s.halfmove+1,fullmove:s.fullmove+(side==='b'?1:0),moveCount:s.moveCount+1,lastMove:{from,to,san:algebraic(from)+'-'+algebraic(to)}};
}
function legal(s:ChessState,from:number,to:number,promotion:string):boolean{
 const p=s.board[from];if(!p||color(p)!==s.turn||s.board[to]?.toLowerCase()==='k'||!pseudo(s,from).includes(to))return false;
 if(!['q','r','b','n'].includes((promotion||'q').toLowerCase()))return false;
 if(p.toLowerCase()==='p'&&(Math.floor(to/8)===0||Math.floor(to/8)===7)&&!['q','r','b','n'].includes((promotion||'q').toLowerCase()))return false;
 return !inCheck(apply(s,from,to,promotion).board,s.turn);
}
function legalMoves(s:ChessState):Array<[number,number]>{const a:Array<[number,number]>=[];for(let i=0;i<64;i++)if(color(s.board[i])===s.turn)for(const to of pseudo(s,i))if(legal(s,i,to,'q'))a.push([i,to]);return a;}
function finish(s:ChessState,ctx:DriverContext):ChessState{
 const check=inCheck(s.board,s.turn), moves=legalMoves(s), mate=check&&moves.length===0, stale=!check&&moves.length===0;
 if(mate){const winner=ctx.players.find(p=>p.position!==s.turnPosition);return {...s,check:true,checkmate:true,winnerPosition:winner?.position??null};}
 if(stale||s.halfmove>=100)return {...s,check,stalemate:stale,draw:true};
 return {...s,check};
}
export const chessDriver:GameDriver={
 key:'CHESS',
 initialState(ctx:DriverContext):ChessState{return {board:START.split('').map(piece => piece === '.' ? null : piece),turn:'w',turnPosition:ctx.players[0]?.position??0,winnerPosition:null,draw:false,check:false,checkmate:false,stalemate:false,castling:'KQkq',enPassant:null,halfmove:0,fullmove:1,moveCount:0,timeoutPosition:null,lastMove:null};},
 turnOwner(state:unknown,ctx:DriverContext){const s=state as ChessState;if(s.winnerPosition!==null||s.draw)return null;const p=ctx.players.find(x=>x.position===s.turnPosition);return {userId:p?.userId??null,seconds:ctx.rules.turnTimeoutSeconds};},
 applyAction(state:unknown,ctx:DriverContext,actorId:string,action:GameAction):DriverResult{
  const s=state as ChessState;if(action.type!=='MOVE')return {ok:false,code:'unknown_action',message:'Chess only accepts MOVE'};
  if(s.winnerPosition!==null||s.draw)return {ok:false,code:'game_over',message:'This game is already over'};
  const actor=ctx.players.find(p=>p.userId===actorId);if(!actor)return {ok:false,code:'not_a_player',message:'Only the two players can move'};
  if(actor.position!==s.turnPosition)return {ok:false,code:'out_of_turn',message:'Wait for your turn'};
  const parseSquare=(v:unknown):number=>typeof v==='number'?v:typeof v==='string'&&/^[a-h][1-8]$/.test(v)?FILES.indexOf(v[0])+(8-Number(v[1]))*8:NaN;
  const from=parseSquare(action.payload.from),to=parseSquare(action.payload.to);
  const promotion=typeof action.payload.promotion==='string'?action.payload.promotion:'q';
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>63||to<0||to>63||from===to)return {ok:false,code:'bad_square',message:'Use valid chess squares such as e2 and e4'};
  if(!legal(s,from,to,promotion))return {ok:false,code:'illegal_move',message:'That move is not legal in the current position'};
  const nextBase=apply(s,from,to,promotion);
  nextBase.turnPosition=nextBase.turn==='w'?(ctx.players[0]?.position??0):(ctx.players[1]?.position??1);
  const next=finish(nextBase,ctx);
  const stateOut=next;
  const events:DriverEvent[]=[{type:'MOVE',actorId,payload:{from:algebraic(from),to:algebraic(to),promotion,position:actor.position,check:next.check,checkmate:next.checkmate,stalemate:next.stalemate}}];
  if(next.checkmate)events.push({type:'WON',actorId:null,payload:{winnerPosition:next.winnerPosition}});
  if(next.draw)events.push({type:'DRAW',actorId:null,payload:{reason:next.stalemate?'stalemate':'fifty_move_rule'}});
  return {ok:true,state:stateOut,events};
 },
 onTimeout(state:unknown,ctx:DriverContext){const s=state as ChessState;if(s.winnerPosition!==null||s.draw)return {state:s,events:[]};const winner=ctx.players.find(p=>p.position!==s.turnPosition);return {state:{...s,winnerPosition:winner?.position??null,timeoutPosition:s.turnPosition},events:[{type:'TIMEOUT',actorId:null,payload:{position:s.turnPosition,winnerPosition:winner?.position??null}}]};},
 rankings(state:unknown,ctx:DriverContext):GameStandings{const s=state as ChessState;return [...ctx.players].sort((a,b)=>(s.winnerPosition===b.position?1:0)-(s.winnerPosition===a.position?1:0)||a.position-b.position).map(p=>({userId:p.userId,score:s.winnerPosition===p.position?1:0,tieBreakMs:0}));},
 isFinished(state:unknown){const s=state as ChessState;return s.winnerPosition!==null||s.draw||s.timeoutPosition!==null;},
};
