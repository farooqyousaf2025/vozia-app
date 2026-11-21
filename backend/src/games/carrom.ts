import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

type Coin = { id: number; owner: number | null; kind: 'coin' | 'queen'; x: number; y: number; vx: number; vy: number; pocketed: boolean };
export type CarromState = {
  coins: Coin[];
  striker: { x: number; y: number; vx: number; vy: number; pocketed: boolean };
  turnPosition: number;
  scores: Record<string, number>;
  pocketedBy: Record<string, number[]>;
  queenPendingFor: number | null;
  queenCovered: boolean;
  winnerPosition: number | null;
  draw: boolean;
  foulCount: Record<string, number>;
  shotCount: number;
  timeoutPosition: number | null;
};
const CENTER = 500;
const POCKETS = [[110,110],[890,110],[110,890],[890,890]] as const;
const RADIUS = 18;
const STRIKER_RADIUS = 23;
const distance2 = (a:{x:number;y:number},b:{x:number;y:number}) => (a.x-b.x)**2+(a.y-b.y)**2;
function makeCoins(players: DriverContext['players']): Coin[] {
  const coins: Coin[] = [];
  // Six inner and twelve outer coins form a symmetric, non-overlapping rack.
  // Ownership alternates around the rack so both colors are represented on both rings.
  for (let i=0;i<18;i++) {
    const inner = i < 6;
    const ringIndex = inner ? i : i - 6;
    const count = inner ? 6 : 12;
    const angle = (Math.PI*2*ringIndex)/count + (inner ? 0 : Math.PI/12);
    const ring = inner ? 40 : 80;
    coins.push({
      id:i, owner:players[i%2]?.position??(i%2), kind:'coin',
      x:CENTER+Math.cos(angle)*ring, y:CENTER+Math.sin(angle)*ring,
      vx:0,vy:0,pocketed:false,
    });
  }
  coins.push({id:18,owner:null,kind:'queen',x:CENTER,y:CENTER,vx:0,vy:0,pocketed:false});
  return coins;
}
function simulate(coinsIn:Coin[], strikerIn:CarromState['striker']): {coins:Coin[];striker:CarromState['striker'];pocketed:number[];strikerPocketed:boolean} {
  const coins=coinsIn.map(c=>({...c})), striker={...strikerIn}, pocketed:number[]=[];
  const bodies=[...coins.filter(c=>!c.pocketed),striker];
  const isStriker=(b:Coin|CarromState['striker']):boolean=>b===striker;
  // Fixed-step, bounded server simulation. Clients submit aim/power, never positions or outcomes.
  for(let step=0;step<2400;step++){
    for(const b of bodies){
      if(b.pocketed)continue;
      b.x+=b.vx/120;b.y+=b.vy/120;
      b.vx*=0.996;b.vy*=0.996;
      if(Math.abs(b.vx)+Math.abs(b.vy)<1.4){b.vx=0;b.vy=0;}
      if(POCKETS.some(([x,y])=>distance2(b,{x,y})<54**2)){
        b.pocketed=true;b.vx=0;b.vy=0;
        if('id' in b)pocketed.push(b.id);
        continue;
      }
      const radius=isStriker(b)?STRIKER_RADIUS:RADIUS;
      if(b.x<110+radius){b.x=110+radius;b.vx=Math.abs(b.vx)*0.82;}
      if(b.x>890-radius){b.x=890-radius;b.vx=-Math.abs(b.vx)*0.82;}
      if(b.y<110+radius){b.y=110+radius;b.vy=Math.abs(b.vy)*0.82;}
      if(b.y>890-radius){b.y=890-radius;b.vy=-Math.abs(b.vy)*0.82;}
    }
    const active=bodies.filter(b=>!b.pocketed);
    for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
      const a=active[i],b=active[j],ra=isStriker(a)?STRIKER_RADIUS:RADIUS,rb=isStriker(b)?STRIKER_RADIUS:RADIUS;
      let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||0.001,min=ra+rb;
      if(d>=min)continue;
      const nx=dx/d,ny=dy/d,overlap=min-d;
      a.x-=nx*overlap/2;a.y-=ny*overlap/2;b.x+=nx*overlap/2;b.y+=ny*overlap/2;
      const av=a.vx*nx+a.vy*ny,bv=b.vx*nx+b.vy*ny,impulse=(bv-av)*0.94;
      a.vx+=impulse*nx;a.vy+=impulse*ny;b.vx-=impulse*nx;b.vy-=impulse*ny;
    }
    if(bodies.every(b=>b.pocketed||(b.vx===0&&b.vy===0)))break;
  }
  return {coins,striker,pocketed,strikerPocketed:striker.pocketed};
}
function activeRegular(coins:Coin[]){return coins.filter(c=>c.kind==='coin'&&!c.pocketed).length;}
function scoreFor(state:CarromState,seat:number){return Number(state.scores[String(seat)]??0);}
export const carromDriver:GameDriver={
 key:'CARROM',
 initialState(ctx:DriverContext):CarromState{
  const seats=ctx.players.map(p=>String(p.position));
  return {coins:makeCoins(ctx.players),striker:{x:CENTER,y:840,vx:0,vy:0,pocketed:false},turnPosition:ctx.players[0]?.position??0,scores:Object.fromEntries(seats.map(s=>[s,0])),pocketedBy:Object.fromEntries(seats.map(s=>[s,[]])),queenPendingFor:null,queenCovered:false,winnerPosition:null,draw:false,foulCount:Object.fromEntries(seats.map(s=>[s,0])),shotCount:0,timeoutPosition:null};
 },
 turnOwner(state:unknown,ctx:DriverContext){const s=state as CarromState;if(s.winnerPosition!==null||s.draw)return null;const p=ctx.players.find(x=>x.position===s.turnPosition);return {userId:p?.userId??null,seconds:ctx.rules.turnTimeoutSeconds};},
 applyAction(state:unknown,ctx:DriverContext,actorId:string,action:GameAction):DriverResult{
  const s=state as CarromState;
  if(action.type!=='SHOT')return {ok:false,code:'unknown_action',message:'Carrom accepts SHOT actions'};
  if(s.winnerPosition!==null||s.draw||s.timeoutPosition!==null)return {ok:false,code:'game_over',message:'This match is already over'};
  const actor=ctx.players.find(p=>p.userId===actorId);
  if(!actor)return {ok:false,code:'not_a_player',message:'Only the two seated players can shoot'};
  if(actor.position!==s.turnPosition)return {ok:false,code:'out_of_turn',message:'Wait for your turn'};
  const angle=action.payload.angle,power=action.payload.power,strikerX=action.payload.strikerX??CENTER;
  if(typeof angle!=='number'||!Number.isFinite(angle)||angle < -180||angle>180||typeof power!=='number'||!Number.isFinite(power)||power<0.12||power>1||typeof strikerX!=='number'||!Number.isFinite(strikerX)||strikerX<260||strikerX>740)
    return {ok:false,code:'bad_shot',message:'Aim must be -180..180°, power 0.12..1 and strikerX 260..740'};
  const seatIndex=ctx.players.findIndex(p=>p.position===actor.position);
  const baselineY=seatIndex===0?840:160;
  const radians=angle*Math.PI/180;
  const coins=s.coins.map(c=>({...c}));
  let queenPendingFor=s.queenPendingFor;
  let queenCovered=s.queenCovered;
  if(queenPendingFor!==null&&queenPendingFor!==actor.position){
    const queen=coins.find(c=>c.kind==='queen')!;queen.pocketed=false;queen.x=CENTER;queen.y=CENTER;queen.vx=0;queen.vy=0;queenPendingFor=null;
  }
  const sim=simulate(coins,{x:strikerX,y:baselineY,vx:Math.cos(radians)*power*3600,vy:Math.sin(radians)*power*3600*(seatIndex===0?-1:1),pocketed:false});
  const events:DriverEvent[]=[];
  const scores={...s.scores},pocketedBy={...s.pocketedBy},foulCount={...s.foulCount};
  const newlyPocketed=sim.pocketed.map(id=>sim.coins.find(c=>c.id===id)!).filter(Boolean);
  const own=newlyPocketed.filter(c=>c.kind==='coin'&&c.owner===actor.position);
  const foul=sim.strikerPocketed;
  if(foul){
    foulCount[String(actor.position)]=(foulCount[String(actor.position)]??0)+1;
    // A foul cancels every coin pocketed during this shot; restore exact rack positions.
    for(const c of newlyPocketed){
      const original=coins.find(item=>item.id===c.id);
      if(original){c.pocketed=false;c.x=original.x;c.y=original.y;c.vx=0;c.vy=0;}
    }
    if(queenPendingFor===actor.position){
      const queen=sim.coins.find(item=>item.kind==='queen')!;
      queen.pocketed=false;queen.x=CENTER;queen.y=CENTER;queen.vx=0;queen.vy=0;
    }
    queenPendingFor=null;
    events.push({type:'FOUL',actorId,payload:{reason:'striker_pocketed'}});
  }else{
    const queen=sim.coins.find(c=>c.kind==='queen')!;
    if(queenPendingFor===actor.position){
      if(own.length>0){
        queenCovered=true;queenPendingFor=null;
        scores[String(actor.position)]=(scores[String(actor.position)]??0)+3;
      }else{
        // The queen must be covered on the same player's next shot, not on the queen shot.
        queen.pocketed=false;queen.x=CENTER;queen.y=CENTER;queenPendingFor=null;
      }
    }else if(queen.pocketed&&!queenCovered){
      // Even when a regular coin falls in the queen shot, cover is the following shot.
      queenPendingFor=actor.position;
    }
    for(const c of newlyPocketed.filter(item=>item.kind==='coin')){
      const scoringSeat=c.owner??actor.position;scores[String(scoringSeat)]=(scores[String(scoringSeat)]??0)+1;
      pocketedBy[String(scoringSeat)]=[...(pocketedBy[String(scoringSeat)]??[]),c.id];
    }
  }
  const remaining=activeRegular(sim.coins);
  let winnerPosition:number|null=null,draw=false;
  if(remaining===0&&queenPendingFor===null){const a=scoreFor({...s,scores},ctx.players[0].position),b=scoreFor({...s,scores},ctx.players[1].position);winnerPosition=a===b?null:a>b?ctx.players[0].position:ctx.players[1].position;draw=a===b;}
  const retain=!foul&&own.length>0&&!draw&&winnerPosition===null;
  const next=ctx.players.find(p=>p.position!==actor.position)?.position??actor.position;
  const nextState:CarromState={...s,coins:sim.coins,striker:{x:strikerX,y:baselineY,vx:0,vy:0,pocketed:false},turnPosition:retain?actor.position:next,scores,pocketedBy,queenPendingFor,queenCovered,winnerPosition,draw,foulCount,shotCount:s.shotCount+1};
  events.unshift({type:'SHOT',actorId,payload:{angle,power,strikerX,seat:actor.position,pocketed:sim.pocketed,strikerPocketed:foul,retainedTurn:retain,scores}});
  if(winnerPosition!==null)events.push({type:'WON',actorId:null,payload:{winnerPosition}});
  if(draw)events.push({type:'DRAW',actorId:null,payload:{reason:'equal_score'}});
  return {ok:true,state:nextState,events};
 },
 onTimeout(state:unknown,ctx:DriverContext){const s=state as CarromState;if(s.winnerPosition!==null||s.draw)return {state:s,events:[]};const winner=ctx.players.find(p=>p.position!==s.turnPosition);return {state:{...s,winnerPosition:winner?.position??null,timeoutPosition:s.turnPosition},events:[{type:'TIMEOUT',actorId:null,payload:{position:s.turnPosition,winnerPosition:winner?.position??null}}]};},
 rankings(state:unknown,ctx:DriverContext):GameStandings{const s=state as CarromState;return [...ctx.players].sort((a,b)=>scoreFor(s,b.position)-scoreFor(s,a.position)||a.position-b.position).map(p=>({userId:p.userId,score:scoreFor(s,p.position),tieBreakMs:0}));},
 isFinished(state:unknown){const s=state as CarromState;return s.winnerPosition!==null||s.draw||s.timeoutPosition!==null;},
};
