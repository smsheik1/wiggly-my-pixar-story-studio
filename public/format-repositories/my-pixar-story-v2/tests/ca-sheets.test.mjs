import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { sheetState } from '../scripts/run-ca-sheets.mjs';

const sd = JSON.parse(readFileSync(new URL('../runs/r4-dry10/outputs/story-director.json', import.meta.url)));
const ca = JSON.parse(readFileSync(new URL('../runs/r4-dry10/outputs/character-architect.json', import.meta.url)));

test('model-sheet state passes mode, masterRenderRef and master prompts through the CA selector', () => {
  const input = selectCharacterArchitectInput(sheetState({ inputs: {}, storyDirector: sd, characters: ca }));
  assert.equal(input.mode, 'model-sheet');
  for (const c of ca.characters) {
    assert.match(input.masterRenderRef[c.elementTag], /^asset:master-render:/);
    assert.equal(input.masterRenderPrompts[c.elementTag], c.masterRenderPrompt.promptText);
  }
});
