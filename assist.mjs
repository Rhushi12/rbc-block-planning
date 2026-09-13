// Local language assistant.
//
// The rule this file exists to keep: the model touches language, never
// arithmetic and never the gate. It drafts a work order from a sentence, puts
// a computed refusal into words, writes a notice from figures it was handed,
// and answers questions from a context built out of facts the planner already
// computed. It never ranks, never chooses a window, never validates anything,
// and nothing it produces reaches state without a person acting on it.
//
// Everything here is optional. If the daemon is not running the endpoints say
// so and the interface hides the feature; the planner is unaffected.

import {demo, sections, departments, resources, sectionName, deptLabel,
        time, requiredMinutes} from './dist/data.js';

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const WANT = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
const PROBE_MS = 2500;
const GEN_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;
// Keep the model resident between calls. Loading a 7B model off disk takes
// longer than the whole generation, and paying it again mid-demonstration is
// the difference between an answer and a timeout.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

// A demonstration must never hang on a model. Every call is on a clock.
async function post(path, body, ms) {
 const stop = AbortSignal.timeout(ms);
 const res = await fetch(`${HOST}${path}`, {
  method: 'POST', signal: stop,
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body),
 });
 if (!res.ok) throw new Error(`Ollama returned ${res.status}.`);
 return res.json();
}

let cached = null;
// Prefer the configured model, then any build of the same family, then any
// Qwen, then whatever is installed. A demo laptop rarely has the exact tag.
function choose(names) {
 if (!names.length) return null;
 const base = WANT.split(':')[0];
 return names.find(n => n === WANT)
     || names.find(n => n.startsWith(base))
     || names.find(n => n.toLowerCase().includes('qwen'))
     || names[0];
}

export async function health({refresh = false} = {}) {
 if (cached?.ready && !refresh) return cached;   // retry a failed probe; keep a good one
 try {
  const res = await fetch(`${HOST}/api/tags`, {signal: AbortSignal.timeout(PROBE_MS)});
  if (!res.ok) throw new Error(`Ollama returned ${res.status}.`);
  const names = (await res.json()).models?.map(m => m.name) || [];
  const model = choose(names);
  cached = model
   ? {ready: true, host: HOST, model, installed: names, wanted: WANT}
   : {ready: false, host: HOST, reason: `Ollama is running but no model is installed. Run: ollama pull ${WANT}`};
 } catch (e) {
  cached = {ready: false, host: HOST,
   reason: e.name === 'TimeoutError'
    ? `No answer from Ollama at ${HOST} within ${PROBE_MS} ms.`
    : `Ollama is not reachable at ${HOST}. Start it with: ollama serve`};
 }
 if (cached.ready) warm();
 return cached;
}

// Load the weights now, in the background, so the first real request is not
// also the one that pays for loading them. Failure here is not interesting:
// the request that follows will report anything that actually matters.
let warming = null;
function warm() {
 if (warming) return warming;
 warming = post('/api/chat', {
  model: cached.model, stream: false, keep_alive: KEEP_ALIVE,
  options: {num_predict: 1},
  messages: [{role: 'user', content: 'ready'}],
 }, 120000).catch(() => {});
 return warming;
}

async function generate({system, user, format, ms = GEN_MS, temperature = 0.2, tokens = 400}) {
 const state = await health();
 if (!state.ready) throw new Error(state.reason);
 // A small model left to its own devices repeats itself and mangles words in
 // the process - "tamping machine" came back as "tampingamping machine machine"
 // before the repeat penalty went in. Low temperature for work that must be
 // faithful to figures it was handed, not creative with them.
 const body = {
  model: state.model, stream: false, keep_alive: KEEP_ALIVE,
  options: {temperature, top_p: 0.9, repeat_penalty: 1.15, num_predict: tokens},
  messages: [{role: 'system', content: system}, {role: 'user', content: user}],
 };
 if (format) body.format = format;
 const out = await post('/api/chat', body, ms);
 let text = out.message?.content?.trim() || '';
 if (!text) throw new Error('The model returned nothing.');
 // Stopped by the token budget: end on the last whole sentence rather than hand
 // a controller half a word. JSON is left alone - a cut object fails to parse
 // and says so.
 if (out.done_reason === 'length' && !format) text = wholeSentences(text);
 return {text, model: state.model};
}

export function wholeSentences(text) {
 const m = String(text).match(/^[\s\S]*[.!?](?=\s|$)/);
 return m ? m[0].trim() : String(text).trim();
}

// ------------------------------------------------------------- vocabularies
// The model is given the real controlled vocabulary rather than left to invent
// one, so its output lands inside what validateRequest already accepts.
const SECTION_LIST = () => sections.map(s => `${s.id} = ${s.name} (${s.code})`).join('\n');
const DEPT_LIST = () => departments
 .map(d => `${d.code} = ${d.label}, source system ${d.system}, ${d.setup} min setup + ${d.clearance} min clearance`)
 .join('\n');
// Which department does each activity, and with which machine, as the register
// records it. Bare titles were not enough: a rail flaw test came back from the
// model with a traction department's OHE recording car attached.
export const CATALOGUE = (() => {
 const seen = new Map();
 for (const r of demo().requests) if (!seen.has(r.title)) seen.set(r.title, r);
 return [...seen.values()].map(r => ({title: r.title, department: r.department,
  resource: r.resource || 'None'}));
})();
const ACTIVITIES = () => CATALOGUE
 .map(a => `${a.title} = ${a.department}, machinery ${a.resource}`).join('\n');

// Checked here, not by the model: a draft that disagrees with the register is
// flagged for the controller to look at, never silently corrected.
export function intakeWarnings(draft) {
 const out = [];
 const none = r => r === 'None' ? 'no machinery' : r;
 const known = CATALOGUE.find(a => a.title.toLowerCase() === String(draft.title).trim().toLowerCase());
 if (known) {
  if (known.department !== draft.department)
   out.push(`${known.title} is ${deptLabel(known.department)} work on this register, not ${deptLabel(draft.department)}.`);
  if (known.resource !== draft.resource)
   out.push(`The register does ${known.title} with ${none(known.resource)}, not ${none(draft.resource)}.`);
 } else if (draft.resource !== 'None') {
  const users = [...new Set(CATALOGUE.filter(a => a.resource === draft.resource).map(a => a.department))];
  if (users.length && !users.includes(draft.department))
   out.push(`${draft.resource} is used only by ${users.map(deptLabel).join(', ')} work on this register, not ${deptLabel(draft.department)}.`);
 }
 return out;
}

const INTAKE_SCHEMA = {
 type: 'object',
 properties: {
  title:       {type: 'string'},
  section:     {type: 'string', enum: sections.map(s => s.id)},
  line:        {type: ['string', 'null'], enum: ['UP', 'DN', null]},
  department:  {type: 'string', enum: departments.map(d => d.code)},
  resource:    {type: 'string', enum: ['None', ...resources]},
  duration:    {type: 'integer'},
  periodicity: {type: 'integer'},
  overdueDays: {type: 'integer'},
  severity:    {type: 'integer'},
  emergency:   {type: 'boolean'},
  confidence:  {type: 'string', enum: ['high', 'medium', 'low']},
  assumptions: {type: 'array', items: {type: 'string'}},
 },
 required: ['title', 'section', 'line', 'department', 'resource', 'duration',
            'periodicity', 'overdueDays', 'severity', 'emergency',
            'confidence', 'assumptions'],
};

// ------------------------------------------------------------------- intake
// Turns a sentence a permanent way inspector would actually write into a draft
// work order. A DRAFT: it fills the form, it does not file the work order.
export async function intake(text) {
 const note = String(text || '').trim();
 if (!note) throw new Error('Provide the defect note to read.');
 if (note.length > 2000) throw new Error('Keep the note under 2000 characters.');

 const system = `You convert a railway maintenance note into one structured work order for the Vadodara–Ahmedabad corridor.

SECTIONS (use the id on the left):
${SECTION_LIST()}

DEPARTMENTS:
${DEPT_LIST()}

MACHINERY: None, ${resources.join(', ')}

ACTIVITIES ON THIS CORRIDOR (activity = department, machinery). When the note describes one of these, use its department and machinery:
${ACTIVITIES()}

Rules:
- line is "UP" or "DN" for work on one running line, or null when the work closes the whole section (points, interlocking, bridges, anything between the lines).
- duration is working minutes only. Do NOT add setup or clearance; the planner adds those itself.
- severity is 0 when no defect is reported, otherwise 1 to 4, where 4 is a reported fracture or failure.
- overdueDays is 0 unless the note actually says the work is late.
- emergency is true only when the note describes something needing attention before the next routine window.
- periodicity is the routine interval in days for this activity; use 90 when the note gives no basis.
- Put every value you inferred rather than read into assumptions, in plain English.
- Set confidence to low when the note is vague about section, line or department.
Return only the JSON object.`;

 const {text: raw, model} = await generate({
  system, user: note, format: INTAKE_SCHEMA, temperature: 0.1,
  tokens: 500, ms: 90000,
 });

 let draft;
 try { draft = JSON.parse(raw); }
 catch { throw new Error('The model did not return usable JSON. Try rephrasing the note.'); }

 // Clamp to what the gate will accept rather than trusting the model's ranges.
 const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
 };
 const clean = {
  title:       String(draft.title || '').slice(0, 120),
  section:     sections.some(s => s.id === draft.section) ? draft.section : sections[0].id,
  line:        ['UP', 'DN'].includes(draft.line) ? draft.line : null,
  department:  departments.some(d => d.code === draft.department) ? draft.department : 'ENGG',
  resource:    ['None', ...resources].includes(draft.resource) ? draft.resource : 'None',
  duration:    int(draft.duration, 5, 480, 45),
  periodicity: int(draft.periodicity, 1, 3650, 90),
  overdueDays: int(draft.overdueDays, -365, 999, 0),
  severity:    int(draft.severity, 0, 4, 0),
  emergency:   draft.emergency === true,
 };
 return {
  model,
  draft: clean,
  confidence:  ['high', 'medium', 'low'].includes(draft.confidence) ? draft.confidence : 'low',
  assumptions: Array.isArray(draft.assumptions)
   ? draft.assumptions.filter(a => typeof a === 'string').slice(0, 6) : [],
  warnings:    intakeWarnings(clean),
 };
}

// ------------------------------------------------------------------ explain
// The reason is already computed. This only puts it into a controller's words.
export async function explain(kind, facts) {
 const system = `You write one short paragraph for a section controller on Indian Railways.

Use ONLY the facts given. Every number you write must appear verbatim in those facts - do not round them, adjust them, or work out new ones. Never invent a time, a train or a constraint that is not listed. Do not suggest overriding a safety rule.

Two or three sentences of plain English. No bullet points, no preamble, no repetition, and do not restate the facts as a list.`;

 const user = kind === 'rejection'
  ? `The safety gate refused to approve a maintenance block. The rules it failed:\n\n${facts}\n\nExplain what went wrong and what the controller would have to change.`
  : `A work order could not be scheduled in this planning horizon. What the planner recorded:\n\n${facts}\n\nExplain why it could not be placed and what would have to change for it to be placed.`;

 const {text, model} = await generate({system, user, ms: 45000, tokens: 220});
 return {text, model};
}

// ------------------------------------------------------------------- notice
// The work is summarised per department before the model sees it. Handed one
// line per work order, it copied the list out and ran out of tokens mid-word.
export function noticeFacts(block, tasks) {
 const byDept = new Map();
 for (const t of tasks) {
  if (!byDept.has(t.department)) byDept.set(t.department, []);
  byDept.get(t.department).push(t);
 }
 return [
  `Date: ${block.date}`,
  `Section: ${sectionName(block.section)}`,
  `Running line: ${block.line === null ? 'both lines, section-wide' : `${block.line} line`}`,
  `Window: ${time(block.start)} to ${time(block.end)} (${block.end - block.start} minutes)`,
  `Type: ${block.corridor ? `sanctioned corridor block, ${block.trainsRegulated ?? 0} trains regulated` : 'natural window in the timetable, no train affected'}`,
  `Work orders: ${tasks.length}`,
  ...[...byDept].map(([d, ts]) => {
   const machines = [...new Set(ts.map(t => t.resource).filter(r => r && r !== 'None'))];
   return `${deptLabel(d)}: ${ts.length} work order${ts.length === 1 ? '' : 's'}, machinery ${machines.length ? machines.join(', ') : 'none'}`;
  }),
  `Protection and clearance: included in the window above`,
 ].join('\n');
}

export async function notice(block, tasks) {
 const lines = noticeFacts(block, tasks);

 const system = `You write a possession notice for a railway divisional control office.

Use ONLY the figures given. Every date, time, duration and count you write must appear verbatim in those facts. Never add a train number, a speed restriction or an instruction that is not there.

Write CONTINUOUS PROSE, at most 120 words: what is being taken, when, on which running line, which departments are involved, and what the traffic cost is. No headings, no bullet points, no sign-off, and never repeat a phrase.`;

 const {text, model} = await generate({system, user: lines, ms: 45000, tokens: 400});
 return {text, model, facts: lines};
}

// ---------------------------------------------------------------------- ask
// Grounded strictly in what the planner computed. No access to raw data, no
// arithmetic of its own, and an explicit instruction to refuse rather than guess.
export function context(state, result) {
 const out = [];
 out.push(`Planning date: ${state.date}`);
 out.push(`Corridor: ${sections.length} block sections, ${sections.map(s => s.code).join(', ')}`);
 out.push(`Departments on duty: ${state.availability.map(a =>
   `${deptLabel(a.department)} ${a.ready ? 'yes' : 'no'}, ${a.crews} crew`).join('; ')}`);
 out.push(`Pending work orders: ${state.requests.filter(r => r.status === 'Pending').length}`);
 out.push(`Approved blocks: ${state.blocks.length}`);
 if (state.delays?.length)
  out.push(`Running delays applied: ${state.delays.map(d => `${d.train} late ${d.minutes} min`).join('; ')}`);

 if (result?.summary) {
  const s = result.summary;
  out.push(`\nCURRENT PLAN (${result.horizon} horizon):`);
  out.push(`${s.blocks} blocks, ${s.tasks} work orders scheduled, ${s.blocksReduced} possessions avoided, ${s.lineMinutesSaved} line minutes recovered, ${s.availabilityGain}% availability gain, ${s.deferred} deferred (${s.deferredStructural} structural, ${s.deferredCapacity} capacity).`);
  for (const p of (result.plans || []).slice(0, 20)) {
   out.push(`Block ${p.blockNo}: ${p.date} ${sectionName(p.section)} ${p.line === null ? 'both lines' : p.line + ' line'} ${time(p.start)}-${time(p.end)}, ${p.taskIds.length} work orders, ${p.corridor ? `corridor block regulating ${p.rationale?.trainsRegulated ?? 0} trains` : `natural window, ${p.rationale?.headroom ?? 0} min clearance`}, saves ${p.rationale?.saved ?? 0} min against planning apart. Work: ${p.taskIds.join(', ')}.`);
  }
  for (const u of (result.unplaced || []).slice(0, 20)) {
   out.push(`Deferred ${u.id} "${u.title}" (${deptLabel(u.department)}, needs ${requiredMinutes([u])} min): ${u.deferral} — ${u.reason}`);
  }
 } else {
  out.push('\nNo plan has been generated yet in this session.');
 }
 return out.join('\n');
}

export async function ask(question, ctx) {
 const q = String(question || '').trim();
 if (!q) throw new Error('Provide a question.');
 if (q.length > 500) throw new Error('Keep the question under 500 characters.');

 const system = `You answer questions about one railway block plan, for a section controller.

Answer ONLY from the CONTEXT below.

If the answer is not stated in the context, reply with exactly this and nothing else:
"The plan does not record that."

That applies to anything the context does not contain - staff, stations, equipment, rules, history, or anything about railways in general. Do not guess, do not infer, do not calculate new figures, and never suggest overriding a safety rule.

When the answer IS in the context, give it in at most three sentences of plain prose, quoting the figures exactly as they appear. Do not repeat yourself.

CONTEXT:
${ctx}`;

 const {text, model} = await generate({system, user: q, ms: 45000, temperature: 0.1, tokens: 200});
 return {text, model};
}
