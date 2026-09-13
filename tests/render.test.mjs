// Renders the interface without a browser.
//
// Not a substitute for looking at it, but the planner and the gate were already
// covered while the interface was not, and the markup is where a missing import,
// a template that throws, or a panel that silently renders empty actually shows
// up. Node runs each test file in its own process, so the globals stubbed here
// do not reach the other suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const app = {innerHTML: '', focus() {}, value: '', dataset: {}};
const tip = {hidden: true, innerHTML: '', offsetWidth: 240, offsetHeight: 90, style: {}};
const strip = {dataset: {}};
const handlers = {};

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto});
globalThis.performance = {now: () => 0};
globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
globalThis.location = {hash: '#Maintenance%20Backlog'};
globalThis.history = {replaceState() {}};
globalThis.window = {addEventListener() {}, innerWidth: 1400};
globalThis.fetch = async () => { throw new Error('no server in this harness'); };
globalThis.document = {
 addEventListener(type, fn) { handlers[type] = fn; },
 querySelector(sel) { return {'#app': app, '#strip-tip': tip, '.strip': strip}[sel] ?? null; },
 querySelectorAll() { return []; },
};
globalThis.setTimeout = fn => (fn && 0);

const ui = await import('../dist/app.js');
const click = el => handlers.click({target: {...el, closest: () => el}});

test('the backlog page renders both fitted models and a risk per work order', () => {
 const html = app.innerHTML;
 assert.ok(html.length > 5000, 'the page rendered something substantial');
 assert.ok(html.includes('Failure risk'), 'risk has its own column');
 assert.ok(html.includes('Priority model · what to do first'));
 assert.ok(html.includes('Failure-risk model · what is likely to break'));
 assert.match(html, /AUC 0\.\d+/, 'the hazard model reports how well it separates');
 assert.match(html, /Brier 0\.\d+/, 'and how honest its probabilities are');
 assert.match(html, /\d+%<small[^>]*>(Low|Raised|High) ·/, 'each row carries a risk and a band');
});

test('Why? opens both attributions, and is honest about the log-odds', () => {
 const id = (app.innerHTML.match(/data-explain="(MR-[^"]+)"/) || [])[1];
 assert.ok(id, 'there is a work order to expand');
 click({dataset: {explain: id}});
 const html = app.innerHTML;
 assert.ok(html.includes('What drives this priority'));
 assert.ok(html.includes('What drives the failure risk'));
 // A logistic model decomposes exactly in the log-odds, not in the percentage.
 // Saying so is the difference between explainable and merely decorated.
 assert.ok(html.includes('linear in the log-odds'));
 assert.match(html, /against a \d+% base rate/);
 assert.ok((html.match(/class="bar"/g) || []).length >= 8, 'both breakdowns drew bars');
 assert.ok(html.includes('colspan="7"'), 'the panel spans the widened table');
});

test('a plan renders with its controls and its deferrals', () => {
 click({dataset: {page: 'Block Plan'}});
 click({dataset: {action: 'plan'}});
 const html = app.innerHTML;
 assert.match(html, /\d+<\/strong>blocks/, 'the summary strip reports blocks');
 assert.ok(html.includes('Prefer start'), 'a controller can move the window');
 assert.ok(html.includes('Deferred'), 'what could not be placed is shown, not hidden');
});

test('hovering the corridor strip explains exactly the colour under the pointer', () => {
 click({dataset: {page: 'Dashboard'}});
 const html = app.innerHTML;
 assert.ok(html.includes('id="strip-tip"'), 'the dashboard carries a tooltip');
 for (const k of ['t', 'w', 'b']) assert.ok(html.includes(`data-legend="${k}"`), `legend entry ${k} is hoverable`);

 // Every painted cell and its hover details agree, on every section and line.
 const ribbons = [...html.matchAll(/<div class="ribbon" data-section="([^"]+)" data-line="([^"]+)"[^>]*>(.*?)<\/div>/g)];
 assert.equal(ribbons.length, 12, 'six sections, two running lines');
 let yellow = 0;
 for (const [, s, l, cells] of ribbons) {
  const painted = [...cells.matchAll(/<i class="([a-z]*)" data-i="(\d+)"/g)];
  assert.equal(painted.length, 48);
  for (const [, cls, i] of painted) {
   assert.equal(ui.cellDetails(s, l, Number(i)).kind, cls, `${s} ${l} cell ${i}`);
   if (cls === 'w') yellow++;
  }
 }
 assert.ok(yellow > 0, 'some sanctioned window shows through the traffic');

 // Known facts from the real timetable.
 const evening = ui.cellDetails('S1', 'UP', 40);   // 20:00 on the UP line
 assert.deepEqual(evening.windows, [{window: '19:45–23:45', minutes: 240, regulates: 12}]);
 assert.ok(ui.cellDetails('S4', 'DN', 0).trains.some(t => t.id === '12937'), 'train 12937 runs S4 DN just after midnight');

 // The real handler fills and places the tooltip, and the legend filters the strip.
 const cell = {dataset: {i: '40'}, parentElement: {dataset: {section: 'S1', line: 'UP'}},
  getBoundingClientRect: () => ({left: 600, top: 300, width: 20, bottom: 314})};
 handlers.mouseover({target: {closest: sel => sel === '.ribbon i' ? cell : null}});
 assert.equal(tip.hidden, false);
 assert.match(tip.innerHTML, /Sanctioned corridor window 19:45–23:45/);
 assert.match(tip.innerHTML, /regulates 12 trains/);
 assert.equal(tip.style.top, '200px', 'placed above the cell');
 handlers.mouseover({target: {closest: sel => sel === '[data-legend]' ? {dataset: {legend: 'w'}} : null}});
 assert.equal(strip.dataset.focus, 'w');
 assert.equal(tip.hidden, true, 'leaving the strip hides the details');
});

test('every assistant control stays hidden when no local model answers', () => {
 // The published build has no server behind it, so the probe fails. Nothing
 // about the planner may depend on the assistant being there.
 assert.ok(!app.innerHTML.includes('Ask the plan'));
 click({dataset: {page: 'Maintenance Backlog'}});
 click({dataset: {modal: 'request'}});
 assert.ok(!app.innerHTML.includes('Read the note'), 'no intake box without a model');
 assert.ok(app.innerHTML.includes('Raise a work order'), 'the typed form is untouched');
});
