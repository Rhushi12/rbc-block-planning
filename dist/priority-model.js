import {FEATURES,COEF,MEAN,RMSE,SCALE,TRAINED_ON} from './priority.js';
import {failureRisk} from './hazard-model.js';
export {FEATURES,RMSE,TRAINED_ON};

// Feature vector, mirroring tools/build_backlog.py exactly. Change one, change both.
//
// Four things that do not say each other: how late the work is, what is already
// reported wrong with it, how likely the asset is to fail before its next
// window, and what that failure would cost. Criticality and traffic used to sit
// here on their own as well; carrying them twice made the fit collinear and
// pushed the risk coefficient negative, which is worse than not having it.
export function featurise(r){
 return [
  Math.max(-1,Math.min(3,(r.overdueDays??0)/Math.max(r.periodicity||1,1)*4)),
  (r.severity??0)/4,
  r.risk??failureRisk(r),
  (r.criticality??0.7)*(r.traffic??0.5),
 ];
}
const raw=x=>{let y=COEF[0];for(let i=0;i<x.length;i++)y+=COEF[i+1]*x[i];return y;};
const scale=y=>(y-SCALE[0])/(SCALE[1]-SCALE[0])*100;
export function score(r){
 return Math.round(Math.max(0,Math.min(100,scale(raw(featurise(r))))));
}
// For a linear model the exact Shapley attribution of each feature is
// coefficient x (feature - training mean), so the parts sum to the score.
export function explain(r){
 const x=featurise(r);
 const k=100/(SCALE[1]-SCALE[0]);
 return FEATURES.map((name,i)=>({name,value:x[i],contribution:COEF[i+1]*(x[i]-MEAN[i])*k}))
   .sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution));
}
