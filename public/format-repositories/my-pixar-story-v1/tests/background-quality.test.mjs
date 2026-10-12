import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
// Lines that name a failure (or forbid one) may quote the banned concepts;
// direction text everywhere else must never ask for them.
const FAILURE_LINE=/forbid|never|fail|repair|defect|doesn't|no story/i;
const BANNED=[/plain\/unmarked objects/i,/blank\/calm walls/i,/blank walls/i,/calm walls/i,/generic catalog rooms/i];

test('background direction requires dressed storied sets that are empty of people only',{timeout:20000},async()=>{
 const beau=await read('../crew/beau/SKILL.md'),theo=await read('../crew/theo/SKILL.md');
 const recipe=await read('../background-prompter.md'),visual=await read('../evaluation/rubrics/visual.md');
 // The empty-of-people rule in each file's current wording.
 assert.match(beau,/never places a person in it/,'beau direction carries no people');
 assert.match(theo,/the room is empty of people/,'theo single empty-of-people clause');
 assert.match(recipe,/the room is empty of people/,'recipe single empty-of-people clause');
 assert.match(visual,/empty of people only/i,'visual empty-means-empty-of-people-only');
 // The dressed-room rule in each file's current wording.
 assert.match(beau,/lived-in, specific/,'beau lived-in room');
 assert.match(theo,/knownDetails.*proposedDetails/,'theo dressing comes from the brief');
 assert.match(recipe,/knownDetails and proposedDetails only/,'recipe dressing comes from the brief');
 assert.match(visual,/story-specific-set/,'visual story-specific room');
 for(const [name,content] of [['beau',beau],['theo',theo],['recipe',recipe],['visual',visual]]){
  assert.match(content,/craft-guide\.md#locations|\[L-PALETTE\]|\[L-DRESSED\]|task\.craft/,`${name} must tie to the locations craft`);
 }
 // The old invented-life-details example is gone from direction.
 for(const [name,content] of [['beau',beau],['theo',theo],['recipe',recipe],['visual',visual]]){
  assert.doesNotMatch(content,/8-year-old's room has a kid's bed, science posters, a toy microscope/,`${name} must not invent life details`);
  assert.doesNotMatch(content,/\(era, age, hobbies, dreams\)/,`${name} must not list invented life slots`);
 }
 // Theo's repair section names the failure it fixes.
 assert.match(theo,/plain props, blank walls, no story/);
});

test('banned empty-room phrasing is gone from background direction',{timeout:20000},async()=>{
 const files=['../crew/beau/SKILL.md','../crew/theo/SKILL.md','../background-prompter.md','../evaluation/rubrics/visual.md'];
 for(const file of files){
  const content=await read(file);
  // Failure-describing lines may name the banned concepts to prohibit them;
  // everywhere else the direction must never ask for them.
  const directed=content.split('\n').filter(line=>!FAILURE_LINE.test(line)).join('\n');
  for(const pattern of BANNED)assert.doesNotMatch(directed,pattern,`${file} must not direct ${pattern}`);
 }
});

test('the anti-photoreal guardrail is kept',{timeout:20000},async()=>{
 const theo=await read('../crew/theo/SKILL.md'),recipe=await read('../background-prompter.md');
 assert.match(theo,/photoreal or catalog look/);
 assert.match(theo,/photographic terms/);
 assert.match(recipe,/house look in `craft-guide\.md#house-style`/);
});
