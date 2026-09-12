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
const GEN_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 30000;

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
 return cached;
}

async function generate({system, user, format, ms = GEN_MS, temperature = 0.2}) {
 const state = await health();
 if (!state.ready) throw new Error(state.reason);
 const body = {
  model: state.model, stream: false,
  options: {temperature, num_predict: 700},
  messages: [{role: 'system', content: system}, {role: 'user', content: user}],
 };
 if (format) body.format = format;
 const out = await post('/api/chat', body, ms);
 const text = out.message?.content?.trim() || '';
 if (!text) throw new Error('The model returned nothing.');
 return {text, model: state.model};
}

// ------------------------------------------------------------- vocabularies
// The model is given the real controlled vocabulary rather than left to invent
// one, so its output lands inside what validateRequest already accepts.
const SECTION_LIST = () => sections.map(s => `${s.id} = ${s.name} (${s.code})`).join('\n');
const DEPT_LIST = () => departments
 .map(d => `${d.code} = ${d.label}, source system ${d.system}, ${d.setup} min setup + ${d.clearance} min clearance`)
 .join('\n');
const ACTIVITIES = () => [...new Set(demo().requests.map(r => r.title))].slice(0, 30).join('; ');

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

Typical activities on this corridor: ${ACTIVITIES()}

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
 });

 let draft;
 try { draft = JSON.parse(raw); }
 catch { throw new Error('The model did not return usable JSON. Try rephrasing the note.'); }

 // Clamp to what the gate will accept rather than trusting the model's ranges.
 const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
 };
 return {
  model,
  draft: {
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
  },
  confidence:  ['high', 'medium', 'low'].includes(draft.confidence) ? draft.confidence : 'low',
  assumptions: Array.isArray(draft.assumptions)
   ? draft.assumptions.filter(a => typeof a === 'string').slice(0, 6) : [],
 };
}

// ------------------------------------------------------------------ explain
// The reason is already computed. This only puts it into a controller's words.
export async function explain(kind, facts) {
 const system = `You write one short paragraph for a section controller on Indian Railways.

Use ONLY the facts given. Never invent a time, a train, a number or a constraint that is not listed. Do not suggest overriding a safety rule. Two or three sentences, plain English, no bullet points, no preamble.`;

 const user = kind === 'rejection'
  ? `The safety gate refused to approve a maintenance block. The rules it failed:\n\n${facts}\n\nExplain what went wrong and what the controller would have to change.`
  : `A work order could not be scheduled in this planning horizon. What the planner recorded:\n\n${facts}\n\nExplain why it could not be placed and what would have to change for it to be placed.`;

 const {text, model} = await generate({system, user, ms: 20000});
 return {text, model};
}

// ------------------------------------------------------------------- notice
export async function notice(block, tasks) {
 const lines = [
  `Date: ${block.date}`,
  `Section: ${sectionName(block.section)}`,
  `Running line: ${block.line === null ? 'both lines, section-wide' : `${block.line} line`}`,
  `Window: ${time(block.start)} to ${time(block.end)} (${block.end - block.start} minutes)`,
  `Type: ${block.corridor ? `sanctioned corridor block, ${block.trainsRegulated ?? 0} trains regulated` : 'natural window in the timetable, no train affected'}`,
  `Departments: ${[...new Set(tasks.map(t => deptLabel(t.department)))].join(', ')}`,
  `Protection and clearance: included in the window above`,
  `Work orders:`,
  ...tasks.map(t => `  - ${t.id} ${t.title} (${deptLabel(t.department)}, ${t.duration} min${t.resource && t.resource !== 'None' ? `, ${t.resource}` : ''})`),
 ].join('\n');

 const system = `You write a possession notice for a railway divisional control office.

Use ONLY the figures given. Never add a time, a train number, a speed restriction or an instruction that is not in the facts. Write as running prose in at most 150 words: what is being taken, when, on which line, which departments are involved and in what order, and what the traffic cost is. No headings, no bullets, no sign-off.`;

 const {text, model} = await generate({system, user: lines, ms: 25000});
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

Answer ONLY from the CONTEXT below. If the context does not contain the answer, say plainly that the plan does not record it — do not guess, do not calculate new figures, do not describe railway practice in general. Never suggest overriding a safety rule. At most four sentences.

CONTEXT:
${ctx}`;

 const {text, model} = await generate({system, user: q, ms: 25000, temperature: 0.1});
 return {text, model};
}
