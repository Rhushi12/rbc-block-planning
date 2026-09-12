import {HFEATURES,HCOEF,HMEAN,FRAGILITY,AUC,BRIER,BASE_RATE,HAZARD_TRAINED_ON} from './hazard.js';
export {HFEATURES,FRAGILITY,AUC,BRIER,BASE_RATE,HAZARD_TRAINED_ON};

// P(this asset develops a reportable defect before its next window).
//
// Probability only. What it would cost if it did is a separate quantity, held
// separately on the work order, and the two are multiplied downstream. Keeping
// them apart is the point: a bridge fails rarely and expensively, a track
// circuit fails often and cheaply, and one number cannot say both.

// Feature vector, mirroring tools/build_backlog.py exactly. Change one, change both.
export function hazardFeatures(r){
 const periodicity=Math.max(r.periodicity||1,1);
 // A manually raised order knows how late it is but not how long it has stood.
 const elapsed=r.elapsedDays??(periodicity+(r.overdueDays??0));
 const wear=Math.max(0,Math.min(3,elapsed/periodicity));
 const traffic=r.traffic??0.5;
 return [wear,traffic,wear*traffic,FRAGILITY[r.class]??0.5];
}

const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));

export function failureRisk(r){
 const x=hazardFeatures(r);
 let z=HCOEF[0];
 for(let i=0;i<x.length;i++)z+=HCOEF[i+1]*x[i];
 return sigmoid(z);
}

// A logistic model is linear in the log-odds, so there the per-feature
// attribution is exact in the same way the priority model's is:
// coefficient x (feature - training mean). It is NOT exact in the probability,
// which is why this returns log-odds and says so.
export function explainRisk(r){
 const x=hazardFeatures(r);
 return HFEATURES.map((name,i)=>({name,value:x[i],logOdds:HCOEF[i+1]*(x[i]-HMEAN[i])}))
   .sort((a,b)=>Math.abs(b.logOdds)-Math.abs(a.logOdds));
}

// Where a probability sits against the population it was fitted on. A judge
// asking "is 0.31 high?" deserves an answer that is not just the number.
export const riskBand=p=>p>=2*BASE_RATE?'High':p>=BASE_RATE?'Raised':'Low';
