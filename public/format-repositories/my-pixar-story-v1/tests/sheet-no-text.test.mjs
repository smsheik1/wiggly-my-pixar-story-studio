import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initialProject,taskFor,current,characterRecipeSha256} from '../runtime/workflow.mjs';
import {digest} from '../runtime/contracts.mjs';
import {inputs,send} from './helpers.mjs';
import {image} from './background-helpers.mjs';

test('sheet direction states the no-text clause while keeping expression names in the prompt',async()=>{
 const pia=await readFile(new URL('../crew/pia/SKILL.md',import.meta.url),'utf8');
 const recipe=await readFile(new URL('../character-sheet-recipe.md',import.meta.url),'utf8');
 const prompter=await readFile(new URL('../character-prompter.md',import.meta.url),'utf8');
 for(const [name,content] of [['pia',pia],['recipe',recipe],['prompter',prompter]])
  assert.match(content,/no text, labels, captions/i,`${name} must state the no-text clause`);
 assert.match(recipe,/Name each expression explicitly in the authored prompt for the model/);
 assert.match(recipe,/must never be rendered as text/);
});

test('sheet prompt validator rejects prompts without the no-text clause',()=>{
 let p=initialProject('sheet-text',inputs,{workflowRevision:2,reviewMode:'qualified'});
 p.artifacts.push({id:'script@1',key:'script',kind:'script',version:1,digest:'s',content:{beats:[1,2,3,4].map(i=>({beat:i,durationSeconds:15,narration:'x',emotionalPurpose:'c',sourceAnswers:['scene1Childhood']})),commonSenseChecks:[]},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
 p.artifacts.push({id:'roster@1',key:'roster',kind:'roster',version:1,digest:'r',content:{characters:[{id:'alex',name:'Alex',ageVariant:'adult',important:true,references:[image(1)],notes:'x'}]},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
 p.artifacts.push({id:'candidates:alex@1',key:'candidates:alex',kind:'candidates',version:1,digest:'c',content:{files:[image(1),image(2),image(3)],prompt:'character'},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()},selection:0});
 p.characterId='alex';p.step='sheetPrompt';p.gate='author';
 const base={recipeSha256:characterRecipeSha256,referenceSha256:image(1).sha256,turnaround:['front','three-quarter','profile','back'],expressions:Array(8).fill('neutral')};
 assert.throws(()=>send(p,'artifact',{workerId:'pia',content:{...base,prompt:'A sheet with four views and eight expressions.'}}),/SHEET_PROMPT_NO_TEXT_REQUIRED/);
 const ok=send(p,'artifact',{workerId:'pia',content:{...base,prompt:'A sheet with four views and eight expressions. No text, labels, captions, expression names or watermarks anywhere in the image.'}});
 assert.equal(ok.gate,'review');
});

test('Vera sheet example carries the no-text clause',async()=>{
 const vera=await readFile(new URL('../crew/vera/SKILL.md',import.meta.url),'utf8');
 assert.match(vera,/No rendered text/);
});
