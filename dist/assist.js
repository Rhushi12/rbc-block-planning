// Browser side of the local language assistant.
//
// The interface only ever talks to its own origin. The server decides whether a
// local model is reachable and does the talking; this file asks once, keeps the
// answer, and gives the rest of the app a way to call a route with a deadline.
//
// On the published build there is no server, so the probe fails and every
// assistant control stays hidden. The planner does not notice either way.

export const assist = {ready: false, model: null, reason: 'Looking for a local model…', checked: false};

export async function probeAssist() {
 try {
  const r = await fetch('/api/assist/health', {signal: AbortSignal.timeout(6000)});
  if (!r.ok) throw new Error('no route');
  const j = await r.json();
  assist.ready = j.ready === true;
  assist.model = j.model || null;
  assist.reason = j.reason || '';
 } catch {
  assist.ready = false;
  assist.model = null;
  assist.reason = 'No planning server behind this page, so no local model. Run npm start to use the assistant.';
 }
 assist.checked = true;
 return assist;
}

// Every call is on a deadline: a model thinking too long must not freeze a demo.
export async function callAssist(route, body, ms = 120000) {
 let res;
 try {
  res = await fetch('/api/assist/' + route, {
   method: 'POST',
   headers: {'Content-Type': 'application/json'},
   body: JSON.stringify(body),
   signal: AbortSignal.timeout(ms),
  });
 } catch (e) {
  throw new Error(e.name === 'TimeoutError'
   ? `The model did not answer within ${Math.round(ms / 1000)} seconds. It may still be loading — try again.`
   : 'The assistant could not be reached.');
 }
 const j = await res.json().catch(() => ({error: 'The assistant returned nothing usable.'}));
 if (!res.ok) throw new Error(j.error || 'The assistant failed.');
 return j;
}
