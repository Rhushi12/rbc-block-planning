import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {demo,trains,sections,corridorWindows,assets,departments,resources,
        priorityOf,band,HORIZONS,delayed} from './dist/data.js';
import {optimize,search,freeIntervals,trainsAffected} from './dist/planner.js';
import {validateBlock,approveBlock,withdrawBlock,revalidateSchedule} from './dist/safety.js';
import {explain,FEATURES,RMSE,TRAINED_ON} from './dist/priority-model.js';

const root=path.resolve('dist');
const port=Number(process.env.PORT)||5173;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const LIMIT=1024*1024;

const send=(res,code,body)=>{
 res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify(body));
};
function readBody(req){
 return new Promise((resolve,reject)=>{
  let size=0;const parts=[];
  req.on('data',c=>{size+=c.length;
   if(size>LIMIT){reject(new Error('Request body is larger than 1 MB.'));req.destroy();return;}
   parts.push(c);});
  req.on('end',()=>{try{resolve(parts.length?JSON.parse(Buffer.concat(parts)):{});}
   catch{reject(new Error('Body must be valid JSON.'));}});
  req.on('error',reject);
 });
}
// A posted state is untrusted input; reject anything the planner cannot walk safely.
function readState(input){
 const base=demo();base.trains=trains;
 const s=input&&typeof input==='object'&&input.state&&typeof input.state==='object'?input.state:base;
 for(const k of ['requests','blocks','availability'])
  if(!Array.isArray(s[k]))throw new Error(`state.${k} must be an array.`);
 const delays=Array.isArray(s.delays)?s.delays:[];
 const timetable=Array.isArray(s.trains)&&s.trains.length?s.trains:trains;
 return {...s,trains:delayed(timetable,delays),delays,
   alerts:Array.isArray(s.alerts)?s.alerts:[],audit:Array.isArray(s.audit)?s.audit:[],
   date:s.date||base.date};
}
const horizonOf=v=>Object.hasOwn(HORIZONS,v)?v:'day';

const api={
 'GET /api/health':()=>({ok:true,service:'rbc-block-planning',port,
   corridor:`${sections[0].code.split('–')[0]}–${sections.at(-1).code.split('–')[1]}`,
   sections:sections.length,trains:trains.length,assets:assets.length}),

 // Everything the planner reads: corridor, timetable, register, backlog.
 'GET /api/reference':()=>({sections,corridorWindows,departments,resources,
   assets:assets.length,model:{features:FEATURES,rmse:RMSE,trainedOn:TRAINED_ON}}),
 'GET /api/demo':()=>{const s=demo();s.trains=trains;return s;},

 // Rank the backlog. This is the prioritisation the problem statement asks for.
 'POST /api/prioritise':input=>{const state=readState(input);
  return {date:state.date,model:{features:FEATURES,rmse:RMSE,trainedOn:TRAINED_ON},
   requests:state.requests.filter(r=>r.status==='Pending')
    .map(r=>({id:r.id,asset:r.asset,title:r.title,section:r.section,line:r.line,
      department:r.department,overdueDays:r.overdueDays,severity:r.severity,
      defect:r.defect,priority:priorityOf(r,state.date),
      band:band(priorityOf(r,state.date)),drivers:explain(r)}))
    .sort((a,b)=>b.priority-a.priority)};},

 // Build block plans over a day, week or month.
 'POST /api/plan':input=>{const state=readState(input);
  const horizon=horizonOf(input.horizon||state.horizon);
  const ids=Array.isArray(input.ids)&&input.ids.length
    ?input.ids:state.requests.filter(r=>r.status==='Pending').map(r=>r.id);
  const result=optimize(ids,state,{horizon,from:input.from||state.date});
  return {...result,plans:result.plans.map(p=>({...p,trainsRegulated:trainsAffected(p,state)}))};},

 // Windows the timetable already leaves open on one section and running line.
 'POST /api/windows':input=>{const state=readState(input);
  if(!sections.some(s=>s.id===input.section))throw new Error('Provide a valid section id.');
  const line=input.line===null?null:(input.line||'UP');
  return {section:input.section,line,date:input.date||state.date,
   free:freeIntervals(state,input.section,line,input.date||state.date)
     .map(([start,end])=>({start,end,minutes:end-start})),
   corridorWindows:corridorWindows.filter(w=>line===null||w.line===line)};},

 // The same hard-rule gate the browser uses.
 'POST /api/validate':input=>{const state=readState(input);
  if(!input.block||typeof input.block!=='object')throw new Error('Provide a block object.');
  return {...validateBlock(input.block,state),trainsRegulated:trainsAffected(input.block,state)};},

 'POST /api/approve':input=>{const state=readState(input);
  if(!input.block||typeof input.block!=='object')throw new Error('Provide a block object.');
  const result=approveBlock(input.block,state,input.approvedBy);
  return {...result,blocks:state.blocks,audit:state.audit};},

 // Approval is reversible. Withdrawing returns the work orders to the backlog.
 'POST /api/withdraw':input=>{const state=readState(input);
  if(!input.blockId)throw new Error('Provide blockId.');
  const result=withdrawBlock(input.blockId,state,input.withdrawnBy,input.reason);
  return {...result,blocks:state.blocks,audit:state.audit};},

 // Re-run the gate across the committed schedule, optionally against delayed
 // traffic: POST {"delays":[{"train":"12009","minutes":45}]}.
 'POST /api/revalidate':input=>{const state=readState(input);
  if(Array.isArray(input.delays)){
   state.delays=input.delays;
   state.trains=delayed(trains,input.delays);}
  const conflicts=revalidateSchedule(state);
  return {date:state.date,delays:state.delays,checked:state.blocks.length,
   safe:conflicts.length===0,
   conflicts:conflicts.map(c=>({block:c.block.id,date:c.block.date,section:c.block.section,
     start:c.block.start,end:c.block.end,errors:c.errors}))};},
};

http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const route=`${req.method} ${url.pathname}`;
  const handler=api[route];
  if(!handler)return send(res,404,{error:`Unknown endpoint ${route}.`,endpoints:Object.keys(api)});
  try{return send(res,200,handler(req.method==='POST'?await readBody(req):{}));}
  catch(e){return send(res,400,{error:e.message});}
 }
 try{
  const pathname=decodeURIComponent(url.pathname);
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  const data=await readFile(file);
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream',
    'Cache-Control':'no-cache'});
  res.end(data);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>{
 console.log(`RBC ready: http://127.0.0.1:${port}`);
 console.log(`  corridor ${sections.length} sections · ${trains.length} trains · ${assets.length} assets on register`);
 console.log(`  API: GET /api/reference · POST /api/prioritise · POST /api/plan · POST /api/revalidate`);
});
