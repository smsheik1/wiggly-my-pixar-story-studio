import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildAll,buildAgent,ZONING_COLOUR,PROMO} from '../build-skills.mjs';
import {buildWorkerPacket,splitStablePrompt,systemSkillEnabled} from '../runtime/crew.mjs';
import {OpenRouterHost,DEFAULT_OPENROUTER_MODEL} from '../runtime/openrouter-host.mjs';

const manifest={shared:['base.md'],visualShared:[],agents:{x:{role:'x.md',visual:true}}};
const front='---\nname: x\ndescription: test\n---\n';
const base='## Base\n\n- Never invent people, events, traits or approvals; source facts come only from the task packet.\n';
const reader=files=>p=>files[p];

test('built crew skills are up to date with their sources (run node build-skills.mjs)',()=>{
 const built=buildAll({check:true});
 assert.ok(built.some(b=>b.path==='crew/pia/SKILL.md'));
 const pia=readFileSync(new URL('../crew/pia/SKILL.md',import.meta.url),'utf8');
 assert.match(pia,/^---\nname: pia\n/);assert.match(pia,/Built by build-skills\.mjs/);assert.match(pia,/## Crew base rules/);assert.match(pia,/C-HEADS-TALL/);
});

test('build is stable: same sources give the same bytes and hash',()=>{
 const files={'base.md':base,'x.md':front+'# X\n\nDo x.\n'};
 const a=buildAgent(manifest,'x',{readSource:reader(files)}),b=buildAgent(manifest,'x',{readSource:reader(files)});
 assert.equal(a.text,b.text);assert.equal(a.sha256,b.sha256);
 const c=buildAgent(manifest,'x',{readSource:reader({...files,'base.md':base+'\n- Quote word for word.\n'})});
 assert.notEqual(a.sourcesSha,c.sourcesSha);
});

test('build checks: duplicate section, copied shared rule, zoning colour, promo, forbidden term',()=>{
 const run=role=>()=>buildAgent(manifest,'x',{readSource:reader({'base.md':base,'x.md':front+role})});
 assert.throws(run('## Base\n'),/duplicate section "base"/);
 assert.throws(run('- Never invent people, events, traits or approvals; source facts come only from the task packet.\n'),/copies a shared rule/);
 assert.throws(run('Skin: warm, with a soft pink nose and rosy cheeks.\n'),/colour named for a face zone/);
 assert.throws(run('Made with Higgsfield, link below.\n'),/promo/);
 assert.throws(run('Use Seedance for the video.\n'),/forbidden term/);
 assert.throws(()=>buildAgent(manifest,'x',{readSource:reader({'base.md':base+'Use a red accent.\n','x.md':front})}),/shared source names a colour/);
 assert.ok(ZONING_COLOUR.test('red nose'));assert.ok(!ZONING_COLOUR.test('rich deep brown skin, no colour words for nose'));assert.ok(PROMO.test('https://example.com'));
});

const task={step:'characterPrompt',taskId:'t1',gate:'author',workflowRevision:5,
 skill:{path:'crew/pia/SKILL.md',content:'SKILL-BODY-UNIQUE',sha256:'s1'},
 craft:[{id:'house-style',content:'CRAFT-BODY-UNIQUE',sha256:'c1'}],
 stepGuide:{path:'crew/pia/steps/characterPrompt.md',content:'STEP-BODY-UNIQUE',sha256:'g1'},
 communication:{path:'orchestrator-voice.md',content:'COMM-BODY-UNIQUE',sha256:'m1'},
 castEntry:{id:'kid',references:[]}};
const worker={workerId:'openrouter:sheet-prompter:test',name:'Pia',role:'sheet-prompter',modelVersion:DEFAULT_OPENROUTER_MODEL,backend:'openrouter'};

test('flag off by default: packet is unchanged and carries the skill',()=>{
 assert.equal(systemSkillEnabled({}),false);assert.equal(systemSkillEnabled({WIGGLY_SYSTEM_SKILL:'1'}),true);
 assert.equal(buildWorkerPacket(task,worker),buildWorkerPacket(task,worker,{stableInSystem:false}));
 assert.match(buildWorkerPacket(task,worker),/SKILL-BODY-UNIQUE/);
});

test('flag on: stable documents move to the system message once, pointers stay in the packet',()=>{
 const {stable}=splitStablePrompt(task);
 const order=['SKILL-BODY-UNIQUE','CRAFT-BODY-UNIQUE','STEP-BODY-UNIQUE','COMM-BODY-UNIQUE'].map(s=>stable.indexOf(s));
 assert.ok(order.every((v,i)=>v>=0&&(i===0||v>order[i-1])),'skill, craft, step guide, communication in order');
 const packet=buildWorkerPacket(task,worker,{stableInSystem:true});
 for(const s of ['SKILL-BODY-UNIQUE','CRAFT-BODY-UNIQUE','STEP-BODY-UNIQUE','COMM-BODY-UNIQUE'])assert.ok(!packet.includes(s),s);
 const p=JSON.parse(packet);
 assert.deepEqual(p.task.skill,{path:'crew/pia/SKILL.md',sha256:'s1',inSystemMessage:true});
 assert.deepEqual(p.task.craft,[{id:'house-style',sha256:'c1',inSystemMessage:true}]);
 assert.equal(p.task.castEntry.id,'kid');assert.match(p.instruction,/in the system message/);
});

test('runTask with WIGGLY_SYSTEM_SKILL=1 sends stable system first and the work order last',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-sysskill-'));const prev=process.env.WIGGLY_SYSTEM_SKILL;
 try{
  const secretsPath=join(dir,'secrets.env');await writeFile(secretsPath,'OPENROUTER_API_KEY=ISOLATED\n');
  const seen=[];const event={taskId:'t1',actor:'agent',workerId:worker.workerId,action:'artifact',content:{beats:[]}};
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{seen.push(JSON.parse(init.body));return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({eventJson:JSON.stringify(event)})}}]})};}});
  const w={...worker,capabilityVersion:await host.profile()};
  const t={...task,step:'script',allowedTools:[]};
  for(const flag of ['0','1']){
   process.env.WIGGLY_SYSTEM_SKILL=flag;
   await host.runTask(t,{worker:w,callTool:async()=>{throw new Error('no tools');}}).catch(()=>{});
  }
  const [off,on]=seen;
  assert.ok(!off.messages[0].content.includes('SKILL-BODY-UNIQUE'));assert.ok(JSON.stringify(off.messages[1]).includes('SKILL-BODY-UNIQUE'));
  assert.ok(on.messages[0].content.startsWith('You are Pia'));assert.ok(on.messages[0].content.includes('SKILL-BODY-UNIQUE'));
  assert.ok(!JSON.stringify(on.messages[1]).includes('SKILL-BODY-UNIQUE'));assert.equal(on.messages[1].role,'user');
 }finally{if(prev===undefined)delete process.env.WIGGLY_SYSTEM_SKILL;else process.env.WIGGLY_SYSTEM_SKILL=prev;await rm(dir,{recursive:true});}
});
