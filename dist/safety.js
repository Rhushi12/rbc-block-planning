import {sections,lines,departments,resources,trainLegs,dept,deptLabel,
        streams,streamMinutes,requiredMinutes,sequence,spanOverlap,corridorWindows,
        DAY_START,DAY_END,BUFFER} from './data.js';
export {requiredMinutes,sequence,streams,BUFFER};
export const overlaps=(a,b,c,d)=>a<d&&c<b;

export function validateRequest(r,state){
 const errors=[];
 if(!r.title?.trim()||r.title.trim().length>120)errors.push('Enter a task name (1–120 characters).');
 if(!sections.some(s=>s.id===r.section))errors.push('Select a valid section.');
 if(r.line!==null&&!lines.includes(r.line))errors.push('Select a valid running line, or mark the work as section-wide.');
 if(!departments.some(d=>d.code===r.department))errors.push('Select a valid department.');
 if(r.resource!=='None'&&!resources.includes(r.resource))errors.push('Select valid machinery.');
 if(!Number.isInteger(r.duration)||r.duration<5||r.duration>480)errors.push('Duration must be 5–480 whole minutes.');
 if(!Number.isInteger(r.periodicity)||r.periodicity<1)errors.push('Periodicity must be a whole number of days.');
 if(state.requests.some(x=>x.id!==r.id&&x.asset===r.asset&&x.title===r.title&&x.status==='Pending'))
  errors.push('This activity is already pending on the same asset.');
 return errors;
}

// Does a block on `line` conflict with traffic on `legLine`?
// Section-wide work (line === null) blocks every running line.
const touches=(blockLine,legLine)=>blockLine===null||blockLine===legLine;

// Authoritative prototype gate. Optimiser and manual approval both call this.
export function validateBlock(block,state){
 const errors=[];const add=(code,message)=>errors.push({code,message});
 const tasks=block.taskIds?.map(id=>state.requests.find(r=>r.id===id))||[];
 if(!tasks.length||tasks.some(t=>!t)||new Set(block.taskIds).size!==tasks.length){
  add('TASK','Choose unique, existing maintenance tasks.');return {safe:false,errors};}
 if(!block.date)add('DATE','A block must be planned for a calendar date.');
 if(!Number.isInteger(block.start)||!Number.isInteger(block.end)||
    block.start<DAY_START||block.end>DAY_END||block.end<=block.start)
  add('TIME','Block must fit inside the planning day.');
 if(block.line!==null&&!lines.includes(block.line))add('LINE','A block must name a running line, or be section-wide.');

 const valid=tasks.filter(Boolean);
 for(const task of valid){
  if(task.status!=='Pending')add('TASK',`${task.id} has already been scheduled.`);
  if(task.section!==block.section)add('SECTION','Combined tasks must be on the same section.');
  // Line-specific work cannot ride in a block on the other running line.
  if(task.line!==null&&block.line!==null&&task.line!==block.line)
   add('LINE',`${task.id} is on the ${task.line} line.`);
  if(task.line===null&&block.line!==null)
   add('LINE',`${task.id} affects both running lines and needs a section-wide block.`);
  const a=state.availability.find(x=>x.department===task.department);
  if(!a?.ready||block.start<a.start||block.end>a.end)
   add('DEPARTMENT',`${deptLabel(task.department)} is not on duty throughout this window.`);
 }

 // One crew per department per block: it sets up, works in sequence, then clears.
 for(const [department,list] of streams(valid)){
  const needed=streamMinutes(department,list);
  if(block.end-block.start<needed){
   const d=dept(department);
   add('DURATION',`${deptLabel(department)} needs ${needed} min — ${d?.setup??0} setup + ${list.reduce((n,t)=>n+t.duration,0)} work + ${d?.clearance??0} clearance.`);
  }
 }

 // Machinery is a single division-wide unit, so two parallel departments cannot share it.
 for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
  if(valid[i].department!==valid[j].department&&valid[i].resource!=='None'&&valid[i].resource===valid[j].resource)
   add('RESOURCE',`${valid[i].resource} cannot serve two departments at once.`);
 }

 // A corridor block is granted by regulating traffic, so trains inside it are a
 // sanctioned cost rather than a conflict. It must stay inside the sanctioned band.
 if(block.corridor){
  // Section-wide work closes every running line and is sanctioned as one band.
  const need=block.line===null?'BOTH':block.line;
  if(!corridorWindows.some(x=>x.line===need&&block.start>=x.start&&block.end<=x.end))
   add('CORRIDOR',`A corridor block must sit inside a sanctioned ${need} corridor window.`);
 }else{
  for(const t of state.trains)for(const leg of trainLegs(t)){
   if(leg.section!==block.section||!touches(block.line,leg.line))continue;
   if(spanOverlap(block.start,block.end,leg.start-BUFFER,leg.end+BUFFER))
    add('TRAIN',`${t.id} ${t.name} (${leg.line} line): occupation or ${BUFFER}-minute margin overlaps.`);
  }
 }

 const depts=[...new Set(valid.map(t=>t.department))];
 const res=valid.map(t=>t.resource).filter(r=>r!=='None');
 const sameDay=state.blocks.filter(b=>b.date===block.date&&b.id!==block.id);
 const concurrent=sameDay.filter(b=>spanOverlap(block.start,block.end,b.start,b.end));

 for(const b of concurrent)
  if(b.section===block.section&&touches(block.line,b.line)&&touches(b.line,block.line))
   add('BLOCK',`Overlaps approved block ${b.id} on this section.`);
 for(const d of depts){
  const crews=state.availability.find(x=>x.department===d)?.crews??1;
  const busy=concurrent.filter(b=>b.departments?.includes(d)).length;
  if(busy+1>crews)
   add('CREW',`${deptLabel(d)} has ${crews} crew${crews>1?'s':''} on duty; ${busy} already committed in this window.`);
 }
 for(const b of concurrent)
  if(b.resources?.some(r=>res.includes(r)))
   add('RESOURCE',`Machinery required here is committed to ${b.id}.`);

 return {safe:errors.length===0,errors};
}

export function approveBlock(block,state,approvedBy){
 const result=validateBlock(block,state);
 if(!approvedBy?.trim())result.errors.push({code:'APPROVAL',message:'Enter the approving controller’s name.'});
 result.safe=result.errors.length===0;
 if(!result.safe)return result;
 const tasks=block.taskIds.map(id=>state.requests.find(r=>r.id===id));
 const approved={...block,
  id:crypto.randomUUID(),
  departments:[...new Set(tasks.map(t=>t.department))],
  resources:[...new Set(tasks.map(t=>t.resource).filter(r=>r!=='None'))],
  taskPlan:sequence(tasks,block.start),
  approvedBy:approvedBy.trim(),createdAt:new Date().toISOString()};
 state.blocks.push(approved);
 tasks.forEach(t=>{t.status='Scheduled';t.scheduledFor=block.date;});
 state.audit.unshift({at:new Date().toISOString(),
  message:`${approvedBy.trim()} approved ${tasks.length} task${tasks.length>1?'s':''} on ${block.date} (${tasks.map(t=>t.id).join(', ')}).`});
 return {...result,block:approved};
}

// Approval is not final. A block is withdrawn when the work is cancelled, the
// permit is refused on the day, or the plan it was built on no longer holds.
// The work orders go back on the backlog at the priority the model gives them.
export function withdrawBlock(blockId,state,withdrawnBy,reason){
 const i=state.blocks.findIndex(b=>b.id===blockId);
 if(i<0)return {ok:false,errors:[{code:'BLOCK',message:'That block is no longer on the schedule.'}]};
 if(!withdrawnBy?.trim())return {ok:false,errors:[{code:'APPROVAL',message:'Enter the withdrawing controller’s name.'}]};
 const [block]=state.blocks.splice(i,1);
 const returned=[];
 for(const id of block.taskIds){
  const t=state.requests.find(r=>r.id===id);
  if(t){t.status='Pending';delete t.scheduledFor;returned.push(t.id);}
 }
 state.audit.unshift({at:new Date().toISOString(),
  message:`${withdrawnBy.trim()} withdrew the block on ${block.date} ${block.section}; `+
   `${returned.length} work order${returned.length===1?'':'s'} returned to the backlog (${returned.join(', ')}).`+
   (reason?.trim()?` Reason: ${reason.trim()}`:'')});
 return {ok:true,block,returned};
}

// Re-run the gate over everything already committed. The world moves under a
// plan — a train runs late, a department stands down — and an approved block
// that was safe when it was granted may not be safe now.
export function revalidateSchedule(state){
 const out=[];
 for(const block of state.blocks){
  // A committed block owns its work orders, so they read as Scheduled and the
  // gate would reject the block for its own tasks. Re-check it the way the gate
  // saw it at approval: its own work pending, the block itself off the board.
  const shadow={...state,
   requests:state.requests.map(r=>block.taskIds.includes(r.id)?{...r,status:'Pending'}:r)};
  const {safe,errors}=validateBlock(block,shadow);
  if(!safe)out.push({block,errors});
 }
 return out;
}
