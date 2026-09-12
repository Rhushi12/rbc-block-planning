import {sections,lines,trains,corridorWindows} from './corridor.js';
import {PLANNING_DATE,departments,resources,assets,backlog} from './backlog.js';
import {score as priorityScore} from './priority-model.js';
export {sections,lines,trains,corridorWindows,departments,resources,assets,PLANNING_DATE};

// A corridor block is a sanctioned window in which traffic is regulated. It is
// not free: granting it costs the trains that must be cancelled or diverted.
export const corridorWindow=(line,minutes)=>corridorWindows
 .filter(w=>w.line===line&&w.minutes>=minutes)
 .sort((a,b)=>a.trainsAffected-b.trainsAffected||a.minutes-b.minutes)[0]||null;

// Blocks may run past midnight into the small hours, so compare spans in a
// two-day space: a leg at 01:00 also sits at minute 1500 of the previous day.
export const spanOverlap=(s,e,ls,le)=>
 [-1440,0,1440].some(o=>s<le+o&&ls+o<e);

export const DAY_START=0,DAY_END=1800,BUFFER=10;  // to 06:00 the following morning
export const HORIZONS={day:1,week:7,month:28};

export const time=n=>`${String(Math.floor(((n%1440)+1440)%1440/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export const minutes=s=>/^\d{2}:\d{2}$/.test(s)?Number(s.slice(0,2))*60+Number(s.slice(3)):NaN;
export const dept=code=>departments.find(d=>d.code===code);
export const deptLabel=code=>dept(code)?.label||code;
export const section=id=>sections.find(s=>s.id===id);
export const sectionName=id=>section(id)?.name||id;
export const asset=id=>assets.find(a=>a.id===id);

// A movement occupies one section of one running line per leg.
export const trainLegs=t=>Array.isArray(t.legs)?t.legs:(t.section?[{section:t.section,line:t.line||'UP',start:t.start,end:t.end}]:[]);

export const addDays=(iso,n)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export const daysBetween=(a,b)=>Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);
export const weekday=iso=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];
export const horizonDates=(from,horizon)=>Array.from({length:HORIZONS[horizon]??1},(_,i)=>addDays(from,i));

// Total line occupation for one department's share of a block: its crew sets up,
// works its tasks back to back, then clears the line.
export function streamMinutes(department,tasks){
 const d=dept(department);
 return (d?.setup??0)+tasks.reduce((n,t)=>n+t.duration,0)+(d?.clearance??0);
}
export function streams(tasks){
 const m=new Map();
 for(const t of tasks)m.set(t.department,[...(m.get(t.department)||[]),t]);
 return m;
}
export function requiredMinutes(tasks){
 let n=0;
 for(const [department,list] of streams(tasks))n=Math.max(n,streamMinutes(department,list));
 return n;
}
// Where each task actually sits inside the block, setup and clearance included.
export function sequence(tasks,start){
 const out=[];
 for(const [department,list] of streams(tasks)){
  const d=dept(department);let at=start+(d?.setup??0);
  for(const t of list){out.push({id:t.id,title:t.title,department,start:at,end:at+t.duration});at+=t.duration;}
 }
 return out.sort((a,b)=>a.start-b.start||a.department.localeCompare(b.department));
}

export const overdueOf=(r,date)=>r.overdueDays+daysBetween(PLANNING_DATE,date);
export const priorityOf=(r,date)=>priorityScore({...r,overdueDays:overdueOf(r,date)});
export const band=p=>p>=70?'Critical':p>=55?'High':p>=40?'Medium':'Low';

export function demo(){
 return {
  version:3,
  date:PLANNING_DATE,
  horizon:'day',
  requests:backlog.map(r=>({...r})),
  availability:departments.map(d=>({department:d.code,ready:true,start:DAY_START,end:DAY_END,crews:d.crews})),
  blocks:[],alerts:[],audit:[],
 };
}
