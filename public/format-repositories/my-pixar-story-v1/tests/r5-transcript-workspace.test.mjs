// r5: hyphen/punctuation-split words match their joined form; host-workspace is
// created on the OpenRouter crew-start path. No network; no codex is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transcriptDiff} from '../runtime/evaluators.mjs';
import {loadStudio} from '../runtime/instructions.mjs';
import {CrewHost} from '../runtime/crew-host.mjs';
import {OpenRouterHost} from '../runtime/openrouter-host.mjs';

const LINE='At home I watched Yugioh GX with my older sister and my little brother.';

test('Yugioh matches Yu-Gi-Oh! and Yu Gi Oh (the r5 audition line)',{timeout:10000},()=>{
 assert.equal(transcriptDiff(LINE,'"At home I watched Yu-Gi-Oh! GX with my older sister and my little brother.').editDistance,0);
 assert.equal(transcriptDiff(LINE,'At home I watched Yu Gi Oh GX with my older sister and my little brother.').editDistance,0);
 assert.equal(transcriptDiff('Yu-Gi-Oh GX','yugioh gx').editDistance,0);
 const full='Mia, when I was eight I wanted to be a scientist. I did not talk much and I wore sunglasses everywhere. At home I watched Yugioh GX with my older sister and my little brother.';
 assert.equal(transcriptDiff(full,'"Mia, when I was eight I wanted to be a scientist. I did not talk much and I wore sunglasses everywhere. At home I watched Yu-Gi-Oh! GX with my older sister and my little brother.').editDistance,0);
});

test('still strict: a missing word or a wrong word fails',{timeout:10000},()=>{
 assert.equal(transcriptDiff(LINE,'At home I watched Yu-Gi-Oh! GX with my sister and my little brother.').editDistance,1);
 assert.equal(transcriptDiff(LINE,'At home I watched Yu-Gi-Oh! GX with my older cousin and my little brother.').editDistance,1);
 assert.equal(transcriptDiff(LINE,'At home I watched Pokemon GX with my older sister and my little brother.').editDistance,1);
 assert.ok(transcriptDiff(LINE,'At home I watched Yu Gi GX with my older sister and my little brother.').editDistance>0);
 assert.equal(transcriptDiff('I was 8','I was eight').editDistance,0);
});

test('crew-start creates a missing host-workspace on the OpenRouter path',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'r5-ws-'));
 try{
  const secretsPath=join(dir,'secrets.env');await writeFile(secretsPath,'OPENROUTER_API_KEY=test-key\n');
  const cwd=join(dir,'run','host-workspace');
  const fetcher=async(url,init)=>{const b=JSON.parse(init.body);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:b.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:'pong'}}]})};};
  const openrouter=new OpenRouterHost({cwd,secretsPath,fetcher});
  const {config}=loadStudio();
  const crew=await new CrewHost({codex:null,openrouter,config}).startCrew(null,config);
  assert.equal(crew.workers.length,17);
  assert.ok((await stat(join(cwd,'crew-startup-openrouter.json'))).isFile());
 }finally{await rm(dir,{recursive:true});}
});

import {transcriptVariants,reviewerVariantAccepted} from '../runtime/evaluators.mjs';
const pass=(evidence)=>({criterion:'transcript',status:'pass',evidence});
test('reviewer variant: a cited spelling variant passes; uncited, missing, extra or too many do not',{timeout:10000},()=>{
 const ref='I drove my Honda Accord to Chicago.';
 const stt='I drove my Hondah Accord to Chicago.';
 assert.deepEqual(transcriptVariants(ref,stt).substitutions,[{expected:'honda',observed:'hondah'}]);
 assert.equal(reviewerVariantAccepted(ref,stt,pass('By ear "Honda" and "Hondah" are the same spoken word, a spelling variant.')),true);
 assert.equal(reviewerVariantAccepted(ref,stt,pass('Matches the line by ear.')),false,'must cite both words');
 assert.equal(reviewerVariantAccepted(ref,stt,{...pass('Honda vs Hondah, same word'),status:'inconclusive'}),false,'needs a pass');
 const missing='I drove my Accord to Chicago.';
 assert.equal(transcriptVariants(ref,missing).missingOrExtra,1);
 assert.equal(reviewerVariantAccepted(ref,missing,pass('honda missing but same')),false,'missing word is a hard fail');
 assert.equal(reviewerVariantAccepted(ref,'I drove my Honda Accord to Chicago today.',pass('today extra')),false,'extra word is a hard fail');
 assert.equal(reviewerVariantAccepted(ref,'Eye droved mai Hondah Accord to Chicago.',pass('i eye drove droved my mai honda hondah')),false,'more than two substitutions');
 assert.equal(reviewerVariantAccepted(ref,ref,undefined),true,'exact match needs no reviewer call');
});
test('workflow wires the reviewer variant rule into audition and narration transcript checks',{timeout:10000},async()=>{
 const {readFile}=await import('node:fs/promises');
 const src=await readFile(new URL('../runtime/workflow.mjs',import.meta.url),'utf8');
 assert.match(src,/reviewerVariantAccepted\(ref,t,variantCheck\)/);
 assert.match(src,/criterion==='transcript'\)\?\?r\.checks\.find\(c=>c\.criterion==='integrity'\)/);
 const skill=await readFile(new URL('../crew/ava/SKILL.md',import.meta.url),'utf8');
 assert.match(skill,/name both spellings in `evidence`/);assert.match(skill,/never a missing or extra word/);
});
