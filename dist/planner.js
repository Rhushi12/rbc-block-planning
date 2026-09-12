import {validateBlock,requiredMinutes,sequence} from './safety.js';
import {trainLegs,sections,lines,dept,deptLabel,sectionName,priorityOf,band,
        horizonDates,addDays,daysBetween,overdueOf,spanOverlap,corridorWindows,
        DAY_START,DAY_END,BUFFER} from './data.js';

// Objective. On a corridor this dense the scarce good is robustness: a window
// with two minutes of clearance collapses the moment a train runs late.
// Regulating a train is the real cost of a corridor block, so it is priced well
// above any scheduling convenience: a natural gap always beats a granted window.
export const WEIGHTS={headroom:1,headroomCap:45,earliness:0.01,deviation:1,trainRegulated:15};

export const REASONS={
 TRAIN:'Train movements and their safety margin leave no window long enough on this running line.',
 DEPARTMENT:'The department is not on duty long enough on any day in this horizon.',
 CREW:'Every crew for this department is already committed whenever a window exists.',
 RESOURCE:'The machinery this work needs is committed elsewhere in every usable window.',
 BLOCK:'Approved blocks already occupy this section whenever a window exists.',
 DURATION:'Setup, work and clearance do not fit inside the planning day.',
 LINE:'The work cannot share a block with the line it was grouped against.',
 TIME:'The work does not fit inside the planning day.',
 SECTION:'Tasks must be on the same section to share a block.',
 TASK:'The task is no longer available for planning.',
};

// ---- traffic index --------------------------------------------------------
// 1,044 legs across the corridor; a block only cares about its own section and
// line, so index once per timetable rather than walking all of them per candidate.
const indexCache=new WeakMap();
export function legIndex(trains){
 let idx=indexCache.get(trains);
 if(!idx){
  idx=new Map();
  for(const t of trains)for(const leg of trainLegs(t)){
   const k=`${leg.section}|${leg.line}`;
   if(!idx.has(k))idx.set(k,[]);
   idx.get(k).push(leg);
  }
  for(const list of idx.values())list.sort((a,b)=>a.start-b.start);
  indexCache.set(trains,idx);
 }
 return idx;
}
const legsFor=(state,sectionId,line)=>{
 const idx=legIndex(state.trains);
 return line===null
  ? [...(idx.get(`${sectionId}|UP`)||[]),...(idx.get(`${sectionId}|DN`)||[])]
  : (idx.get(`${sectionId}|${line}`)||[]);
};

const mergeSpans=spans=>{
 spans.sort((a,b)=>a[0]-b[0]);
 const out=[];
 for(const [a,b] of spans){
  if(out.length&&a<=out[out.length-1][1])out[out.length-1][1]=Math.max(out[out.length-1][1],b);
  else out.push([a,b]);
 }
 return out;
};

// Windows on one running line where no train and no approved block sits.
export function freeIntervals(state,sectionId,line,date,lo=DAY_START,hi=DAY_END){
 const busy=legsFor(state,sectionId,line).map(l=>[l.start-BUFFER,l.end+BUFFER]);
 for(const b of state.blocks){
  if(b.date!==date||b.section!==sectionId)continue;
  if(line!==null&&b.line!==null&&b.line!==line)continue;
  busy.push([b.start,b.end]);
 }
 const free=[];let prev=lo;
 for(const [a,b] of mergeSpans(busy)){
  if(b<=lo)continue;
  if(a>=hi)break;
  if(a>prev)free.push([prev,Math.min(a,hi)]);
  prev=Math.max(prev,b);
  if(prev>=hi)break;
 }
 if(prev<hi)free.push([prev,hi]);
 return free.filter(([a,b])=>b>a);
}

// Trains that must be cancelled, diverted or rescheduled to grant this block.
export function trainsAffected(block,state){
 const hit=new Set();
 for(const t of state.trains)for(const leg of trainLegs(t)){
  if(leg.section!==block.section)continue;
  if(block.line!==null&&leg.line!==block.line)continue;
  if(spanOverlap(block.start,block.end,leg.start,leg.end))hit.add(t.id);
 }
 return hit.size;
}

export function headroom(block,state){
 let min=Infinity;
 for(const leg of legsFor(state,block.section,block.line)){
  min=Math.min(min,block.end<=leg.start-BUFFER
   ?(leg.start-BUFFER)-block.end
   :block.start-(leg.end+BUFFER));
 }
 return Math.max(0,Math.min(min===Infinity?WEIGHTS.headroomCap:min,WEIGHTS.headroomCap));
}

function scoreOf(block,state,lo,preferred){
 const regulated=block.corridor?trainsAffected(block,state):0;
 const clearance=block.corridor?0:headroom(block,state);
 let v=Math.min(clearance,WEIGHTS.headroomCap)*WEIGHTS.headroom
      -(block.start-lo)*WEIGHTS.earliness
      -regulated*WEIGHTS.trainRegulated;
 if(Number.isInteger(preferred))v-=Math.abs(block.start-preferred)*WEIGHTS.deviation;
 return {value:v,headroom:clearance,trainsRegulated:regulated};
}

// ---- placement ------------------------------------------------------------
// The score is piecewise linear inside a free interval, so the optimum sits at
// an interval edge, the midpoint, or a constraint boundary. Four candidates per
// interval replaces scanning the whole day minute by minute.
export function search(taskIds,state,date,preferred){
 const tasks=taskIds.map(id=>state.requests.find(r=>r.id===id));
 if(!tasks.length||tasks.some(t=>!t))return {block:null,codes:{TASK:1}};
 const codes={};
 const bump=v=>{for(const e of v.errors)codes[e.code]=(codes[e.code]||0)+1;};

 const duration=requiredMinutes(tasks);
 const line=tasks.some(t=>t.line===null)?null:tasks[0].line;
 const sectionId=tasks[0].section;

 let lo=DAY_START,hi=DAY_END;
 for(const d of new Set(tasks.map(t=>t.department))){
  const a=state.availability.find(x=>x.department===d);
  if(!a?.ready){codes.DEPARTMENT=1;return {block:null,codes};}
  lo=Math.max(lo,a.start);hi=Math.min(hi,a.end);
 }
 if(hi-lo<duration){codes.DEPARTMENT=1;return {block:null,codes};}

 // Candidates come in two flavours: windows that already exist in the timetable,
 // and sanctioned corridor windows bought by regulating traffic.
 const candidates=[];
 for(const [a,b] of freeIntervals(state,sectionId,line,date,lo,hi)){
  const last=b-duration;
  if(last<a)continue;
  const starts=new Set([a,last,Math.round((a+last)/2)]);
  if(Number.isInteger(preferred))starts.add(Math.max(a,Math.min(last,preferred)));
  // Crew and machinery free up at the edges of other blocks that day.
  for(const other of state.blocks){
   if(other.date!==date)continue;
   for(const edge of [other.end,other.start-duration])
    if(edge>=a&&edge<=last)starts.add(edge);
  }
  for(const st of starts)candidates.push([st,false]);
 }
 // Section-wide work is sanctioned as a single band on every running line.
 const bandLine=line===null?'BOTH':line;
 for(const w of corridorWindows.filter(w=>w.line===bandLine&&w.minutes>=duration)){
  const last=Math.min(w.end-duration,hi-duration);
  if(last<Math.max(w.start,lo))continue;
  const from=Math.max(w.start,lo);
  candidates.push([from,true]);
  if(Number.isInteger(preferred))candidates.push([Math.max(from,Math.min(last,preferred)),true]);
 }
 if(!candidates.length){codes.TRAIN=1;return {block:null,codes};}

 let best=null,bestValue=-Infinity;
 for(const [start,corridor] of candidates.sort((x,y)=>x[0]-y[0])){
  const block={date,section:sectionId,line,start,end:start+duration,taskIds,corridor};
  const v=validateBlock(block,state);
  if(!v.safe){bump(v);continue;}
  const s=scoreOf(block,state,lo,preferred);
  if(s.value>bestValue){
   bestValue=s.value;
   best={...block,
    rationale:{...s,corridor,tasks:taskIds.length,
     work:tasks.reduce((n,t)=>n+t.duration,0),
     overhead:[...new Set(tasks.map(t=>t.department))]
      .reduce((n,d)=>n+(dept(d)?.setup??0)+(dept(d)?.clearance??0),0),
     saved:separateMinutes(tasks)-duration},
    taskPlan:sequence(tasks,start)};
  }
 }
 return {block:best,codes};
}

// The baseline is today's practice: each department raises its own demand and
// each request gets its own block, paying setup and clearance every time.
export function separateMinutes(tasks){
 return tasks.reduce((n,t)=>{
  const d=dept(t.department);
  return n+(d?.setup??0)+t.duration+(d?.clearance??0);
 },0);
}

export const findSlot=(taskIds,state,date,preferred)=>search(taskIds,state,date,preferred).block;
const dominant=codes=>Object.entries(codes).sort((a,b)=>b[1]-a[1])[0]?.[0];

// ---- horizon planning -----------------------------------------------------
export function optimize(ids,state,options={}){
 const from=options.from||state.date;
 const horizon=options.horizon||state.horizon||'day';
 const dates=horizonDates(from,horizon);
 const pool=state.requests.filter(t=>ids.includes(t.id)&&t.status==='Pending');

 // Work the backlog in priority order; the model decides what matters most.
 const ranked=[...pool].sort((a,b)=>priorityOf(b,from)-priorityOf(a,from)||a.id.localeCompare(b.id));
 const working=structuredClone(state);
 working.blocks=[...state.blocks];
 const placed=new Set(),plans=[];

 for(const date of dates){
  let progress=true;
  while(progress){
   progress=false;
   for(const seed of ranked){
    if(placed.has(seed.id))continue;
    // Only work on the same section and compatible line can share a possession.
    const mates=ranked.filter(t=>!placed.has(t.id)&&t.id!==seed.id
      &&t.section===seed.section
      &&(t.line===seed.line||t.line===null||seed.line===null));
    let group=[seed.id];
    let found=search(group,working,date,options.preferred);
    if(!found.block)continue;
    let best=found.block;
    for(const mate of mates){
     const trial=search([...group,mate.id],working,date,options.preferred);
     if(trial.block){group.push(mate.id);best=trial.block;}
    }
    group.forEach(id=>placed.add(id));
    best.blockNo=plans.length+1;
    plans.push(best);
    working.blocks.push({...best,id:`candidate-${plans.length}`,
     departments:[...new Set(group.map(id=>pool.find(t=>t.id===id).department))],
     resources:[...new Set(group.map(id=>pool.find(t=>t.id===id).resource).filter(r=>r!=='None'))]});
    progress=true;
    break;
   }
  }
 }

 // Probe against the untouched timetable: a task that fits on an empty day was
 // squeezed out by capacity, not by a constraint it can never satisfy.
 const longestBand=Math.max(...corridorWindows.map(w=>w.minutes),0);
 const unplaced=ranked.filter(t=>!placed.has(t.id)).map(t=>{
  // Work longer than the longest sanctioned band cannot be granted at all;
  // it needs an extended traffic block with traffic diverted off the corridor.
  const need=requiredMinutes([t]);
  if(need>longestBand)return {...t,deferral:'structural',code:'EXTENDED',
   reason:`Needs ${need} min including protection and clearance, longer than the ${longestBand} min sanctioned corridor window. Raise as an extended traffic block with traffic diverted.`};
  const clean=search([t.id],state,dates[0],options.preferred);
  if(clean.block)return {...t,deferral:'capacity',
   reason:`Every crew and window in this ${horizon} horizon is already committed to higher-priority work.`};
  const code=dominant(clean.codes);
  return {...t,deferral:'structural',code,
   reason:REASONS[code]||'No window satisfies every constraint in this horizon.'};
 });
 return {from,horizon,dates,plans,unplaced,summary:summarise(plans,unplaced)};
}

export function summarise(plans,unplaced){
 const combined=plans.filter(p=>p.taskIds.length>1);
 const tasks=plans.reduce((n,p)=>n+p.taskIds.length,0);
 const occupied=plans.reduce((n,p)=>n+(p.end-p.start),0);
 const separate=plans.reduce((n,p)=>n+p.rationale.saved,0)+occupied;
 return {
  blocks:plans.length,
  tasks,
  tasksCombined:combined.reduce((n,p)=>n+p.taskIds.length,0),
  blocksReduced:plans.reduce((n,p)=>n+p.taskIds.length-1,0),
  lineMinutesOccupied:occupied,
  lineMinutesSaved:separate-occupied,
  availabilityGain:separate?Math.round((separate-occupied)/separate*1000)/10:0,
  deferred:unplaced.length,
  deferredCapacity:unplaced.filter(u=>u.deferral==='capacity').length,
  deferredStructural:unplaced.filter(u=>u.deferral==='structural').length,
 };
}
