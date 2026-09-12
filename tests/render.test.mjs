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
const handlers = {};

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto});
globalThis.performance = {now: () => 0};
globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
globalThis.location = {hash: '#Maintenance%20Backlog'};
globalThis.history = {replaceState() {}};
globalThis.window = {addEventListener() {}};
globalThis.fetch = async () => { throw new Error('no server in this harness'); };
globalThis.document = {
 addEventListener(type, fn) { handlers[type] = fn; },
 querySelector(sel) { return sel === '#app' ? app : null; },
 querySelectorAll() { return []; },
};
globalThis.setTimeout = fn => (fn && 0);

await import('../dist/app.js');
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

test('every assistant control stays hidden when no local model answers', () => {
 // The published build has no server behind it, so the probe fails. Nothing
 // about the planner may depend on the assistant being there.
 assert.ok(!app.innerHTML.includes('Ask the plan'));
 click({dataset: {page: 'Maintenance Backlog'}});
 click({dataset: {modal: 'request'}});
 assert.ok(!app.innerHTML.includes('Read the note'), 'no intake box without a model');
 assert.ok(app.innerHTML.includes('Raise a work order'), 'the typed form is untouched');
});
