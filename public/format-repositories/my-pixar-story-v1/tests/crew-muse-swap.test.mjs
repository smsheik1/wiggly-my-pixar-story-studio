// Crew swap to Muse Spark 1.3 Contributor (Oct 11 2026): every agent on OpenRouter Muse,
// production effort xhigh + 32K output for Muse only, and no crew command needs Codex.
// No network: every fetcher is local; no real codex is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadStudio} from '../runtime/instructions.mjs';
import {CrewHost} from '../runtime/crew-host.mjs';
import {OpenRouterHost,OPENROUTER_MAX_TOKENS,MUSE_MAX_TOKENS,AVA_MAX_TOKENS,modelTraits,AUDIO_CAPABLE_OPENROUTER_MODELS} from '../runtime/openrouter-host.mjs';

const MUSE='meta/muse-spark-1.3-contributor';
const AVA='google/gemini-3.8-flash';
const verifyOk=(model)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model,choices:[{finish_reason:'stop',message:{role:'assistant',content:'pong'}}]})});

test('1. every crew agent resolves to OpenRouter (Muse, except audio-capable Gemini Ava); Ava keeps Gemini/Cartesia audio perception tools', {timeout:10000}, () => {
 const {config}=loadStudio();
 const roles=Object.keys(config.agents);
 assert.equal(roles.length,17);
 for(const role of roles){assert.equal(config.agents[role].backend,'openrouter',role);assert.equal(config.agents[role].model,role==='audio-reviewer'?AVA:MUSE,role);}
 assert.deepEqual(config.agents['audio-reviewer'].tools,['readAsset','listenAudio','measureAudio','transcribe','speakerSimilarity']);
 assert.equal(config.generation.mediaReview.provider,'gemini');
 // Muse takes images (Vera/June/Cleo...) but not audio: listening must stay a perception tool.
 assert.ok(modelTraits(MUSE).inputs.includes('image'));assert.ok(!modelTraits(MUSE).inputs.includes('audio'));
 // Ava's own binding hears audio too: Gemini is in the committed audio allowlist.
 assert.ok(AUDIO_CAPABLE_OPENROUTER_MODELS.includes(config.agents['audio-reviewer'].model));
 assert.ok(modelTraits(AVA).inputs.includes('audio'));
});

test('2. no crew command needs Codex with the shipped config, even with old Sol workers still bound', {timeout:10000}, () => {
 const {config}=loadStudio();
 const oldSol=[{role:'script-writer',backend:'codex'},{role:'visual-reviewer',backend:'codex'},{role:'scene-reviewer'}];
 for(const command of ['crew-start','crew-refresh'])assert.deepEqual(CrewHost.backendsNeeded(command,config,oldSol),{codex:false,openrouter:true},command);
 for(const command of ['drive-codex','work-codex','dispatch-reconcile']){
  assert.deepEqual(CrewHost.backendsNeeded(command,config,[]),{codex:false,openrouter:true},command);
  assert.deepEqual(CrewHost.backendsNeeded(command,config,null),{codex:false,openrouter:true},command);
 }
 // A worker still bound to codex keeps Codex for dispatch only (refresh it first).
 assert.equal(CrewHost.backendsNeeded('drive-codex',config,oldSol).codex,true);
 // A config that puts a role back on codex still starts Codex.
 const mixed=structuredClone(config);mixed.agents['script-writer'].backend='codex';
 assert.equal(CrewHost.backendsNeeded('crew-start',mixed,[]).codex,true);
 assert.equal(new CrewHost({config}).needsCodex(Object.keys(config.agents)),false);
});

test('3. runner derives Codex need from CrewHost.backendsNeeded (no "no crew yet => start codex" fallback)', {timeout:10000}, async () => {
 const src=await readFile(new URL('../runner.mjs',import.meta.url),'utf8');
 assert.match(src,/CrewHost\.backendsNeeded\(command,studioConfig,status\.project\.crew\?\.workers\)/);
 assert.doesNotMatch(src,/\|\|!status\.project\.crew;/);
 // Codex host code is kept for legacy runs.
 assert.match(src,/new CodexHost\(/);
});

test('4. full crew-start binds all 17 roles on OpenRouter (Muse + Gemini Ava) with codex:null and one verify call per model', {timeout:10000}, async () => {
 const dir=await mkdtemp(join(tmpdir(),'memoir-muse-swap-'));
 try{
  const secretsPath=join(dir,'secrets.env');await writeFile(secretsPath,'OPENROUTER_API_KEY=test-key\n');
  const bodies=[];
  const openrouter=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{const b=JSON.parse(init.body);bodies.push(b);return verifyOk(b.model);}});
  const {config}=loadStudio();
  const crew=await new CrewHost({codex:null,openrouter,config}).startCrew(null,config);
  assert.equal(crew.workers.length,17);
  for(const w of crew.workers){assert.equal(w.backend,'openrouter');assert.equal(w.modelVersion,w.role==='audio-reviewer'?AVA:MUSE,w.role);}
  assert.equal(bodies.length,2);assert.deepEqual(bodies.map(b=>b.model).sort(),[AVA,MUSE].sort());
 }finally{await rm(dir,{recursive:true});}
});

test('5. production effort/output: Muse xhigh + 32K, DeepSeek medium + 16K, Gemini medium + 16K (never Muse overrides); host-wide xhigh/max still refused', {timeout:10000}, async () => {
 const dir=await mkdtemp(join(tmpdir(),'memoir-muse-effort-'));
 try{
  const secretsPath=join(dir,'secrets.env');await writeFile(secretsPath,'OPENROUTER_API_KEY=test-key\n');
  const bodies=[];
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{const b=JSON.parse(init.body);bodies.push(b);return verifyOk(b.model);}});
  await host.chat({model:MUSE,messages:[{role:'user',content:'x'}],verify:true});
  await host.chat({model:'deepseek/deepseek-v4.1-flash',messages:[{role:'user',content:'x'}],verify:true});
  await host.chat({model:AVA,messages:[{role:'user',content:'x'}],verify:true});
  assert.deepEqual(bodies[0].reasoning,{effort:'xhigh'});assert.equal(bodies[0].max_tokens,MUSE_MAX_TOKENS);assert.equal(MUSE_MAX_TOKENS,32000);
  assert.deepEqual(bodies[1].reasoning,{effort:'medium'});assert.equal(bodies[1].max_tokens,OPENROUTER_MAX_TOKENS);
  assert.deepEqual(bodies[2].reasoning,{effort:'medium'});assert.equal(bodies[2].max_tokens,AVA_MAX_TOKENS);
  assert.equal(host.effortFor(AVA),'medium');assert.equal(host.maxTokensFor(AVA),AVA_MAX_TOKENS);
  // 9,739 completion tokens in one head-to-head Muse request: it must fit with room to spare.
  assert.ok(MUSE_MAX_TOKENS>=3*9739);
  for(const reasoningEffort of ['xhigh','max'])assert.throws(()=>new OpenRouterHost({cwd:dir,reasoningEffort}),/OPENROUTER_REASONING_LIMIT/);
  // An explicit maxTokens still wins (tests/eval can cap lower).
  assert.equal(new OpenRouterHost({cwd:dir,maxTokens:1000}).maxTokensFor(MUSE),1000);
 }finally{await rm(dir,{recursive:true});}
});
