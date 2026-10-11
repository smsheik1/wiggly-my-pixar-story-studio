import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const BANNED=[/plain\/unmarked objects/i,/blank\/calm walls/i,/blank walls/i,/calm walls/i,/generic catalog rooms/i];

test('background direction requires dressed storied sets that are empty of people only',async()=>{
 const beau=await read('../crew/beau/SKILL.md'),theo=await read('../crew/theo/SKILL.md');
 const recipe=await read('../background-prompter.md'),visual=await read('../evaluation/rubrics/visual.md');
 for(const [name,content] of [['beau',beau],['theo',theo],['recipe',recipe],['visual',visual]]){
  assert.match(content,/empty of people only/i,`${name} must state empty-means-empty-of-people-only`);
  assert.match(content,/lived-in props/,`${name} must require lived-in props`);
  assert.match(content,/\[L-PALETTE\]|craft-guide\.md#locations/,`${name} must reference [L-PALETTE]`);
 }
 assert.match(beau+theo+recipe,/8-year-old's room has a kid's bed, science posters, a toy microscope/);
 assert.match(beau+theo,/Forbid.*plain\/unmarked objects/);
});

test('banned empty-room phrasing is gone from background direction',async()=>{
 const files=['../crew/beau/SKILL.md','../crew/theo/SKILL.md','../background-prompter.md','../evaluation/rubrics/visual.md'];
 for(const file of files){
  const content=await read(file);
  // Forbid/never lines may name the banned concepts to prohibit them;
  // everywhere else the direction must never ask for them.
  const directed=content.split('\n').filter(line=>!/forbid|never/i.test(line)).join('\n');
  for(const pattern of BANNED)assert.doesNotMatch(directed,pattern,`${file} must not direct ${pattern}`);
 }
});

test('the anti-photoreal guardrail is kept',async()=>{
 const theo=await read('../crew/theo/SKILL.md');
 assert.match(theo,/Anti-Photorealism Guardrail/);
 assert.match(theo,/architectural interior catalog photography/);
});
