import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inputsFromProject } from '../scripts/run-rehearsal.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const NOTE = 'My sister does NOT wear a hijab. Show her hair uncovered.';

test('SD and CA roles have no blanket hijab rule; hijab only from user notes/photos', () => {
  for (const p of ['../crew/story-director/role.md', '../crew/character-architect/role.md']) {
    const r = read(p);
    assert.ok(!/every female family (character|member)[^.]*hijab/i.test(r), `${p} still has a blanket hijab rule`);
    assert.match(r, /hijab only when/i);
    assert.match(r, /never assume one/i);
  }
  assert.match(read('../crew/story-director/role.md'), /castDescriptions[^\n]*physicalDescription/);
});

test('user cast note flows project -> SD input', () => {
  const inputs = inputsFromProject({ inputs: { subject: 'Shaz', answers: { scene1Childhood: 'x' }, castDescriptions: [{ id: 'sister', name: 'Sister', description: NOTE }] } });
  const sd = selectStoryDirectorInput({ project: { inputs } });
  assert.deepEqual(sd.castDescriptions, [{ id: 'sister', name: 'Sister', description: NOTE }]);
});

test('SD cast card text reaches the CA unchanged', () => {
  const card = { name: 'Sister', elementTag: '@Sis', age: 18, oneWordRole: 'sister', physicalDescription: `Young woman, light olive skin, long dark hair uncovered. ${NOTE}`,
    signatureAccent: 'yellow sweater', voiceDescription: 'Eighteen-year-old American girl, bright clear timbre, fast playful pace', skinTone: 'light olive', gender: 'female', family: true, realPerson: 'Sister', ageNote: null, photoRef: null };
  const ca = selectCharacterArchitectInput({ project: { storyDirector: { cast: [card], segments: [{ segmentId: 1, title: 't', shots: [] }] } } });
  assert.ok(ca.cast[0].physicalDescription.includes(NOTE));
});

test('notes in inputs.castDescriptions survive the graph default (top-level castDescriptions: [])', async () => {
  const { PipelineAnnotation } = await import('../graph/state.mjs');
  const { StateGraph, START, END } = await import('@langchain/langgraph');
  let seen;
  const g = new StateGraph(PipelineAnnotation).addNode('sd', (s) => { seen = selectStoryDirectorInput(s); return {}; }).addEdge(START, 'sd').addEdge('sd', END).compile();
  const inputs = inputsFromProject({ inputs: { subject: 'Shaz', answers: { scene1Childhood: 'x' }, castDescriptions: [{ id: 'sister', name: 'Sister', description: NOTE }] } });
  await g.invoke({ inputs });
  assert.deepEqual(seen.castDescriptions, [{ id: 'sister', name: 'Sister', description: NOTE }]);
});
