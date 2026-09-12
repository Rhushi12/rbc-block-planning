import {demo,sections,lines,trains,corridorWindows,departments,resources,assets,
        time,minutes,dept,deptLabel,section,trainLegs,addDays,weekday,HORIZONS,
        priorityOf,band,overdueOf,requiredMinutes,sequence,delayed} from './data.js';
import {validateBlock,validateRequest,approveBlock,overlaps,withdrawBlock,revalidateSchedule} from './safety.js';
import {optimize,freeIntervals,trainsAffected,separateMinutes,legIndex,search} from './planner.js';
import {explain,FEATURES,RMSE,TRAINED_ON} from './priority-model.js';

const key='rbc-v3';
let state,storageWarning='';
try{
 state=JSON.parse(localStorage.getItem(key));
 if(!state||state.version!==4||!['requests','blocks','availability','alerts','audit','delays'].every(k=>Array.isArray(state[k])))state=demo();
}catch{state=demo();storageWarning='Saved data could not be read. Reference data reloaded.';}
// The timetable is reference data; running delays are a controller overlay on
// top of it, so the working timetable is rebuilt whenever a delay changes.
const retime=()=>{state.trains=delayed(trains,state.delays);};
retime();

let page='Dashboard',horizon='day',result=null,notice=storageWarning,issues=[],
    filter='',deptFilter='',modal='',expanded=null;

const pages=['Dashboard','Block Plan','Maintenance Backlog','Corridor & Traffic',
             'Departments','Approved Schedule','Safety Alerts'];
const icon=['▦','◷','☷','⇄','▤','✓','◇'];

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pending=()=>state.requests.filter(r=>r.status==='Pending');
const taskOf=id=>state.requests.find(r=>r.id===id);
const tasksFor=b=>b.taskIds.map(taskOf).filter(Boolean);
const lineLabel=l=>l===null?'Both lines':`${l} line`;
const bandKind=b=>({Critical:'red',High:'amber',Medium:'blue',Low:'neutral'}[b]||'');
const dayLabel=d=>`${weekday(d)} ${d.slice(8)}/${d.slice(5,7)}`;
const badge=(text,kind='')=>`<span class="badge ${kind}">${esc(text)}</span>`;
const pct=n=>`${n.toFixed(0)}%`;

function save(){
 try{const {trains:_t,...rest}=state;localStorage.setItem(key,JSON.stringify(rest));}
 catch{notice='Changes are active but browser storage is unavailable. Keep this tab open.';}
}
function table(headers,rows){
 return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('')||`<tr><td colspan="${headers.length}" class="empty">No records to display.</td></tr>`}</tbody></table></div>`;
}

// ---------------------------------------------------------------- dashboard
function kpis(){
 const p=pending();
 const overdue=p.filter(r=>overdueOf(r,state.date)>0).length;
 const critical=p.filter(r=>band(priorityOf(r,state.date))==='Critical').length;
 const done=state.requests.filter(r=>r.status==='Scheduled');
 const occupied=state.blocks.reduce((n,b)=>n+(b.end-b.start),0);
 const apart=state.blocks.reduce((n,b)=>n+separateMinutes(tasksFor(b)),0);
 return [
  [p.length,'Pending work orders',`${assets.length} assets on register`],
  [overdue,'Past periodicity',`${critical} critical by model score`],
  [state.blocks.length,'Blocks approved',`${done.length} work orders scheduled`],
  [apart?pct((apart-occupied)/apart*100):'—','Line time recovered',
   apart?`${apart-occupied} min against planning apart`:'Approve a block to see this'],
 ];
}

// 24-hour occupancy strip, quantised into half-hour cells. Cheap to paint and
// it answers the question that matters: when is this line actually busy?
const CELLS=48,CELL=1440/CELLS;
function ribbon(sectionId,line,date){
 const legs=legIndex(state.trains).get(`${sectionId}|${line}`)||[];
 const load=new Array(CELLS).fill(0);
 for(const l of legs){
  const from=Math.max(0,Math.floor(l.start/CELL));
  const to=Math.min(CELLS-1,Math.floor((Math.min(l.end,1439))/CELL));
  for(let i=from;i<=to;i++)load[i]++;
 }
 const win=new Array(CELLS).fill(false);
 for(const c of corridorWindows.filter(c=>c.line===line&&c.minutes===240))
  for(let m=c.start;m<c.end;m+=CELL)win[Math.floor((m%1440)/CELL)]=true;
 const blocked=new Array(CELLS).fill(false);
 for(const bl of state.blocks.filter(x=>x.date===date&&x.section===sectionId&&(x.line===null||x.line===line)))
  for(let m=bl.start;m<bl.end;m+=CELL)blocked[Math.floor((m%1440)/CELL)]=true;
 const peak=Math.max(...load,1);
 const cells=load.map((n,i)=>{
  const cls=blocked[i]?'b':n?'t':win[i]?'w':'';
  const shade=n?0.25+0.75*(n/peak):1;
  return `<i class="${cls}"${n&&!blocked[i]?` style="opacity:${shade.toFixed(2)}"`:''}></i>`;
 }).join('');
 return `<div class="ribbon" role="img" aria-label="${legs.length} trains on ${esc(sectionId)} ${esc(line)} line, busiest half hour ${peak} trains">${cells}</div>`;
}
function corridorStrip(date){
 return `<div class="strip">
  <div class="strip-head"><span>SECTION</span><div>${[0,4,8,12,16,20].map(h=>`<span>${String(h).padStart(2,'0')}:00</span>`).join('')}</div></div>
  ${sections.map(s=>`<div class="strip-row"><div class="strip-label"><strong>${esc(s.code)}</strong><small>${s.km} km</small></div>
   <div class="strip-lines">${lines.map(l=>`<div class="lane"><b>${l}</b>${ribbon(s.id,l,date)}</div>`).join('')}</div></div>`).join('')}
 </div>`;
}

function dashboard(){
 return `<div class="page-title"><div>
   <div class="eyebrow">WESTERN RAILWAY · ${esc(sections[0].code.split('–')[0])}–${esc(sections.at(-1).code.split('–')[1])} CORRIDOR</div>
   <h1>Plan the corridor, not the department.</h1>
   <p>Maintenance demands from ${departments.map(d=>d.system).join(', ')} scheduled against the live timetable.</p></div>
  <button class="primary" data-page="Block Plan">Build a block plan <span>↗</span></button></div>
 <div class="kpis">${kpis().map(([n,t,s])=>`<article class="kpi"><span>${t}</span><strong>${n}</strong><small>${esc(s)}</small></article>`).join('')}</div>
 <section class="panel"><div class="panel-head"><div><h2>Corridor occupancy</h2>
   <p>${trains.length} timetabled trains · ${trains.reduce((n,t)=>n+trainLegs(t).length,0)} section legs · ${esc(state.date)}</p></div>
   <div class="legend"><i class="blue"></i>Train <i class="amber"></i>Sanctioned window <i class="green"></i>Approved block</div></div>
  ${corridorStrip(state.date)}
  <div class="panel-foot">Each section carries an UP and a DN running line. A block closes one line; traffic continues on the other.</div></section>
 <div class="two-col">
  <section class="panel"><div class="panel-head"><h2>Highest priority work</h2>
    <button class="text" data-page="Maintenance Backlog">Open backlog →</button></div>
   ${table(['Work order','Section','Overdue','Priority'],
     pending().sort((a,b)=>priorityOf(b,state.date)-priorityOf(a,state.date)).slice(0,5).map(r=>{
      const p=priorityOf(r,state.date),od=overdueOf(r,state.date);
      return `<tr><td><strong>${esc(r.title)}</strong><small>${esc(r.id)} · ${esc(dept(r.department).system)}</small></td>
       <td>${esc(section(r.section).code)}<small>${esc(lineLabel(r.line))}</small></td>
       <td class="num">${od>0?`${od}d`:'—'}</td><td>${badge(`${p} ${band(p)}`,bandKind(band(p)))}</td></tr>`;}))}</section>
  <section class="panel"><div class="panel-head"><h2>Departments</h2>
    <button class="text" data-page="Departments">Manage →</button></div>
   ${departments.map(d=>{const a=state.availability.find(x=>x.department===d.code);
    const n=pending().filter(r=>r.department===d.code).length;
    return `<div class="dept-row"><span class="dept-icon">${esc(d.system.slice(0,3))}</span>
     <div><strong>${esc(d.label)}</strong><small>${n} pending · ${a.crews} crew${a.crews>1?'s':''} · +${d.setup}/${d.clearance} min</small></div>
     ${badge(a.ready?'On duty':'Off duty',a.ready?'green':'red')}</div>`;}).join('')}</section></div>`;
}

// ------------------------------------------------------------- block planner
function planCard(p,i){
 const v=validateBlock(p,state);
 const regulated=p.corridor?trainsAffected(p,state):0;
 return `<article class="panel rec ${p.corridor?'corridor':''}">
  <div class="panel-head"><div>
    <span class="eyebrow">${esc(dayLabel(p.date))} · ${esc(section(p.section).code)} · ${esc(lineLabel(p.line))}</span>
    <h2>${time(p.start)} — ${time(p.end)}${p.end>=1440?' <em>+1</em>':''}</h2>
    <p>${p.end-p.start} min possession · ${p.taskIds.length} work order${p.taskIds.length>1?'s':''}</p></div>
   <div class="rec-tags">${p.corridor
     ?badge(`Corridor block · ${regulated} trains regulated`,'amber')
     :badge(`Natural window · ${p.rationale.headroom} min clearance`,'green')}
    ${badge(v.safe?'Validated':'Conflict',v.safe?'green':'red')}</div></div>
  <div class="rec-body">
   <div class="rec-plan">${sequence(tasksFor(p),p.start).map(t=>`<div class="chip">
     <em>${time(t.start)}–${time(t.end)}</em><b>${esc(deptLabel(t.department))}</b><span>${esc(t.title)}</span></div>`).join('')}
    <div class="rec-why"><strong>Why this window</strong>
     <span>${p.rationale.tasks} order${p.rationale.tasks>1?'s':''} in one possession — ${p.rationale.saved} min less line time than planning them apart</span>
     <span>${p.rationale.overhead} min of protection and clearance, paid once instead of ${p.taskIds.length} times</span>
     <span>${p.corridor
       ?`sanctioned corridor window — ${regulated} trains cancelled, diverted or rescheduled`
       :`fits existing traffic — no train affected, ${p.rationale.headroom} min clearance`}</span></div></div>
   <div class="rec-act">
    ${v.safe?'<p class="ok">All hard rules pass against current data.</p>'
            :`<div class="err">${v.errors.slice(0,4).map(e=>`<p>${esc(e.message)}</p>`).join('')}</div>`}
    <div class="button-row">
     <label class="prefer">Prefer start<input type="time" id="prefer-${i}" value="${time(p.start)}"></label>
     <button data-replan="${i}">Move window</button>
     <button data-reject="${i}">Reject</button>
     <button class="primary" data-approve="${i}">Review &amp; approve</button></div></div></div></article>`;
}

function blockPlan(){
 const grouped={};
 for(const p of result?.plans||[])(grouped[p.date]=grouped[p.date]||[]).push(p);
 const s=result?.summary;
 return `<div class="page-title"><div><h1>Block plan</h1>
   <p>Work orders ranked by the priority model, then packed into the fewest safe possessions.</p></div>
  <div class="controls"><div class="segmented" role="group" aria-label="Planning horizon">
    ${Object.keys(HORIZONS).map(h=>`<button data-horizon="${h}" class="${horizon===h?'on':''}">${h[0].toUpperCase()+h.slice(1)}<small>${HORIZONS[h]}d</small></button>`).join('')}</div>
   <button class="primary" data-action="plan">✧ Generate plan</button></div></div>
 ${s?`<div class="summary">
   <span><strong>${s.blocks}</strong>blocks</span><span><strong>${s.tasks}</strong>work orders</span>
   <span><strong>${s.blocksReduced}</strong>possessions avoided</span>
   <span><strong>${s.lineMinutesSaved}</strong>min recovered</span>
   <span><strong>${s.availabilityGain}%</strong>availability gain</span>
   <span class="muted"><strong>${s.deferred}</strong>deferred</span></div>`:''}
 ${!result?`<div class="empty-state"><span>✧</span><h2>Choose a horizon and generate.</h2>
   <p>${pending().length} pending work orders across ${sections.length} sections and ${assets.length} assets.
   A day plan uses the gaps the timetable already leaves; week and month plans reach for sanctioned corridor windows.</p></div>`:''}
 ${Object.entries(grouped).map(([date,ps])=>`<div class="day-group">
   <div class="day-head"><h3>${esc(dayLabel(date))}</h3>
    <span>${ps.length} block${ps.length>1?'s':''} · ${ps.reduce((n,p)=>n+p.taskIds.length,0)} work orders</span></div>
   ${ps.map(p=>planCard(p,result.plans.indexOf(p))).join('')}</div>`).join('')}
 ${result?.unplaced.length?`<section class="panel deferred"><div class="panel-head"><div><h2>Deferred — ${result.unplaced.length} work orders</h2>
   <p>${result.summary.deferredStructural} need an extended traffic block · ${result.summary.deferredCapacity} ran out of crew or window capacity</p></div></div>
   ${table(['Work order','Section','Needs','Why deferred'],result.unplaced.slice(0,12).map(u=>
    `<tr><td><strong>${esc(u.title)}</strong><small>${esc(u.id)} · ${esc(deptLabel(u.department))}</small></td>
     <td>${esc(section(u.section).code)}<small>${esc(lineLabel(u.line))}</small></td>
     <td class="num">${requiredMinutes([u])} min</td>
     <td><small>${esc(u.reason)}</small></td></tr>`))}</section>`:''}`;
}

// ------------------------------------------------------------------ backlog
function driverBars(r){
 const parts=explain({...r,overdueDays:overdueOf(r,state.date)});
 const max=Math.max(...parts.map(p=>Math.abs(p.contribution)),1);
 return `<div class="drivers-box"><strong>What drives this score</strong>
  ${parts.map(p=>`<div class="driver"><span>${esc(p.name)}</span>
    <div class="bar"><i class="${p.contribution<0?'neg':'pos'}" style="width:${Math.abs(p.contribution)/max*100}%"></i></div>
    <b class="${p.contribution<0?'neg':'pos'}">${p.contribution>0?'+':''}${p.contribution.toFixed(1)}</b></div>`).join('')}
  <small>Exact for a linear model: coefficient × (feature − training mean). The parts sum to this order's score above the baseline.</small></div>`;
}

function backlogPage(){
 const rows=state.requests.filter(r=>
   (!deptFilter||r.department===deptFilter)&&
   (!filter||`${r.title} ${r.id} ${r.defect||''} ${section(r.section).code}`.toLowerCase().includes(filter.toLowerCase())))
  .sort((a,b)=>priorityOf(b,state.date)-priorityOf(a,state.date));
 return `<div class="page-title"><div><h1>Maintenance backlog</h1>
   <p>Defects and overdue maintenance from ${departments.map(d=>d.system).join(', ')}, ranked by the priority model.</p></div>
  <button class="primary" data-modal="request">+ Raise work order</button></div>
 <div class="model-note"><strong>Priority model</strong>
  <span>Ridge-regularised linear fit · ${TRAINED_ON.toLocaleString()} historical decisions · RMSE ${RMSE} of 100</span>
  <span>${FEATURES.join(' · ')}</span>
  <span class="warn">Trained on synthetic history pending access to real TMS/SMMS/TDMS records.</span></div>
 <section class="panel"><div class="panel-head"><h2>${rows.length} work orders</h2>
   <div class="filters"><div class="segmented small">
     <button data-dept="" class="${deptFilter===''?'on':''}">All</button>
     ${departments.map(d=>`<button data-dept="${d.code}" class="${deptFilter===d.code?'on':''}">${esc(d.system)}</button>`).join('')}</div>
    <input id="search" type="search" placeholder="Search activity, defect or section" aria-label="Search backlog" value="${esc(filter)}"></div></div>
  ${table(['Work order','Section','Due','Duration','Priority',''],rows.slice(0,60).flatMap(r=>{
   const p=priorityOf(r,state.date),od=overdueOf(r,state.date),open=expanded===r.id;
   return [`<tr class="${open?'open':''}"><td><strong>${esc(r.title)}</strong>
     <small>${esc(r.id)} · ${esc(r.asset)} · ${esc(dept(r.department).system)}</small>
     ${r.defect?`<small class="defect">⚠ ${esc(r.defect)} · severity ${r.severity}</small>`:''}</td>
    <td>${esc(section(r.section).code)}<small>${esc(lineLabel(r.line))}</small></td>
    <td class="num">${od>0?`<b class="late">${od}d late</b>`:`in ${-od}d`}<small>every ${r.periodicity}d</small></td>
    <td class="num">${r.duration} min<small>+${dept(r.department).setup}/${dept(r.department).clearance}</small></td>
    <td>${r.emergency?badge('Emergency','red'):''}${badge(`${p} ${band(p)}`,bandKind(band(p)))}${r.status!=='Pending'?badge(r.status,'green'):''}</td>
    <td><button class="text" data-explain="${esc(r.id)}">${open?'Hide':'Why?'}</button></td></tr>`,
    open?`<tr class="drivers"><td colspan="6">${driverBars(r)}</td></tr>`:''];}))}
  ${rows.length>60?`<div class="panel-foot">Showing the 60 highest-priority of ${rows.length}. Narrow with search or department.</div>`:''}</section>`;
}

// ------------------------------------------------------------------ corridor
function corridorPage(){
 return `<div class="page-title"><div><h1>Corridor &amp; traffic</h1>
   <p>Real Western Railway timetable · ${trains.length} trains · DataMeet Indian Railways dataset (CC0).</p></div></div>
 <section class="panel"><div class="panel-head"><div><h2>Sanctioned corridor windows</h2>
   <p>The lowest-disruption band on each running line, with the traffic it costs to grant.</p></div></div>
  ${table(['Running line','Window','Length','Trains regulated'],corridorWindows.map(w=>
   `<tr><td><strong>${esc(w.line)} line</strong></td><td class="num">${time(w.start)}–${time(w.end)}${w.end>=1440?' +1':''}</td>
    <td class="num">${w.minutes} min</td><td class="num">${w.trainsAffected}</td></tr>`))}
  <div class="panel-foot">Found by sliding each band across the timetable and taking the minimum. A corridor-wide band regulates a train once, not once per section.</div></section>
 <section class="panel"><div class="panel-head"><h2>Section register</h2></div>
  ${table(['Section','Length','UP line','DN line','Longest natural window'],sections.map(s=>{
   const up=(legIndex(state.trains).get(`${s.id}|UP`)||[]).length;
   const dn=(legIndex(state.trains).get(`${s.id}|DN`)||[]).length;
   const best=Math.max(...lines.map(l=>Math.max(...freeIntervals(state,s.id,l,state.date,0,1440).map(([a,b])=>b-a),0)));
   return `<tr><td><strong>${esc(s.name)}</strong><small>${esc(s.code)}</small></td><td class="num">${s.km} km</td>
    <td class="num">${up} trains</td><td class="num">${dn} trains</td><td class="num">${best} min</td></tr>`;}))}
  <div class="panel-foot">The longest gap the timetable leaves open anywhere is barely two hours, which is why heavy work needs a sanctioned corridor window.</div></section>
 <section class="panel"><div class="panel-head"><div><h2>Running delays</h2>
   <p>Put a train off its booked path and re-run the gate across every approved block.</p></div>
   ${state.delays.length?'<button data-action="clear-delays">Clear all delays</button>':''}</div>
  <form class="form-body" data-delay="1">
   <div class="form-grid">
    <label>Train<select name="train">${options(trains,null,t=>`${t.id} ${t.name}`,t=>t.id)}</select></label>
    <label>Running late by (minutes)<input name="minutes" type="number" min="5" max="240" value="30" required></label></div>
   <button type="submit">Apply delay and re-check the schedule</button></form>
  ${state.delays.length?table(['Train','Running late by'],state.delays.map(d=>{
    const t=trains.find(x=>x.id===d.train);
    return `<tr><td><strong>${esc(d.train)}</strong><small>${esc(t?.name||'')}</small></td><td class="num">${d.minutes} min</td></tr>`;})):''}
  <div class="panel-foot">A delay moves every leg of that train later by the same minutes. Approved blocks are re-validated straight away; any that stop clearing the gate are raised in Safety Alerts.</div></section>`;
}

// --------------------------------------------------------------- departments
function departmentsPage(){
 return `<div class="page-title"><div><h1>Departments</h1>
   <p>Crew strength and shift hours feed the next plan and are checked against approved blocks.</p></div></div>
 <div class="dept-grid">${departments.map(d=>{const a=state.availability.find(x=>x.department===d.code);
  const n=pending().filter(r=>r.department===d.code).length;
  return `<form class="panel dept-form" data-dept="${d.code}">
   <div class="panel-head"><div><h2>${esc(d.label)}</h2><small>Source system ${esc(d.system)}</small></div>
    ${badge(a.ready?'On duty':'Off duty',a.ready?'green':'red')}</div>
   <div class="form-body">
    <div class="stat-row"><span>${n}<small>pending</small></span><span>${d.setup}<small>min setup</small></span>
     <span>${d.clearance}<small>min clearance</small></span></div>
    <label class="check"><input name="ready" type="checkbox" ${a.ready?'checked':''}> Available for block work</label>
    <div class="form-grid">
     <label>Shift from<input name="start" type="time" value="${time(a.start)}" required></label>
     <label>Shift until<input name="end" type="time" value="${time(Math.min(a.end,1439))}" required></label>
     <label>Crews on duty<input name="crews" type="number" min="1" max="8" value="${a.crews}" required></label></div>
    <small class="hint">${a.crews} crew${a.crews>1?'s':''} can hold ${a.crews} block${a.crews>1?'s':''} at once across the division.
     ${d.setup+d.clearance} min of every possession is protection and clearance, not work.</small>
    <button type="submit">Save</button></div></form>`;}).join('')}</div>`;
}

// ----------------------------------------------------------------- schedule
function schedulePage(){
 const occupied=state.blocks.reduce((n,b)=>n+(b.end-b.start),0);
 const apart=state.blocks.reduce((n,b)=>n+separateMinutes(tasksFor(b)),0);
 return `<div class="page-title"><div><h1>Approved schedule</h1>
   <p>${state.blocks.length} sanctioned possessions · human approval on record.</p></div>
  <button data-action="export" ${state.blocks.length?'':'disabled'}>Export CSV</button></div>
 ${state.blocks.length?`<div class="summary"><span><strong>${state.blocks.length}</strong>blocks</span>
   <span><strong>${state.blocks.reduce((n,b)=>n+b.taskIds.length,0)}</strong>work orders</span>
   <span><strong>${apart-occupied}</strong>min recovered</span>
   <span><strong>${pct((apart-occupied)/apart*100)}</strong>against planning apart</span></div>`:''}
 <section class="panel">${table(['Date','Section / line','Window','Work','Approved by',''],
  state.blocks.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start).map(b=>
   `<tr><td><strong>${esc(dayLabel(b.date))}</strong><small>${esc(b.date)}</small></td>
    <td>${esc(section(b.section).code)}<small>${esc(lineLabel(b.line))}${b.corridor?' · corridor block':''}</small></td>
    <td class="num">${time(b.start)}–${time(b.end)}<small>${b.end-b.start} min</small></td>
    <td>${b.taskIds.length} order${b.taskIds.length>1?'s':''}<small>${esc(tasksFor(b).map(t=>t.title).join(' · ').slice(0,64))}</small></td>
    <td>${esc(b.approvedBy)}<small>${esc(String(b.createdAt).slice(0,16).replace('T',' '))}</small></td>
    <td><button class="text" data-withdraw="${esc(b.id)}">Withdraw</button></td></tr>`))}</section>
 ${state.blocks.length?'':'<div class="empty-state"><h2>Nothing approved yet.</h2><p>Generate a block plan and approve a window to populate the schedule.</p><button data-page="Block Plan">Open block plan</button></div>'}`;
}

// ------------------------------------------------------------------- alerts
function alertsPage(){
 return `<div class="page-title"><div><h1>Safety alerts</h1>
   <p>${state.alerts.length} recorded conflicts. A rejected candidate never reaches the schedule.</p></div></div>
 ${state.alerts.length?state.alerts.map(a=>`<section class="panel alert"><span class="alert-mark">!</span>
   <div><h2>${esc(a.title)}</h2><p>${esc(a.message)}</p><small>${esc(a.at)}</small></div>${badge('Blocked','red')}</section>`).join('')
  :'<div class="empty-state"><h2>No conflicts recorded.</h2><p>Approve a stale recommendation to watch the gate reject it.</p></div>'}
 <section class="panel"><div class="panel-head"><h2>Approval activity</h2></div>
  ${state.audit.map(a=>`<div class="audit"><strong>${esc(a.message)}</strong><small>${esc(String(a.at).slice(0,19).replace('T',' '))}</small></div>`).join('')
   ||'<p class="empty">No approvals in this session.</p>'}</section>`;
}

// ------------------------------------------------------------------- modals
const options=(items,value,labelOf=x=>x,valueOf=x=>x)=>
 items.map(x=>`<option value="${esc(valueOf(x))}" ${value===valueOf(x)?'selected':''}>${esc(labelOf(x))}</option>`).join('');

function modalContent(){
 if(!modal)return '';
 let c='';
 if(modal==='request')c=`<h2>Raise a work order</h2>
  <label>Activity<input name="title" required maxlength="120" placeholder="e.g. Ultrasonic rail flaw testing"></label>
  <div class="form-grid">
   <label>Section<select name="section">${options(sections,null,s=>s.name,s=>s.id)}</select></label>
   <label>Running line<select name="line"><option value="UP">UP</option><option value="DN">DN</option><option value="">Both (section-wide)</option></select></label>
   <label>Department<select name="department">${options(departments,null,d=>`${d.label} (${d.system})`,d=>d.code)}</select></label>
   <label>Machinery<select name="resource"><option>None</option>${options(resources)}</select></label>
   <label>Work minutes<input name="duration" type="number" min="5" max="480" value="45" required></label>
   <label>Periodicity (days)<input name="periodicity" type="number" min="1" max="3650" value="90" required></label>
   <label>Days overdue<input name="overdueDays" type="number" min="-365" max="999" value="0" required></label>
   <label>Defect severity<select name="severity"><option value="0">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label></div>
  <label class="check"><input name="emergency" type="checkbox"> Emergency &mdash; plan ahead of the model ranking</label>
  <button class="primary" type="submit">Add to backlog</button>`;
 if(modal.startsWith('approve:')){
  const p=result.plans[Number(modal.split(':')[1])];
  const regulated=p.corridor?trainsAffected(p,state):0;
  c=`<h2>Human approval</h2>
   <p>${esc(dayLabel(p.date))} · ${esc(section(p.section).name)} · ${esc(lineLabel(p.line))}<br>
    ${time(p.start)}–${time(p.end)} · ${p.taskIds.length} work order${p.taskIds.length>1?'s':''}</p>
   ${p.corridor?`<div class="warn-box">This is a corridor block. Granting it regulates <strong>${regulated} train${regulated===1?'':'s'}</strong>.</div>`:''}
   <p>Safety checks run again when you confirm.</p>
   <label>Approving controller<input name="controller" maxlength="80" required placeholder="Name and designation"></label>
   <label class="check"><input type="checkbox" required> I have reviewed this demonstration block.</label>
   <button class="primary" type="submit">Confirm approval</button>`;
 }
 if(modal.startsWith('withdraw:')){
  const b=state.blocks.find(x=>x.id===modal.slice(9));
  c=b?`<h2>Withdraw this block</h2>
   <p>${esc(dayLabel(b.date))} · ${esc(section(b.section).code)} · ${time(b.start)}–${time(b.end)}</p>
   <div class="warn-box">${b.taskIds.length} work order${b.taskIds.length===1?'':'s'} return to the backlog and are ranked again on the next plan.</div>
   <label>Withdrawing controller<input name="controller" maxlength="80" required placeholder="Name and designation"></label>
   <label>Reason<input name="reason" maxlength="120" placeholder="e.g. permit refused on the day"></label>
   <button class="primary" type="submit">Withdraw block</button>`
   :'<h2>Block not found</h2><p>It may already have been withdrawn.</p>';
 }
 if(modal==='export'){
  const rows=[['Date','Section','Line','Start','End','Minutes','Corridor block','Work orders','Approved by'],
   ...state.blocks.map(b=>[b.date,section(b.section).code,b.line??'BOTH',time(b.start),time(b.end),
     b.end-b.start,b.corridor?'Yes':'No',b.taskIds.join(' / '),b.approvedBy])];
  const csv=rows.map(r=>r.map(x=>'"'+String(x).replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');
  c=`<h2>Export approved schedule</h2><p>Download the CSV, or copy it below.</p>
   <a class="download" download="rbc-blocks-${esc(state.date)}.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csv)}">Download CSV</a>
   <label>Schedule CSV<textarea readonly rows="8">${esc(csv)}</textarea></label>`;
 }
 if(modal==='reset')c=`<h2>Reset the demonstration?</h2>
  <p>Clears approvals, alerts and local edits, and reloads the backlog from the reference data.</p>
  <button class="primary" type="submit">Reset</button>`;
 return `<dialog open aria-modal="true" aria-labelledby="dlg"><form id="modal-form">
  <button type="button" class="close" data-action="close" aria-label="Close">×</button>
  <div>${c.replace('<h2>','<h2 id="dlg">')}</div><div id="form-error" role="alert"></div></form></dialog><div class="scrim"></div>`;
}

// ------------------------------------------------------------------- render
function render(){
 const body={Dashboard:dashboard,'Block Plan':blockPlan,'Maintenance Backlog':backlogPage,
  'Corridor & Traffic':corridorPage,Departments:departmentsPage,
  'Approved Schedule':schedulePage,'Safety Alerts':alertsPage}[page];
 document.querySelector('#app').innerHTML=`
  <aside><a class="brand" href="#Dashboard"><span class="mark">≋</span><div>RBC<small>BLOCK PLANNING</small></div></a>
   <div class="ws">OPERATIONS WORKSPACE</div>
   <nav>${pages.map((p,i)=>`<button data-page="${p}" class="${page===p?'active':''}">
     <span aria-hidden="true">${icon[i]}</span>${p}${p==='Safety Alerts'&&state.alerts.length?`<b>${state.alerts.length}</b>`:''}</button>`).join('')}</nav>
   <div class="side-foot"><div class="tag">DEMONSTRATION MODE</div>
    <p>SIH26027 · Ministry of Railways<br>Local planning sandbox</p>
    <button data-modal="reset">↻ Reset data</button></div></aside>
  <div class="shell">
   <header><div>Operations <span>/</span> <strong>${esc(page)}</strong></div>
    <div class="head-right"><span>${esc(state.date)} · IST</span><span class="avatar">DC</span>
     <div>Demo controller<small>Approval authority</small></div></div></header>
   <main>
    ${notice?`<div class="notice" role="status">${esc(notice)}<button data-action="dismiss" aria-label="Dismiss">×</button></div>`:''}
    ${issues.length?`<div class="err block" role="alert"><strong>Safety gate blocked this action</strong>
      ${issues.map(e=>`<p>${esc(e.message||e)}</p>`).join('')}</div>`:''}
    ${body()}</main>
   <footer><span class="shield">◇</span>AI ranks and packs. Hard rules and authorised human approval have final say.
    <span>PROTOTYPE · NOT FOR RAILWAY CONTROL</span></footer></div>
  ${modalContent()}`;
 if(modal)setTimeout(()=>document.querySelector('dialog input,dialog textarea,dialog button[type=submit],dialog a')?.focus(),0);
}

function record(title,errors){
 const signature=title+'|'+errors.map(e=>e.message).join('|');
 if(state.alerts.some(a=>a.signature===signature))return;
 state.alerts.unshift({signature,title,message:errors.map(e=>e.message).join(' '),
  at:new Date().toLocaleString('en-IN')});
 save();
}
function generate(){
 issues=[];
 const t0=performance.now();
 result=optimize(pending().map(r=>r.id),state,{horizon,from:state.date});
 const ms=Math.round(performance.now()-t0);
 notice=result.plans.length
  ?`${result.summary.blocks} blocks covering ${result.summary.tasks} work orders, computed in ${ms} ms. Review each window before approval.`
  :'No safe window found. Check department readiness and crew strength.';
 render();
}

// -------------------------------------------------------------------- events
document.addEventListener('click',e=>{
 const el=e.target.closest('button,a');
 if(!el)return;
 if(el.dataset.page){page=el.dataset.page;filter='';issues=[];expanded=null;
  history.replaceState(null,'','#'+encodeURIComponent(page));render();return;}
 if(el.dataset.modal){modal=el.dataset.modal;render();return;}
 if(el.dataset.horizon){horizon=el.dataset.horizon;result=null;render();return;}
 if(el.dataset.dept!==undefined&&!el.closest('form')){deptFilter=el.dataset.dept;render();return;}
 if(el.dataset.explain){expanded=expanded===el.dataset.explain?null:el.dataset.explain;render();return;}
 if(el.dataset.withdraw){modal='withdraw:'+el.dataset.withdraw;issues=[];render();return;}
 if(el.dataset.replan!==undefined){
  const i=Number(el.dataset.replan),p=result.plans[i];
  const want=minutes(document.querySelector('#prefer-'+i)?.value||'');
  const out=search(p.taskIds,state,p.date,Number.isInteger(want)?want:undefined);
  if(!out.block){
   issues=[{message:'No window near that time satisfies every hard rule. The recommendation is unchanged.'}];
   render();return;}
  out.block.blockNo=p.blockNo;result.plans[i]=out.block;issues=[];
  notice=`Window moved to ${time(out.block.start)}–${time(out.block.end)}. Every hard rule was checked again.`;
  render();return;}
 if(el.dataset.reject!==undefined){
  result.plans.splice(Number(el.dataset.reject),1);
  result.summary.blocks=result.plans.length;
  issues=[];notice='Recommendation rejected. Nothing was scheduled.';render();return;}
 if(el.dataset.approve!==undefined){
  const i=Number(el.dataset.approve),v=validateBlock(result.plans[i],state);
  if(!v.safe){record('Unsafe approval attempt',v.errors);issues=v.errors;
   notice='The gate rejected this window against current data.';render();return;}
  modal='approve:'+i;render();return;}
 const a=el.dataset.action;
 if(a==='plan')generate();
 if(a==='dismiss'){notice='';render();}
 if(a==='close'){modal='';render();}
 if(a==='export'){modal='export';render();}
 if(a==='clear-delays'){state.delays=[];retime();result=null;save();
  notice='Running delays cleared. The plan is back on the booked timetable.';render();}
});

document.addEventListener('input',e=>{
 if(e.target.id==='search'){
  filter=e.target.value;const pos=e.target.selectionStart;render();
  const s=document.querySelector('#search');s.focus();
  if(s.type!=='search')s.setSelectionRange(pos,pos);}
});

document.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&modal){modal='';render();return;}
 if(e.key==='Tab'&&modal){
  const c=[...document.querySelectorAll('dialog button,dialog input,dialog select,dialog textarea,dialog a')];
  const first=c[0],last=c.at(-1);
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
});

document.addEventListener('submit',e=>{
 e.preventDefault();
 const form=e.target,data=Object.fromEntries(new FormData(form));
 let errors=[];

 if(form.dataset.dept){
  const d=form.dataset.dept;
  const up={department:d,ready:data.ready==='on',start:minutes(data.start),
   end:minutes(data.end),crews:Number(data.crews)};
  if(!Number.isInteger(up.start)||!Number.isInteger(up.end)||up.end<=up.start)
   errors.push('Shift end must come after shift start.');
  if(!Number.isInteger(up.crews)||up.crews<1||up.crews>8)errors.push('Crews must be a whole number from 1 to 8.');
  const committed=state.blocks.filter(b=>b.departments?.includes(d));
  const peak=committed.reduce((n,b)=>Math.max(n,committed.filter(o=>overlaps(b.start,b.end,o.start,o.end)).length),0);
  if(Number.isInteger(up.crews)&&up.crews<peak)errors.push(`${peak} approved blocks already run this department at once.`);
  if(committed.some(b=>!up.ready||b.start<up.start||b.end>up.end))
   errors.push('This change would invalidate an approved block.');
  if(!errors.length){
   state.availability=state.availability.map(x=>x.department===d?{...x,...up}:x);
   result=null;save();notice=`${deptLabel(d)} updated. Generate the plan again to use it.`;}
  issues=errors.map(m=>({message:m}));render();return;}

 if(form.dataset.delay){
  const m=Number(data.minutes);
  if(!Number.isInteger(m)||m<5||m>240)errors.push('A delay must be a whole number of minutes from 5 to 240.');
  if(!errors.length){
   state.delays=[...state.delays.filter(d=>d.train!==data.train),{train:data.train,minutes:m}];
   retime();
   const broken=revalidateSchedule(state);
   for(const b of broken)
    record(`Approved block on ${b.block.date} no longer clears the gate`,b.errors);
   result=null;save();
   notice=broken.length
    ?`${data.train} running ${m} min late. ${broken.length} approved block${broken.length===1?'':'s'} stopped clearing the gate — see Safety Alerts.`
    :`${data.train} running ${m} min late. Every approved block still clears the gate.`;}
  issues=errors.map(x=>({message:x}));render();return;}

 if(modal==='request'){
  const r={id:'MR-'+crypto.randomUUID().slice(0,6).toUpperCase(),asset:'MANUAL',
   title:String(data.title).trim(),section:data.section,line:data.line||null,
   department:data.department,duration:Number(data.duration),resource:data.resource,
   periodicity:Number(data.periodicity),overdueDays:Number(data.overdueDays),
   dueOn:addDays(state.date,-Number(data.overdueDays)),
   defect:Number(data.severity)?'Reported on intake':null,severity:Number(data.severity),
   criticality:0.8,traffic:0.6,emergency:data.emergency==='on',status:'Pending'};
  errors=validateRequest(r,state);
  if(!errors.length){state.requests.push(r);result=null;
   notice=r.emergency
    ?`${r.id} raised as an emergency. It is placed ahead of the model ranking — generate the plan again.`
    :`${r.id} added to the backlog.`;}}

 if(modal.startsWith('approve:')){
  const i=Number(modal.split(':')[1]);
  const out=approveBlock(result.plans[i],state,data.controller);
  errors=out.errors.map(x=>x.message);
  if(!errors.length){
   result.plans.splice(i,1);
   result.summary.blocks=result.plans.length;
   issues=[];notice='Block approved and added to the schedule.';}
  else record('Approval blocked by final validation',out.errors);}

 if(modal.startsWith('withdraw:')){
  const out=withdrawBlock(modal.slice(9),state,data.controller,data.reason);
  errors=(out.errors||[]).map(x=>x.message);
  if(out.ok){result=null;
   notice=`Block withdrawn. ${out.returned.length} work order${out.returned.length===1?'':'s'} back on the backlog.`;}}

 if(modal==='reset'){state=demo();retime();result=null;issues=[];
  page='Dashboard';history.replaceState(null,'','#Dashboard');notice='Reference data restored.';}

 if(errors.length){document.querySelector('#form-error').innerHTML=errors.map(x=>`<p>${esc(x)}</p>`).join('');return;}
 save();modal='';render();
});

try{const initial=decodeURIComponent(location.hash.slice(1));if(pages.includes(initial))page=initial;}catch{}
window.addEventListener('hashchange',()=>{
 const p=decodeURIComponent(location.hash.slice(1));
 if(pages.includes(p)){page=p;render();}
});
render();
