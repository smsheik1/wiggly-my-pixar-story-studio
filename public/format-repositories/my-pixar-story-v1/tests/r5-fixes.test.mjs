import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenRouterHost,OPENROUTER_PROVIDER_POLICY,OPENROUTER_MODEL_TRAITS,providerPolicyFor} from '../runtime/openrouter-host.mjs';
import {createTracer,tracingProjectName,TRACING_PROJECT} from '../runtime/tracing.mjs';

test('per-model price ceiling: Gemini gets $1/$5, others keep the $0.30/$1.20 default',{timeout:10000},()=>{
 assert.deepEqual(providerPolicyFor('meta/muse-spark-1.3-contributor').max_price,{prompt:0.3,completion:1.2});
 assert.deepEqual(providerPolicyFor('unknown/model'),OPENROUTER_PROVIDER_POLICY);
 const g=providerPolicyFor('google/gemini-3.8-flash');
 assert.deepEqual(g.max_price,{prompt:1,completion:5});
 assert.equal(g.require_parameters,true);
 assert.ok(g.max_price.prompt>=0.75&&g.max_price.completion>=3.75,'covers Gemini 3.8 Flash pricing');
 const host=new OpenRouterHost({cwd:tmpdir(),secretsPath:'/nonexistent',model:'google/gemini-3.8-flash'});
 assert.deepEqual(host.requestSettings('google/gemini-3.8-flash').provider.max_price,{prompt:1,completion:5});
 assert.deepEqual(host.requestSettings('meta/muse-spark-1.3-contributor').provider.max_price,{prompt:0.3,completion:1.2});
});

test('per-model price ceiling is never silently unlimited',{timeout:10000},()=>{
 const saved=OPENROUTER_MODEL_TRAITS['google/gemini-3.8-flash'].maxPrice;
 try{
  for(const bad of [{prompt:1},{prompt:Infinity,completion:5},{prompt:0,completion:5},{prompt:'1',completion:5},{}]){
   OPENROUTER_MODEL_TRAITS['google/gemini-3.8-flash'].maxPrice=bad;
   assert.throws(()=>providerPolicyFor('google/gemini-3.8-flash'),/OPENROUTER_MAX_PRICE_INVALID/);
  }
 }finally{OPENROUTER_MODEL_TRAITS['google/gemini-3.8-flash'].maxPrice=saved;}
});

test('failed command ends the root trace as error, successful one does not',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'r5-trace-'));
 try{
  const client={};
  const t=await createTracer({runId:'r5-fail',runDir:dir,rootName:'crew-start',client});
  t.fail(new Error('OPENROUTER_MODEL_UNAVAILABLE: google/gemini-3.8-flash was rejected'));
  await t.flush(2000);
  const ev=client.captured.find(r=>r.phase==='root-error');
  assert.ok(ev,'root-error captured');assert.equal(ev.outcome,'error');assert.match(ev.error,/OPENROUTER_MODEL_UNAVAILABLE/);
  assert.equal(t.failed!==null,true);
  const journal=await readFile(join(dir,'trace','trace.jsonl'),'utf8');
  assert.match(journal,/"phase":"root-error"/);
  const okClient={};const ok=await createTracer({runId:'r5-ok',runDir:dir,rootName:'status',client:okClient});
  await ok.flush(2000);
  assert.equal(okClient.captured.some(r=>r.phase==='root-error'),false);assert.equal(ok.failed,null);
 }finally{await rm(dir,{recursive:true});}
});

test('LangSmith project: WIGGLY_LANGSMITH_PROJECT, then LANGSMITH_PROJECT, then the default',{timeout:10000},async()=>{
 assert.equal(tracingProjectName({}),'wiggly-my-pixar-story');
 assert.equal(TRACING_PROJECT,'wiggly-my-pixar-story');
 assert.equal(tracingProjectName({LANGSMITH_PROJECT:'ls-proj'}),'ls-proj');
 assert.equal(tracingProjectName({LANGSMITH_PROJECT:'ls-proj',WIGGLY_LANGSMITH_PROJECT:'wiggly-r5'}),'wiggly-r5');
 assert.equal(tracingProjectName({WIGGLY_LANGSMITH_PROJECT:'  ',LANGSMITH_PROJECT:''}),'wiggly-my-pixar-story');
 const saved={w:process.env.WIGGLY_LANGSMITH_PROJECT,l:process.env.LANGSMITH_PROJECT};
 try{
  process.env.WIGGLY_LANGSMITH_PROJECT='wiggly-r5';
  const dir=await mkdtemp(join(tmpdir(),'r5-proj-'));
  const client={};const t=await createTracer({runId:'p',runDir:dir,client});
  assert.equal(t.projectName,'wiggly-r5');
  assert.equal(client.captured.find(r=>r.phase==='root').project_name,'wiggly-r5');
  await t.flush(1000);await rm(dir,{recursive:true});
 }finally{
  if(saved.w===undefined)delete process.env.WIGGLY_LANGSMITH_PROJECT;else process.env.WIGGLY_LANGSMITH_PROJECT=saved.w;
  if(saved.l===undefined)delete process.env.LANGSMITH_PROJECT;else process.env.LANGSMITH_PROJECT=saved.l;
 }
});

test('Gemini bind ping keeps reasoning on (low effort), never disabled',{timeout:10000},async()=>{
 const bodies=[];
 const fetcher=async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'g1',choices:[{message:{content:'pong'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,cost:0}}),{status:200,headers:{'content-type':'application/json'}});};
 const {mkdtemp,writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'r5-gem-'));const secretsPath=join(dir,'secrets.env');await writeFile(secretsPath,'OPENROUTER_API_KEY=sk-or-test-key-123456\n');
 try{
  const host=new OpenRouterHost({cwd:dir,secretsPath,model:'google/gemini-3.8-flash',fetcher});
  await host.verifyModel('google/gemini-3.8-flash');
  assert.equal(bodies.length,1);
  assert.deepEqual(bodies[0].reasoning,{effort:'low'});
  assert.notEqual(bodies[0].reasoning?.enabled,false);
  assert.deepEqual(bodies[0].provider.max_price,{prompt:1,completion:5});
  assert.equal(host.requestSettings('google/gemini-3.8-flash').reasoning.effort,'medium');
  assert.equal(OPENROUTER_MODEL_TRAITS['google/gemini-3.8-flash'].reasoning,'always-on');
 }finally{await rm(dir,{recursive:true});}
});
