import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOGUE, intakeWarnings, noticeFacts, wholeSentences} from '../assist.mjs';
import {demo} from '../dist/data.js';

// None of these reach a model. They are the deterministic checks that sit
// either side of one, and they must hold whether or not Ollama is running.

test('the intake catalogue carries every activity with its department and machinery', () => {
 assert.equal(CATALOGUE.length, new Set(demo().requests.map(r => r.title)).size);
 const usfd = CATALOGUE.find(a => a.title === 'Ultrasonic rail flaw testing');
 assert.deepEqual(usfd, {title: 'Ultrasonic rail flaw testing', department: 'ENGG', resource: 'USFD trolley'});
});

test('a draft that disagrees with the register is flagged, one that agrees is not', () => {
 const base = {title: 'Ultrasonic Rail Flaw Testing', department: 'ENGG', resource: 'USFD trolley'};
 assert.deepEqual(intakeWarnings(base), []);
 // The case that came back from the model: a rail test with a traction machine.
 const wrong = intakeWarnings({...base, resource: 'OHE recording car'});
 assert.equal(wrong.length, 1);
 assert.match(wrong[0], /USFD trolley/);
 assert.match(intakeWarnings({...base, department: 'TRD'})[0], /Engineering work/);
 // An activity the register does not know is still checked on its machinery.
 assert.match(intakeWarnings({title: 'Rail fracture repair', department: 'SNT', resource: 'Tower wagon'})[0],
  /Traction Distribution/);
 assert.deepEqual(intakeWarnings({title: 'Rail fracture repair', department: 'ENGG', resource: 'None'}), []);
});

test('notice facts summarise by department instead of listing every work order', () => {
 const tasks = demo().requests.slice(0, 12);
 const block = {date: '2026-09-14', section: tasks[0].section, line: null, start: 600, end: 840,
  corridor: true, trainsRegulated: 17};
 const facts = noticeFacts(block, tasks);
 assert.match(facts, /Work orders: 12/);
 assert.match(facts, /10:00 to 14:00 \(240 minutes\)/);
 assert.match(facts, /17 trains regulated/);
 for (const t of tasks) assert.ok(!facts.includes(t.id), `${t.id} should not be listed`);
 const depts = new Set(tasks.map(t => t.department)).size;
 assert.equal(facts.split('\n').filter(l => /: \d+ work orders?, machinery/.test(l)).length, depts);
});

test('text cut off by the token budget ends on a whole sentence', () => {
 assert.equal(wholeSentences('The block runs 235 minutes. Work includes point machine s'),
  'The block runs 235 minutes.');
 assert.equal(wholeSentences('Clearance is 2.5 min. Then tamp'), 'Clearance is 2.5 min.');
 assert.equal(wholeSentences('no sentence end at all'), 'no sentence end at all');
});
