import test from 'node:test';
import assert from 'node:assert/strict';
import {demo,trains,sections,corridorWindows,corridorWindow,spanOverlap,
        requiredMinutes,sequence,streamMinutes,dept,time,minutes,
        addDays,daysBetween,horizonDates,priorityOf,band,
        delayed,riskOf,consequenceOf,DAY_START,DAY_END,BUFFER} from '../dist/data.js';
import {validateBlock,validateRequest,approveBlock,withdrawBlock,
        revalidateSchedule} from '../dist/safety.js';
import {optimize,search,findSlot,freeIntervals,headroom,trainsAffected,
        separateMinutes,legIndex,WEIGHTS} from '../dist/planner.js';
import {score,explain,featurise,FEATURES} from '../dist/priority-model.js';
import {failureRisk,explainRisk,hazardFeatures,riskBand,
        HFEATURES,AUC,BRIER,BASE_RATE} from '../dist/hazard-model.js';
import {LEARNED,FIT} from '../dist/weights.js';
import {HCOEF,HMEAN} from '../dist/hazard.js';

const state=()=>{const s=demo();s.trains=trains;return s;};
const pick=(s,fn)=>s.requests.find(fn);
const blockFor=(s,ids,start,extra={})=>{
 const tasks=ids.map(id=>s.requests.find(r=>r.id===id));
 return {date:s.date,section:tasks[0].section,line:tasks[0].line,
         start,end:start+requiredMinutes(tasks),taskIds:ids,...extra};
};

// ---------------------------------------------------------------- data shape
test('corridor is built from the real timetable',()=>{
 assert.equal(sections.length,6);
 assert.ok(trains.length>150);
 assert.ok(trains.every(t=>t.legs.every(l=>['UP','DN'].includes(l.line))));
 assert.ok(trains.every(t=>t.legs.every(l=>sections.some(s=>s.id===l.section))));
});
test('every backlog item points at a real section and a known department',()=>{
 const s=state();
 assert.ok(s.requests.length>100);
 for(const r of s.requests){
  assert.ok(sections.some(x=>x.id===r.section));
  assert.ok(['ENGG','SNT','TRD'].includes(r.department));
  assert.ok(r.line===null||['UP','DN'].includes(r.line));
 }
});
test('sanctioned corridor windows name their traffic cost',()=>{
 assert.ok(corridorWindows.length);
 for(const w of corridorWindows){
  assert.ok(w.end-w.start>=w.minutes);
  assert.ok(Number.isInteger(w.trainsAffected)&&w.trainsAffected>=0);
 }
 assert.ok(corridorWindow('UP',120));
 assert.equal(corridorWindow('UP',10000),null);
});

// -------------------------------------------------------------- time helpers
test('spans compare correctly across midnight',()=>{
 assert.equal(spanOverlap(1430,1490,20,40),true);   // 23:50-00:50 vs 00:20-00:40
 assert.equal(spanOverlap(1430,1490,100,120),false);
 assert.equal(spanOverlap(100,200,150,300),true);
});
test('clock and date helpers',()=>{
 assert.equal(time(1500),'01:00');
 assert.equal(minutes('07:30'),450);
 assert.equal(addDays('2026-09-14',7),'2026-09-21');
 assert.equal(daysBetween('2026-09-14','2026-09-21'),7);
 assert.equal(horizonDates('2026-09-14','week').length,7);
});

// ------------------------------------------------- setup, work and clearance
test('a stream is setup plus work plus clearance',()=>{
 const s=state();
 const t=pick(s,r=>r.department==='TRD');
 const d=dept('TRD');
 assert.equal(streamMinutes('TRD',[t]),d.setup+t.duration+d.clearance);
 assert.ok(d.setup>=30,'traction needs isolation and earthing time');
});
test('block length is the longest department stream',()=>{
 const s=state();
 const a=pick(s,r=>r.department==='ENGG'),b=pick(s,r=>r.department==='SNT');
 assert.equal(requiredMinutes([a,b]),
  Math.max(streamMinutes('ENGG',[a]),streamMinutes('SNT',[b])));
});
test('same-department work is laid end to end after its setup',()=>{
 const s=state();
 const two=s.requests.filter(r=>r.department==='ENGG').slice(0,2);
 const plan=sequence(two,600);
 assert.equal(plan[0].start,600+dept('ENGG').setup);
 assert.equal(plan[1].start,plan[0].end);
 assert.equal(requiredMinutes(two),
  dept('ENGG').setup+two[0].duration+two[1].duration+dept('ENGG').clearance);
});
test('a block too short for the stream is rejected',()=>{
 const s=state();
 const t=pick(s,r=>r.line!==null);
 const r=validateBlock({date:s.date,section:t.section,line:t.line,
   start:600,end:600+t.duration,taskIds:[t.id]},s);
 assert.ok(r.errors.some(e=>e.code==='DURATION'));
});

// ------------------------------------------------------------ line awareness
test('a block on one line ignores traffic on the other',()=>{
 const s=state();
 const leg=trains.flatMap(t=>t.legs).find(l=>l.line==='UP'&&l.start>400);
 const t=pick(s,r=>r.section===leg.section&&r.line==='DN');
 if(!t)return;
 const b={date:s.date,section:leg.section,line:'DN',
   start:leg.start,end:leg.start+30,taskIds:[t.id]};
 const up=validateBlock(b,s).errors.filter(e=>e.code==='TRAIN');
 assert.ok(up.every(e=>!e.message.includes('(UP line)')));
});
test('section-wide work cannot ride in a single-line block',()=>{
 const s=state();
 const wide=pick(s,r=>r.line===null);
 const r=validateBlock({date:s.date,section:wide.section,line:'UP',
   start:600,end:600+requiredMinutes([wide]),taskIds:[wide.id]},s);
 assert.ok(r.errors.some(e=>e.code==='LINE'));
});
test('work on opposite lines cannot share a block',()=>{
 const s=state();
 const up=pick(s,r=>r.line==='UP'),dn=pick(s,r=>r.section===up.section&&r.line==='DN');
 if(!dn)return;
 const r=validateBlock(blockFor(s,[up.id,dn.id],600),s);
 assert.ok(r.errors.some(e=>e.code==='LINE'));
});

// ----------------------------------------------------------- corridor blocks
test('a corridor block must sit inside a sanctioned window',()=>{
 const s=state();
 const w=corridorWindow('UP',120);
 const t=pick(s,r=>r.line==='UP'&&requiredMinutes([r])<=120);
 const inside=validateBlock(blockFor(s,[t.id],w.start,{corridor:true}),s);
 assert.ok(!inside.errors.some(e=>e.code==='CORRIDOR'));
 const away=Math.min(...corridorWindows.filter(w=>w.line==='UP').map(w=>w.start))-200;
 const outside=validateBlock(blockFor(s,[t.id],Math.max(0,away),{corridor:true}),s);
 assert.ok(outside.errors.some(e=>e.code==='CORRIDOR'));
});
test('regulated traffic inside a corridor block is a cost, not a conflict',()=>{
 const s=state();
 const w=corridorWindow('UP',120);
 const t=pick(s,r=>r.line==='UP'&&requiredMinutes([r])<=120);
 const b=blockFor(s,[t.id],w.start,{corridor:true});
 assert.ok(!validateBlock(b,s).errors.some(e=>e.code==='TRAIN'));
 assert.ok(validateBlock({...b,corridor:false},s).errors.some(e=>e.code==='TRAIN')
        || trainsAffected(b,s)===0);
});
test('the traffic cost of a block is counted',()=>{
 const s=state();
 const w=corridorWindow('UP',240);
 const t=pick(s,r=>r.line==='UP');
 const n=trainsAffected({section:t.section,line:'UP',start:w.start,end:w.end},s);
 assert.ok(Number.isInteger(n)&&n>=0);
});

// ------------------------------------------------------- windows and scoring
test('free intervals exclude traffic and its margin',()=>{
 const s=state();
 const free=freeIntervals(s,'S1','DN',s.date,0,1440);
 const legs=legIndex(trains).get('S1|DN');
 for(const [a,b] of free)
  for(const l of legs)
   assert.ok(!(a<l.end+BUFFER&&l.start-BUFFER<b),'free window overlaps a train margin');
});
test('free intervals shrink once a block is approved',()=>{
 const s=state();
 const before=freeIntervals(s,'S1','DN',s.date,0,1440);
 const [a]=before;
 s.blocks.push({id:'x',date:s.date,section:'S1',line:'DN',start:a[0],end:a[1],
   taskIds:[],departments:[],resources:[]});
 const after=freeIntervals(s,'S1','DN',s.date,0,1440);
 assert.ok(after.length<before.length||after[0][0]>=a[1]);
});
test('headroom is clearance to the nearest train, capped',()=>{
 const s=state();
 const free=freeIntervals(s,'S2','DN',s.date,0,1440).find(([a,b])=>b-a>40);
 const mid=Math.round((free[0]+free[1])/2);
 assert.ok(headroom({section:'S2',line:'DN',start:mid-10,end:mid+10},s)>0);
 assert.ok(headroom({section:'S2',line:'DN',start:free[0],end:free[0]+5},s)===0);
 assert.ok(headroom({section:'S2',line:'DN',start:mid,end:mid+1},s)<=WEIGHTS.headroomCap);
});
test('a natural window is preferred over regulating trains',()=>{
 // A corridor block earns no clearance credit, so its best possible score is
 // minus its traffic cost. That must sit below the worst a natural window can do.
 const cheapest=Math.min(...corridorWindows.map(w=>w.trainsAffected));
 assert.ok(cheapest*WEIGHTS.trainRegulated>DAY_END*WEIGHTS.earliness,
  'regulating traffic must cost more than any natural window ever does');
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'day'});
 const natural=r.plans.filter(p=>!p.corridor);
 assert.ok(natural.length,'some work fits without regulating traffic');
 for(const p of natural)assert.equal(trainsAffected(p,s),0);
});

// ------------------------------------------------------------ priority model
test('priority rises with overdue and with defect severity',()=>{
 const base={overdueDays:0,periodicity:90,severity:0,criticality:0.8,traffic:0.5};
 assert.ok(score({...base,overdueDays:60})>score(base));
 assert.ok(score({...base,severity:4})>score({...base,severity:0}));
 assert.ok(score({...base,traffic:1})>score({...base,traffic:0.1}));
 assert.ok(score(base)>=0&&score(base)<=100);
});
test('attribution is exact for a linear model and names every feature',()=>{
 const r={overdueDays:30,periodicity:180,severity:2,criticality:0.7,traffic:0.5};
 const parts=explain(r);
 assert.equal(parts.length,FEATURES.length);
 assert.equal(featurise(r).length,FEATURES.length);
 const spread=parts.reduce((n,p)=>n+p.contribution,0);
 const baseline=score(r)-spread;
 // Identical baseline for any input the 0-100 clamp does not touch.
 const other={overdueDays:10,periodicity:180,severity:1,criticality:0.6,traffic:0.3};
 const otherBase=score(other)-explain(other).reduce((n,p)=>n+p.contribution,0);
 assert.ok(Math.abs(otherBase-baseline)<1.5,'the same baseline underlies every explanation');
});
test('bands map scores to controller-facing labels',()=>{
 assert.equal(band(80),'Critical');assert.equal(band(60),'High');
 assert.equal(band(45),'Medium');assert.equal(band(10),'Low');
});
test('an overdue item ages further into the horizon',()=>{
 const s=state();
 const r=pick(s,x=>x.overdueDays>0);
 assert.ok(priorityOf(r,addDays(s.date,60))>=priorityOf(r,s.date));
});

// --------------------------------------------------------- horizon behaviour
test('a longer horizon schedules strictly more work',()=>{
 const s=state();const ids=s.requests.map(t=>t.id);
 const day=optimize(ids,s,{horizon:'day'});
 const week=optimize(ids,s,{horizon:'week'});
 const month=optimize(ids,s,{horizon:'month'});
 assert.ok(week.summary.tasks>day.summary.tasks);
 assert.ok(month.summary.tasks>=week.summary.tasks);
 assert.equal(day.dates.length,1);
 assert.equal(week.dates.length,7);
 assert.equal(month.dates.length,28);
});
test('every recommendation passes the gate it was produced under',()=>{
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'week'});
 const check=structuredClone(s);
 for(const p of r.plans){
  assert.equal(validateBlock(p,check).safe,true,`plan on ${p.date} failed revalidation`);
  check.blocks.push({...p,id:`c${check.blocks.length}`,
   departments:[...new Set(p.taskIds.map(i=>check.requests.find(x=>x.id===i).department))],
   resources:[...new Set(p.taskIds.map(i=>check.requests.find(x=>x.id===i).resource).filter(x=>x!=='None'))]});
 }
});
test('no task is scheduled twice across a horizon',()=>{
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'month'});
 const all=r.plans.flatMap(p=>p.taskIds);
 assert.equal(all.length,new Set(all).size);
 assert.equal(all.length+r.unplaced.length,s.requests.length);
});
test('deferrals separate capacity from structural impossibility',()=>{
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'month'});
 assert.equal(r.summary.deferredCapacity+r.summary.deferredStructural,r.summary.deferred);
 for(const u of r.unplaced)assert.ok(u.reason&&u.deferral);
 // Work longer than the largest sanctioned window can never fit.
 const longest=Math.max(...corridorWindows.map(w=>w.minutes));
 for(const u of r.unplaced.filter(x=>requiredMinutes([x])>longest))
  assert.equal(u.deferral,'structural');
});
test('the summary adds up',()=>{
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'week'});
 assert.equal(r.summary.blocks,r.plans.length);
 assert.equal(r.summary.tasks,r.plans.reduce((n,p)=>n+p.taskIds.length,0));
 assert.equal(r.summary.lineMinutesOccupied,r.plans.reduce((n,p)=>n+(p.end-p.start),0));
 assert.ok(r.summary.lineMinutesSaved>0);
 assert.ok(r.summary.availabilityGain>0&&r.summary.availabilityGain<100);
});
test('consolidation beats planning each department separately',()=>{
 const s=state();
 const r=optimize(s.requests.map(t=>t.id),s,{horizon:'week'});
 for(const p of r.plans){
  const tasks=p.taskIds.map(i=>s.requests.find(x=>x.id===i));
  const apart=separateMinutes(tasks),together=p.end-p.start;
  if(tasks.length>1)assert.ok(apart>together,`${p.date} ${p.section} saved nothing`);
  else assert.equal(apart,together,'a single task costs the same either way');
 }
});

// ------------------------------------------------------------------ approval
test('unsafe approval never mutates state',()=>{
 const s=state();const copy=structuredClone(s.requests);
 const t=s.requests[0];
 const bad={date:s.date,section:t.section,line:t.line,start:600,end:601,taskIds:[t.id]};
 assert.equal(approveBlock(bad,s,'Controller').safe,false);
 assert.deepEqual(s.requests,copy);
 assert.equal(s.blocks.length,0);
});
test('approval requires a named controller, commits once, and marks the date',()=>{
 const s=state();
 const p=optimize(s.requests.map(t=>t.id),s,{horizon:'day'}).plans[0];
 assert.equal(approveBlock(p,s,'  ').safe,false);
 const ok=approveBlock(p,s,'Sr DOM');
 assert.equal(ok.safe,true);
 assert.equal(s.blocks.length,1);
 assert.equal(approveBlock(p,s,'Sr DOM').safe,false,'tasks are no longer pending');
 for(const id of p.taskIds){
  const r=s.requests.find(x=>x.id===id);
  assert.equal(r.status,'Scheduled');
  assert.equal(r.scheduledFor,p.date);
 }
 assert.ok(s.audit[0].message.includes('Sr DOM'));
 assert.ok(ok.block.taskPlan.length===p.taskIds.length);
});
test('a recommendation that went stale is caught at approval',()=>{
 const s=state();
 const p=optimize(s.requests.map(t=>t.id),s,{horizon:'day'}).plans.find(x=>!x.corridor);
 s.trains=[...s.trains,{id:'99999',name:'Inserted special',
   legs:[{section:p.section,line:p.line,start:p.start,end:p.start+15}]}];
 assert.equal(approveBlock(p,s,'Sr DOM').safe,false);
});
test('crew count limits concurrent blocks for a department',()=>{
 const s=state();
 const avail=s.availability.find(a=>a.department==='TRD');
 avail.crews=1;
 const t=pick(s,r=>r.department==='TRD'&&r.line!==null);
 s.blocks.push({id:'busy',date:s.date,section:'S1',line:'UP',start:600,end:800,
   taskIds:[],departments:['TRD'],resources:[]});
 const r=validateBlock({date:s.date,section:t.section,line:t.line,
   start:650,end:650+requiredMinutes([t]),taskIds:[t.id]},s);
 assert.ok(r.errors.some(e=>e.code==='CREW'));
});
test('an unready department schedules nothing',()=>{
 const s=state();
 s.availability.find(a=>a.department==='TRD').ready=false;
 const trd=s.requests.filter(r=>r.department==='TRD').map(r=>r.id);
 const r=optimize(trd,s,{horizon:'week'});
 assert.equal(r.plans.length,0);
 assert.equal(r.unplaced.length,trd.length);
});

// ------------------------------------------------------------ request intake
test('invalid requests are rejected',()=>{
 const s=state();const good=s.requests[0];
 assert.ok(validateRequest({...good,id:'new',title:''},s).length);
 assert.ok(validateRequest({...good,id:'new',duration:-5},s).length);
 assert.ok(validateRequest({...good,id:'new',section:'NOPE'},s).length);
 assert.ok(validateRequest({...good,id:'new',line:'SIDING'},s).length);
 assert.ok(validateRequest({...good,id:'new',department:'XX'},s).length);
 assert.equal(validateRequest({...good,id:'new',title:'Fresh activity'},s).length,0);
});
test('the same activity cannot be pending twice on one asset',()=>{
 const s=state();const good=s.requests[0];
 assert.ok(validateRequest({...good,id:'new'},s).some(m=>/already pending/.test(m)));
});

// ------------------------------------------------- withdrawal and disruption
test('a withdrawn block returns its work orders to the backlog',()=>{
 const s=state();
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const out=approveBlock(plan.plans[0],s,'Sr DOM');
 assert.ok(out.safe);
 const id=out.block.id,ids=out.block.taskIds;
 assert.equal(s.blocks.length,1);
 assert.ok(ids.every(x=>s.requests.find(r=>r.id===x).status==='Scheduled'));

 const w=withdrawBlock(id,s,'Sr DOM','permit refused on the day');
 assert.ok(w.ok);
 assert.equal(s.blocks.length,0);
 assert.ok(ids.every(x=>s.requests.find(r=>r.id===x).status==='Pending'));
 assert.ok(ids.every(x=>s.requests.find(r=>r.id===x).scheduledFor===undefined));
 assert.match(s.audit[0].message,/withdrew/);
 assert.match(s.audit[0].message,/permit refused/);
});
test('withdrawal needs a named controller and a block that exists',()=>{
 const s=state();
 assert.equal(withdrawBlock('nope',s,'Sr DOM').ok,false);
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const out=approveBlock(plan.plans[0],s,'Sr DOM');
 assert.equal(withdrawBlock(out.block.id,s,'  ').ok,false);
 assert.equal(s.blocks.length,1,'a refused withdrawal leaves the schedule untouched');
});
test('a running delay shifts every leg of that train and nothing else',()=>{
 const target=trains[0];
 const moved=delayed(trains,[{train:target.id,minutes:45}]);
 const after=moved.find(t=>t.id===target.id);
 assert.equal(after.delay,45);
 target.legs.forEach((leg,i)=>{
  assert.equal(after.legs[i].start,leg.start+45);
  assert.equal(after.legs[i].end,leg.end+45);
 });
 assert.equal(moved.filter(t=>t.delay).length,1);
 assert.equal(delayed(trains,[]),trains,'no delays is a no-op');
});
test('an approved block that a delay runs into stops clearing the gate',()=>{
 const s=state();
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const natural=plan.plans.find(p=>!p.corridor);
 assert.ok(natural,'the day plan should use at least one natural window');
 assert.ok(approveBlock(natural,s,'Sr DOM').safe);
 assert.equal(revalidateSchedule(s).length,0,'safe when granted');

 // Run the train booked ahead of the possession late, so it slides into it.
 const idx=legIndex(s.trains);
 const legs=natural.line===null
  ?[...(idx.get(`${natural.section}|UP`)||[]),...(idx.get(`${natural.section}|DN`)||[])]
  :(idx.get(`${natural.section}|${natural.line}`)||[]);
 const prev=legs.filter(l=>l.end+BUFFER<=natural.start).sort((a,b)=>b.end-a.end)[0];
 assert.ok(prev,'there is a train booked ahead of this possession');
 const owner=s.trains.find(t=>t.legs.includes(prev));
 const late=natural.start-prev.start+1;   // its occupation now begins inside the block

 s.delays=[{train:owner.id,minutes:late}];
 s.trains=delayed(trains,s.delays);
 const conflicts=revalidateSchedule(s);
 assert.equal(conflicts.length,1);
 assert.ok(conflicts[0].errors.some(e=>e.code==='TRAIN'));
});
test('an emergency work order is planned ahead of the model ranking',()=>{
 const s=state();
 const low=[...s.requests].sort((a,b)=>priorityOf(a,s.date)-priorityOf(b,s.date))[0];
 assert.ok(priorityOf(low,s.date)<70,'starts well down the ranking');
 low.emergency=true;
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const placed=plan.plans.flatMap(p=>p.taskIds);
 assert.ok(placed.includes(low.id),'an emergency is scheduled even from the bottom of the list');
});
test('a preferred start moves the window and the gate still passes',()=>{
 const s=state();
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const p=plan.plans.find(x=>!x.corridor);
 const moved=search(p.taskIds,s,p.date,p.start+120).block;
 assert.ok(moved,'a preferred start still returns a window');
 assert.ok(validateBlock(moved,s).safe,'the moved window is re-checked, not trusted');
 assert.equal(moved.end-moved.start,p.end-p.start);
});

// ------------------------------------------------------- hazard model
test('the hazard model returns a probability and reports how well it separates',()=>{
 assert.equal(HFEATURES.length,4);
 assert.ok(AUC>0.7&&AUC<1,'held-out AUC should beat chance by a clear margin');
 assert.ok(BRIER>0&&BRIER<0.25,'Brier score should beat predicting the base rate');
 assert.ok(BASE_RATE>0.05&&BASE_RATE<0.6,'a plausible defect rate per cycle');
 for(const r of state().requests){
  const p=failureRisk(r);
  assert.ok(p>0&&p<1,`${r.id} risk out of range`);
 }
});
test('risk rises with wear and with traffic, and is not the same as consequence',()=>{
 const base={periodicity:90,traffic:0.5,class:'Rail'};
 const fresh=failureRisk({...base,elapsedDays:20});
 const worn =failureRisk({...base,elapsedDays:170});
 assert.ok(worn>fresh,'a worn asset is likelier to have developed a defect');

 const quiet=failureRisk({...base,elapsedDays:120,traffic:0.2});
 const busy =failureRisk({...base,elapsedDays:120,traffic:1.0});
 assert.ok(busy>quiet,'the same asset under more traffic is likelier to fail');

 // Probability and consequence are separate quantities and must stay separate:
 // a bridge fails rarely and expensively, a track circuit often and cheaply.
 const bridge={periodicity:365,elapsedDays:300,traffic:0.5,class:'Bridge',criticality:0.80};
 const circuit={periodicity:90,elapsedDays:75,traffic:0.5,class:'Track circuit',criticality:0.60};
 assert.ok(failureRisk(circuit)>failureRisk(bridge),'the track circuit fails more often');
 assert.ok(consequenceOf(bridge)>consequenceOf(circuit),'the bridge costs more when it does');
});
test('risk attribution is exact in the log-odds',()=>{
 const s=state();
 for(const r of s.requests.slice(0,25)){
  const parts=explainRisk(r);
  assert.equal(parts.length,HFEATURES.length);
  const p=failureRisk(r);
  const logOdds=Math.log(p/(1-p));
  // Contributions are deviations from the training mean, so the log-odds at the
  // mean asset plus every contribution must land exactly on this asset's log-odds.
  const atMean=HCOEF[0]+HCOEF.slice(1).reduce((n,c,i)=>n+c*HMEAN[i],0);
  const sum=parts.reduce((n,x)=>n+x.logOdds,0);
  assert.ok(Math.abs(logOdds-(atMean+sum))<1e-9,
    `${r.id}: contributions do not sum to the log-odds`);
  assert.equal(hazardFeatures(r).length,HFEATURES.length);
  assert.ok(['Low','Raised','High'].includes(riskBand(p)));
 }
});
test('the hazard baked into the backlog matches the hazard recomputed',()=>{
 const s=state();
 for(const r of s.requests.slice(0,40))
  assert.ok(Math.abs(r.risk-riskOf(r,s.date))<1e-4,`${r.id} stored risk drifted`);
});
test('predicted risk raises priority rather than lowering it',()=>{
 assert.ok(FEATURES.includes('Predicted failure risk'));
 const i=FEATURES.indexOf('Predicted failure risk');
 const base={overdueDays:10,periodicity:90,severity:0,criticality:0.8,traffic:0.6};
 const low =score({...base,risk:0.05});
 const high=score({...base,risk:0.85});
 assert.ok(high>low,'a likelier failure must not score lower');
 const parts=explain({...base,risk:0.85});
 assert.ok(parts.find(x=>x.name===FEATURES[i]).contribution>0);
});

// ------------------------------------------------- learned planner weights
test('the planner objective is fitted, and traffic dominates the tradeoff',()=>{
 assert.equal(LEARNED.headroom,1,'weights are normalised to minutes of clearance');
 assert.ok(LEARNED.trainRegulated>5,'regulating a train costs real minutes');
 assert.ok(LEARNED.earliness>0&&LEARNED.earliness<1,'lateness in the day is a tiebreak');
 assert.ok(LEARNED.trainRegulated>LEARNED.headroom*5,
   'a natural gap must beat a granted window by a wide margin');
 assert.ok(FIT.agreement>FIT.baseline*2,'the fit must beat taking the first window');
 // The planner keeps the structural terms the choice data cannot speak to.
 assert.equal(WEIGHTS.headroomCap,45);
 assert.equal(WEIGHTS.deviation,1);
 assert.equal(WEIGHTS.trainRegulated,LEARNED.trainRegulated);
});
test('a natural window still beats a corridor window under the fitted weights',()=>{
 const s=state();
 const plan=optimize(s.requests.filter(r=>r.status==='Pending').map(r=>r.id),s,{horizon:'day'});
 const natural=plan.plans.filter(p=>!p.corridor);
 assert.ok(natural.length,'the fitted objective still prefers free windows where they exist');
 for(const p of natural)assert.equal(trainsAffected(p,s),0,'a natural window regulates nobody');
});
