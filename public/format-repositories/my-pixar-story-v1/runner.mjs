#!/usr/bin/env node
import {loadStudio,studioFor,limitsFor,communicationFor} from './runtime/instructions.mjs';
import { PERCEPTION_ESTIMATES_USD } from './runtime/budget.mjs';
import {assertDebugReady,debugSnapshot} from './runtime/debug.mjs';
import { readFile, mkdir, writeFile, unlink, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { z } from 'zod';
import { VERSION, Content, Event, Review, Plans, Inputs, IntakeConfirmation, VoiceChoiceInput, digest } from './runtime/contracts.mjs';
import { openWorkflow, revisionImpact } from './runtime/workflow.mjs';
import { importMedia, verifyFiles, measureAudio } from './runtime/media.mjs';
import { executeJob, loadKey, remediation, checkProvider,lookupExistingVoice,atomicJson } from './runtime/providers.mjs';
import { current, locked, assertAllowed } from './runtime/gates.mjs';
import { renderFilm, inspectFilm } from './runtime/assemble.mjs';
import {prepareComposition, servePreview, verifyRenderer} from './runtime/remotion.mjs';
import { assemblyManifest, assertFilmInspection } from './runtime/studio.mjs';
import {presentDeliverable,producerUpdate} from './runtime/presentation.mjs';
import {Crew,crewRoles,runCrewTask,prepareCrewTask} from './runtime/crew.mjs';
import {CodexHost,driveCrew,reconcileDispatch,reconcileNotDispatched} from './runtime/codex-host.mjs';
import {OpenRouterHost} from './runtime/openrouter-host.mjs';
import {CrewHost} from './runtime/crew-host.mjs';
import {createGeminiReviewTools,GEMINI_REVIEW_PROFILE} from './runtime/gemini-review.mjs';
import {createCartesiaTranscriptionTool,CARTESIA_STT_PROFILE} from './runtime/cartesia-stt.mjs';
import {createAudioEditTools,AUDIO_EDIT_PROFILE} from './runtime/audio-edit.mjs';
import {AudioCase,audioTask,qualifyAudio,requireAudioQualification} from './evaluation/audio-qualification.mjs';
import { VisualCase, visualTask, qualifyVisual, requireVisualQualification } from './evaluation/visual-qualification.mjs';
import { Cassette, recordingFetcher, replayFetcher, recordingSpawn, replaySpawn, normalizeForCassette } from './runtime/cassette.mjs';
import { bibleSummary, renderBibleMarkdown, parseBible, unresolvedPaths } from './runtime/bible.mjs';
import { createInterface } from 'node:readline/promises';
import { requireSpendHeadroom } from './runtime/spend-preflight.mjs';
import { endOfRunCheck } from './runtime/end-of-run.mjs';
// r5 spend preflight: skipped for replays and when explicitly disabled; a missing
// OpenRouter key is not a blocker here (the paid call reports it itself).
async function spendPreflight(runDir, step, estimatedCostUsd) {
  if (process.env.WIGGLY_REPLAY_CASSETTE || process.env.WIGGLY_SPEND_PREFLIGHT === 'off') return null;
  try { await readFile(secretsPath, 'utf8'); } catch { return null; }
  if (!/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*\S/m.test(await readFile(secretsPath, 'utf8'))) return null;
  try { return await requireSpendHeadroom({ runDir, secretsPath, step, estimatedCostUsd }); }
  catch (e) { if (e.code !== 'SPEND_PREFLIGHT_BLOCKED') throw e; process.stdout.write(JSON.stringify({ paused: true, blocker: e.blocker }, null, 2) + '\n'); process.exitCode = 3; return { paused: true }; }
}
const root = dirname(fileURLToPath(import.meta.url));
const rawProcessArgv = [...process.argv];
// Run-dir paths differ between a recording and its replay sandbox; both sides
// normalize them to <RUN> so only real request differences mismatch.
const runDirAliases = dir => { const out = { [dir]: '<RUN>' }; try { out[fs.realpathSync(dir)] = '<RUN>'; } catch {} return out; };
const args = process.argv.slice(2); const command = args.shift();
function option(name, fallback) { const i = args.indexOf(`--${name}`); if (i < 0) return fallback; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.`); args.splice(i, 2); return value; }
const runDir = resolve(option('run', join(root, 'agent-runs', 'draft')));
const secretsPath = resolve(option('secrets', join(root, 'secrets.env')));
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
async function lock() {
  await mkdir(runDir, { recursive: true }); const path = join(runDir, 'writer.lock');
  try { await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = JSON.parse(await readFile(path, 'utf8')); let active = true;
    try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') active = false; else throw error; }
    if (active) throw new Error(`RUN_BUSY: process ${prior.pid} owns this run.`);
    await unlink(path); await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  }
  return () => unlink(path);
}
function presentation(status) {
  const { project, pending } = status;
  // A failed candidate never becomes the ordinary user-facing deliverable.
  const visible = ['approved','provisional'].includes(pending.artifact?.review?.decision) || pending.gate === 'review' || pending.gate === 'author';
  return {producer:producerUpdate(status,runDir),debug:project.debug??{enabled:false,paused:false},...(project.bible?{productionBible:bibleSummary(project,runDir)}:{}), formatVersion: VERSION, checkpointId: status.checkpointId, sequence: project.sequence, communication:communicationFor(project),pending: { ...pending, artifact: visible ? pending.artifact : null },
    validArtifacts: project.artifacts.filter(a => a.valid).map(a => ({ id: a.id, digest: a.digest, kind: a.kind, approved: !!a.approvedBy })),
    jobs: project.jobs.map(j => ({ id: j.id, status: j.status, digest: j.digest, providerJobId: j.providerJobId })), allowances: project.allowances };
}
async function verifySubmission(status,event){
  await verifyFiles({content:event.content,intakeConfirmation:event.intakeConfirmation});
  if(['artifact','plan','approve','authorize','owner-review'].includes(event.action)||event.action==='review'&&event.review?.decision!=='inconclusive')await verifyFiles(status.project.artifacts.filter(a=>a.valid));
}

// Test-only Decisions fetcher (NODE_ENV=test + WIGGLY_TEST_DECISIONS_FIXTURE): answers every
// requested question from a canned fixture. Never active outside tests; no network.
async function testDecisionsFetcher(){
  if(process.env.NODE_ENV!=='test'||!process.env.WIGGLY_TEST_DECISIONS_FIXTURE)return undefined;
  const fx=JSON.parse(await readFile(process.env.WIGGLY_TEST_DECISIONS_FIXTURE,'utf8'));
  return async(_url,init)=>{
    const body=JSON.parse(init.body),answers={};
    for(const name of Object.keys(body.questions??{}))answers[name]=name==='rank'?{type:'choice',...fx.rank}:{type:'noul',noul:fx.noul};
    return new Response(JSON.stringify({id:'gen-dec-test',model:fx.model??body.model,answers,usage:fx.usage??{input_tokens:100,output_tokens:0,cost:0.0001}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
}

async function main() {
  if(command==='check-provider'){const provider=option('provider');if(args.length)throw new Error('Unknown provider check arguments.');print(await checkProvider(provider,secretsPath));return;}
  if(command==='crew-template'){print({workers:Object.entries(crewRoles).map(([role,definition])=>({role,name:definition.name,workerId:`bind-host-${role}`,modelVersion:'inherit-host-model',capabilityVersion:'bind-actual-tools-v1',execution:'host',backend:definition.backend??'codex'})),instruction:'Use your current host model and actual independent worker IDs; replace template model/capability values with the actual deployed versions before configuration. Keep each role on its configured backend (codex|openrouter). No external model is required.'});return;}
  if(command==='audio-tasks'){const cases=z.array(AudioCase).parse(await json(option('dataset'))),split=option('split','holdout');if(!['calibration','holdout'].includes(split))throw new Error('Invalid audio split.');print(cases.filter(c=>c.split===split).map(audioTask));return;}
  if(command==='visual-tasks'){const cases=z.array(VisualCase).parse(await json(option('dataset'))),split=option('split','holdout');if(!['calibration','holdout'].includes(split))throw new Error('Invalid visual split.');print(cases.filter(c=>c.split===split).map(visualTask));return;}
  // Department evals (golden cases per crew department). Replay by default (free, offline);
  // --live --confirm-spend is the only paid mode, hard-capped in code. Exits 1 on regression.
  // Text export of a run's trace journal (per step: agent, prompt, response, tool calls, cost).
  if (command === 'trace-export') {
    const { parseArgs } = await import('node:util');
    const { values } = parseArgs({ args: rawProcessArgv.slice(3), options: { run: { type: 'string' }, out: { type: 'string' } }, allowPositionals: false });
    const { traceExport } = await import('./runtime/trace-export.mjs');
    try {
      const r = await traceExport({ run: values.run ? resolve(values.run) : null, out: values.out ? resolve(values.out) : null });
      if (values.out) process.stderr.write(`trace-export: wrote ${resolve(values.out)} from ${r.path}\n`); else process.stdout.write(r.markdown + '\n');
    } catch (error) { if (!error.exitCode) throw error; process.stderr.write(error.message + '\n'); process.exitCode = error.exitCode; }
    return;
  }
  if (command === 'dept-eval') { const { cli } = await import('./evaluation/dept-evals.mjs'); process.exitCode = await cli(rawProcessArgv.slice(3)); return; }
  if (command === 'eval' || command === 'eval-tasks' || command === 'eval-export') {
    const { validateDataset, selectCases, taskForCase, runEvaluation, langsmithExamples } = await import('./evaluation/harness.mjs');
    const dataset = validateDataset(await json(option('dataset', join(root, 'evaluation', 'dataset.json'))));
    const split = option('split', 'calibration'); const output = option('out'); const responses = option('predictions'); const mediaRoot = option('media-root');
    if (args.length) throw new Error(`Unknown evaluation arguments: ${args.join(' ')}`);
    const result = command === 'eval-tasks' ? selectCases(dataset, split).map(taskForCase) : command === 'eval-export' ? langsmithExamples(dataset, split) :
      await runEvaluation(dataset, { split, predictions: responses ? await json(responses) : undefined, mediaRoot });
    if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); print({ path: resolve(output), productionStateMutated: false, apiCalls: 0 }); }
    else print(result);
    return;
  }
  // Production bible files outside a run (e.g. a draft written before the run exists).
  if(command==='bible-validate'||(command==='bible-render'&&args.includes('--file'))){
    const file=option('file'),out=option('out');if(!file||args.length)throw new Error(`${command} needs --file <bible.json>${command==='bible-render'?' and optional --out <path>':''}.`);
    const parsed=parseBible(await json(file));
    if(command==='bible-validate'){print({valid:true,hash:parsed.hash,openQuestions:parsed.content.openQuestions.length,unresolved:parsed.unresolved,signable:!parsed.content.openQuestions.length&&!parsed.unresolved.length});return;}
    const md=renderBibleMarkdown({version:0,hash:parsed.hash,state:'draft',content:parsed.content});
    if(out){await writeFile(resolve(out),md,{mode:0o600});print({path:resolve(out),hash:parsed.hash,state:'unsigned draft (file)'});}else process.stdout.write(md);
    return;
  }
  if (command === 'recipe' || command === 'background-recipe') { const content = await readFile(join(root, command === 'background-recipe' ? 'background-prompter.md' : 'character-sheet-recipe.md'), 'utf8'); print({ path: join(root, command === 'background-recipe' ? 'background-prompter.md' : 'character-sheet-recipe.md'), sha256: (await import('./runtime/media.mjs')).sha(Buffer.from(content)), content }); return; }
  if (command === 'check') {
    const tools = Object.fromEntries(['ffprobe', 'ffmpeg', 'tar'].map(tool => [tool, spawnSync(tool, ['-version'], { stdio: 'ignore' }).error?.code !== 'ENOENT']));
    const renderer=await verifyRenderer();
    const studio=loadStudio();
    print({studioVersion:studio.config.version,studioSha256:studio.sha256,instructionFiles:Object.keys(studio.documents),formatVersion: VERSION, node: process.version, tools, renderer:renderer.manifest.renderer, dependencies: 'LangGraph + SQLite loaded',
      requiredKeys: ['CARTESIA_API_KEY', 'REPLICATE_API_TOKEN (video stage)'], imageKeys: ['no key for default agy provider; META_API_KEY only for meta-muse fallback'], conditionalKeys:['GEMINI_API_KEY (shipped Codex media review)'], optionalKeys:['ELEVENLABS_API_KEY (generated music/effects; imports need no key)'], credentialsRead: false, productionStageLimit: 'supervised v1 through private finalization; every media lock needs human review and every video request needs exact human authorization; qualified policy remains available; real production proof not performed' });
    if (Object.values(tools).some(v => !v)) process.exitCode = 1; return;
  }
  if (command === 'schema') {
    const name = args[0]; const schema = name === 'crew' ? Crew : name === 'event' ? Event : name === 'review' ? Review : name === 'plan' ? Plans : name === 'inputs' ? Inputs : name==='intake-confirmation'?IntakeConfirmation:Content[name];
    if (!schema) throw new Error('schema needs event/review/plan/inputs or a supported artifact kind.'); print(z.toJSONSchema(schema)); return;
  }
  if (command === 'replay') {
    const replayCassette = option('cassette');
    const replayRun = option('run');
    const expectSameOutput = args.includes('--expect-same-output');
    if (expectSameOutput) args.splice(args.indexOf('--expect-same-output'), 1);

    let cassetteDirs = [];
    if (replayCassette) {
      cassetteDirs.push(resolve(replayCassette));
    } else if (replayRun) {
      const cassBase = resolve(replayRun, 'cassettes');
      const entries = await readdir(cassBase).catch(() => []);
      for (const ent of entries.sort()) {
        cassetteDirs.push(join(cassBase, ent));
      }
    } else {
      throw new Error('replay needs --cassette <dir> or --run <run>');
    }

    let allOk = true;

    async function getDirFiles(dir, base = dir) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const files = [];
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          files.push(...(await getDirFiles(full, base)));
        } else if (ent.isFile()) {
          files.push(full.slice(base.length + 1));
        }
      }
      return files;
    }

    async function compareRunDirs(dirA, dirB) {
      const filesA = (await getDirFiles(dirA)).sort();
      const filesB = (await getDirFiles(dirB)).sort();
      const filter = (f) =>
        !f.startsWith('cassettes') &&
        // Trace journal: timestamps/durations/ids differ per run by design.
        !f.startsWith('trace/') &&
        // Bookkeeping with wall-clock stamps (reviewer attempt counts, verdict cache, escalations).
        !f.startsWith('review-attempts/') && !f.startsWith('review-cache/') && !f.startsWith('escalations/') &&
        f !== 'writer.lock' &&
        f !== 'secrets.env' &&
        !f.endsWith('-shm') &&
        !f.endsWith('-wal');
      const aList = filesA.filter(filter);
      const bList = filesB.filter(filter);

      for (const f of aList) {
        if (!bList.includes(f)) return { output: 'changed', firstOutputDifference: f };
        if (f === 'checkpoints.sqlite') {
          // Compare SQLite checkpoints semantically to ignore non-deterministic UUIDs and timestamps
          try {
            const { DatabaseSync } = await import('node:sqlite');
            const d1 = new DatabaseSync(join(dirA, f));
            const d2 = new DatabaseSync(join(dirB, f));
            const row1 = d1.prepare("SELECT checkpoint FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 1;").get();
            const row2 = d2.prepare("SELECT checkpoint FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 1;").get();
            d1.close();
            d2.close();
            if (row1 && row2) {
              const p1 = JSON.parse(Buffer.from(row1.checkpoint).toString('utf8'));
              const p2 = JSON.parse(Buffer.from(row2.checkpoint).toString('utf8'));
              const stripTimestamps = (obj) =>
                JSON.parse(JSON.stringify(obj, (k, v) => {
                  if (k === 'at' || k === 'ts' || k === 'checkpoint_id' || (k === 'id' && typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/.test(v))) return undefined;
                  return v;
                }));
              const s1 = JSON.stringify(stripTimestamps(p1.channel_values));
              const s2 = JSON.stringify(stripTimestamps(p2.channel_values));
              if (s1 === s2) {
                continue;
              }
            } else if (!row1 && !row2) {
              continue;
            }
          } catch {}
        }
        const contentA = await readFile(join(dirA, f));
        const contentB = await readFile(join(dirB, f));
        if (createHash('sha256').update(contentA).digest('hex') !== createHash('sha256').update(contentB).digest('hex')) {
          return { output: 'changed', firstOutputDifference: f };
        }
      }
      for (const f of bList) {
        if (!aList.includes(f)) return { output: 'changed', firstOutputDifference: f };
      }
      return { output: 'identical', firstOutputDifference: null };
    }

    for (const cDir of cassetteDirs) {
      const cassette = await Cassette.open(cDir);
      const beforeDir = join(cDir, 'before');
      const tmpDir = await mkdtemp(join(tmpdir(), 'memoir-replay-'));
      try {
        const beforeEntries = await readdir(beforeDir).catch(() => []);
        for (const ent of beforeEntries) {
          await cp(join(beforeDir, ent), join(tmpDir, ent), { recursive: true });
        }

        const dummySecrets = join(tmpDir, 'secrets.env');
        await writeFile(
          dummySecrets,
          'OPENROUTER_API_KEY=replay-dummy\nGEMINI_API_KEY=replay-dummy\nCARTESIA_API_KEY=replay-dummy\n',
          { mode: 0o600 }
        );

        // Prepare child args: process.execPath runner.mjs <recorded argv> --run <tmp> --secrets <dummy>
        const recordedArgv = cassette.header?.argv ?? [];
        const runnerPath = fileURLToPath(import.meta.url);
        // recordedArgv starts with node / runner.mjs or command
        let childArgs = [];
        let startIndex = 0;
        if (recordedArgv.length > 0 && (recordedArgv[0].endsWith('node') || recordedArgv[0] === 'node' || recordedArgv[0] === process.execPath)) {
          startIndex++;
        }
        if (recordedArgv.length > startIndex && (recordedArgv[startIndex].endsWith('runner.mjs') || recordedArgv[startIndex] === 'runner.mjs')) {
          startIndex++;
        }
        childArgs = recordedArgv.slice(startIndex);
        // Filter out any --record if present
        childArgs = childArgs.filter((a) => a !== '--record');
        childArgs.push('--run', tmpDir, '--secrets', dummySecrets);

        const childEnv = {
          ...process.env,
          WIGGLY_REPLAY_CASSETTE: cDir,
          WIGGLY_TRACING: 'off'
        };
        delete childEnv.WIGGLY_RECORD;

        const childResult = spawnSync(process.execPath, [runnerPath, ...childArgs], {
          env: childEnv,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const childExitCode = childResult.status ?? (childResult.signal ? 1 : 0);
        const childStderr = childResult.stderr || '';

        // Extract mismatch if any from stderr or cassette
        let mismatch = null;
        const mismatchMatch = childStderr.match(/REPLAY_(?:MISMATCH|EXHAUSTED|INCOMPLETE):[^\n]+/);
        if (mismatchMatch) {
          mismatch = mismatchMatch[0].trim();
        }

        const recordedExitCode = cassette.result?.exitCode ?? 0;
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const tmpDbPath = join(tmpDir, 'checkpoints.sqlite');
          const syncDb = new DatabaseSync(tmpDbPath);
          syncDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          syncDb.close();
        } catch {}
        const afterDir = join(cDir, 'after');
        const compareTarget = (await readdir(afterDir).catch(() => null)) ? afterDir : beforeDir;
        const comp = await compareRunDirs(compareTarget, tmpDir);

        // Check profile overridden
        let nowCodexProf = null, nowOrProf = null;
        try {
          const testCodexHost = new CodexHost({ cwd: tmpDir, spawnProcess: replaySpawn({ codexEntries: [], nextCodexIndex: 0, secrets: [], recordMismatch() {} }), codexVersion: () => cassette.header?.codexVersion ?? 'unknown' });
          nowCodexProf = await testCodexHost.profile();
          testCodexHost.close();
        } catch {}
        try {
          const testOrHost = new OpenRouterHost({ cwd: tmpDir, secretsPath: dummySecrets });
          nowOrProf = await testOrHost.profile();
        } catch {}

        const recordedCodexProf = cassette.header?.profiles?.codex ?? null;
        const recordedOrProf = cassette.header?.profiles?.openrouter ?? null;

        const profileOverridden = {
          codex: !!(recordedCodexProf && nowCodexProf && recordedCodexProf !== nowCodexProf),
          openrouter: !!(recordedOrProf && nowOrProf && recordedOrProf !== nowOrProf)
        };

        const calls = {
          http: cassette.httpEntries.length,
          codex: cassette.codexEntries.filter((e) => e.dir === 'out').length
        };

        let ok = childExitCode === 0 && !mismatch;
        if (expectSameOutput && comp.output !== 'identical') {
          ok = false;
        }
        if (!ok) {
          allOk = false;
        }

        const doc = {
          cassette: cDir,
          ok,
          calls,
          mismatch,
          exitCode: { recorded: recordedExitCode, now: childExitCode },
          output: comp.output,
          firstOutputDifference: comp.firstOutputDifference,
          profileOverridden
        };
        print(doc);
      } finally {
        await rm(tmpDir, { recursive: true }).catch(() => {});
      }
    }

    if (!allOk) {
      process.exitCode = 1;
    }
    return;
  }
  const release = await lock(); const workflow = openWorkflow(join(runDir, 'checkpoints.sqlite'));
  try {
    if (command === 'init') {
      const inputs = await json(args[0]); const studioDefaults = loadStudio(); const gates = option('gates', studioDefaults.config.gates?.defaultPolicy ?? 'per-step'); if(!['per-step','pick-only'].includes(gates)) throw new Error('--gates must be per-step|pick-only.'); const rehearsal = option('rehearsal', 'false') === 'true'; const biblePolicy = option('bible', rehearsal ? 'advisory' : 'required'); if(!['required','advisory','off'].includes(biblePolicy)) throw new Error('--bible must be required|advisory|off.'); print(presentation(await workflow.init('project', inputs,{reviewMode:option('review-mode','supervised'),gatePolicy:gates,biblePolicy,rehearsal}))); return;
    }
    if (command === 'import') { print(await importMedia(args[0], runDir)); return; }
    const status = await workflow.status('project');
    if(command==='reuse-voice'){const message=option('message');if(!message||args.length)throw new Error('reuse-voice needs the actual human instruction.');print(presentation(await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'reuse-voice',message})));return;}
    if(['use-voice','verify-voice'].includes(command)){
      let selected=status;
      if(command==='use-voice'){
        const voiceId=option('id'),name=option('name'),message=option('message'),consentMessage=option('consent-message');
        const content=VoiceChoiceInput.parse({voiceId,name,consentMessage,reuseWithoutSample:true});if(!message||args.length)throw new Error('use-voice needs the exact human selection and own-voice consent messages.');
        selected=await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'choose-voice',message,content});
      }else if(args.length||!status.project.voiceChoice)throw new Error('verify-voice requires the current human-selected voice.');
      const p=selected.project;
      if(!locked(p,'script')||!['voiceSample','clone'].includes(p.step)||p.jobs.length||current(p,'clone'))throw new Error('EXISTING_VOICE_LOCKED: no lookup/rebinding after provider work or clone binding.');
      selected=await workflow.respond('project',{taskId:selected.pending.taskId,actor:'runtime',action:'voice-verification-start'});
      const content=await lookupExistingVoice(selected.project,secretsPath),receiptId=`voice-lookup:${digest(content)}`;
      const directory=join(runDir,'voice-lookups');await mkdir(directory,{recursive:true,mode:0o700});const receiptPath=join(directory,digest(content)+'.json');await atomicJson(receiptPath,content);
      const result=await workflow.respond('project',{taskId:selected.pending.taskId,actor:'runtime',action:'voice-verified',content});
      print({...presentation(result),voiceLookup:{receiptId,receiptPath,method:'GET',generationPerformed:false}});return;
    }
    if(command==='input-folder'){
      const show=args.includes('--open');if(show)args.splice(args.indexOf('--open'),1);
      if(args.length||status.project.lifecycle==='abandoned'||status.pending.step!=='voiceSample'||status.pending.gate!=='human')throw new Error('INPUT_FOLDER_UNAVAILABLE: the current step must be waiting for your voice sample.');
      const producer=producerUpdate(status,runDir);if(!producer.inputRequest)throw new Error('INPUT_FOLDER_UNAVAILABLE: the existing-clone path requires verification, not a new recording.');const folder=producer.inputRequest.folder;
      await mkdir(folder,{recursive:true,mode:0o700});
      if(show){const result=spawnSync(process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open',[folder],{encoding:'utf8'});if(result.error||result.status!==0)throw new Error(`INPUT_FOLDER_OPEN_FAILED: ${folder}: ${result.error?.message??result.stderr??result.status}`);}
      print({producer,folder,opened:show,providerCalls:0,projectStateMutated:false});return;
    }
    if(['bible-draft','bible-sign','bible-approve','bible-policy','bible-status','bible-render'].includes(command)){
      // Production bible: draft (operator), render (for the human), sign (the human only).
      if(command==='bible-status'){if(args.length)throw new Error('Unknown bible-status arguments.');print(bibleSummary(status.project,runDir)??{policy:'none',message:'Historical run without a production bible; bible-draft creates one (advisory policy).'});return;}
      if(command==='bible-render'){
        const out=option('out'),wanted=option('version');if(args.length)throw new Error('bible-render takes --run, optional --version N and --out <path>.');
        const versions=status.project.bible?.versions??[],entry=wanted?versions.find(v=>v.version===Number(wanted)):versions.at(-1);
        if(!entry)throw new Error('BIBLE_MISSING: no production bible version to render; run bible-draft first.');
        const md=renderBibleMarkdown(entry,{runDir,superseded:entry.state==='signed'&&versions.findLast(v=>v.state==='signed')!==entry});
        if(out){await writeFile(resolve(out),md,{mode:0o600});print({path:resolve(out),version:entry.version,state:entry.state,hash:entry.hash});}else process.stdout.write(md);
        return;
      }
      const dispatchPath=join(runDir,'host-dispatch',status.pending.taskId+'.json');
      try{if((await json(dispatchPath)).status==='started')throw new Error('CODEX_DISPATCH_UNCERTAIN: reconcile the saved native dispatch before changing the production bible.');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(command==='bible-draft'){
        const message=option('message'),file=option('file');
        if(!message||args.length)throw new Error('bible-draft needs --message "<actual human instruction>" and optional --file </abs/bible.json> (default: compiled from locked artifacts).');
        if(file&&!file.startsWith('/'))throw new Error('bible-draft --file must be an absolute path.');
        const content=file?await json(file):undefined;
        const result=await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'bible-draft',message,...(content?{content}:{})});
        const entry=result.project.bible.versions.at(-1);
        print({...bibleSummary(result.project,runDir),drafted:{version:entry.version,hash:entry.hash,state:entry.state,openQuestions:entry.content.openQuestions.length,unresolved:unresolvedPaths(entry.content)},next:'Render it for the human (bible-render). Only the human signs, with bible-sign in an interactive terminal.'});
        return;
      }
      if(command==='bible-policy'){
        const set=option('set'),message=option('message'),reh=option('rehearsal');
        if(!set||!message||args.length)throw new Error('bible-policy needs --set required|advisory --message "<the human instruction, quoted with time>" (optional --rehearsal true|false).');
        const result=await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'bible-policy',content:{policy:set,...(reh!=null?{rehearsal:reh==='true'}:{})},message});
        print(bibleSummary(result.project,runDir));return;
      }
      if(command==='bible-approve'){
        // Logged chat approval for rehearsal runs: no TTY, but the human's own words and the hash are recorded.
        const via=option('via'),by=option('by'),hash=option('hash'),message=option('message');
        if(via!=='chat'||!by||!hash||!message||args.length)throw new Error('bible-approve needs --via chat --by <name> --hash <12+ chars> --message "<the human\'s chat approval, quoted with time>".');
        const latest=status.project.bible?.versions.at(-1);
        if(!latest)throw new Error('BIBLE_MISSING: draft the production bible first.');
        if(hash.length<12||!latest.hash.startsWith(hash))throw new Error(`BIBLE_HASH_MISMATCH: v${latest.version} is ${latest.hash.slice(0,12)}.`);
        const result=await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'bible-approve',artifactDigest:latest.hash,content:{by},message:`[chat approval] ${message}`});
        print(bibleSummary(result.project,runDir));return;
      }
      // bible-sign is a human operator event: it refuses non-interactive callers (agents,
      // scripts, CI pipes) and needs the hash the human reviewed typed back as confirmation.
      const by=option('by'),hash=option('hash'),message=option('message');
      if(!by||!hash||args.length)throw new Error('bible-sign needs --by <your name> --hash <hash shown by bible-render> (optional --message).');
      if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('BIBLE_SIGN_NEEDS_HUMAN_TERMINAL: signing the production bible is a human action. Run it yourself in an interactive Terminal; agents, scripts and pipes cannot sign.');
      const latest=status.project.bible?.versions.at(-1);
      if(!latest)throw new Error('BIBLE_MISSING: draft the production bible first.');
      if(hash.length<12||!latest.hash.startsWith(hash))throw new Error(`BIBLE_HASH_MISMATCH: --hash must be at least 12 characters of the latest draft's hash (v${latest.version} ${latest.hash.slice(0,12)}). Re-render and review it.`);
      const rl=createInterface({input:process.stdin,output:process.stderr});
      let typed;try{typed=await rl.question(`Sign production bible v${latest.version} (${latest.hash.slice(0,12)}) as "${by}"? Type those 12 characters to confirm: `);}finally{rl.close();}
      if(typed.trim()!==latest.hash.slice(0,12))throw new Error('BIBLE_SIGN_NOT_CONFIRMED: nothing was signed.');
      const result=await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'bible-sign',artifactDigest:latest.hash,content:{by},message:message??`${by} signed production bible v${latest.version} at an interactive terminal.`});
      print(bibleSummary(result.project,runDir));return;
    }
    if(command==='debug'){
      const mode=args.shift(),message=option('message');
      if(!['on','off'].includes(mode)||!message||args.length)throw new Error('Use debug on|off --message "<actual human instruction>" --run /absolute/run.');
      print(presentation(await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'configure-debug',debugEnabled:mode==='on',message})));return;
    }
    if(command==='debug-next'){
      const message=option('message');if(!message||args.length)throw new Error('debug-next needs --message with the actual human instruction to continue one step.');
      print(presentation(await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'debug-next',message})));return;
    }
    if(command==='debug-inspect'){if(args.length)throw new Error('Unknown debug-inspect arguments.');print(await debugSnapshot(status,runDir));return;}
    if(['dispatch-reconcile','crew-start','crew-refresh','drive-codex','work-codex'].includes(command)){
      const reviewCalls=Number(option('review-calls','0'));
      // Defaults so a drive cannot silently block Ava's tools: one STT call per
      // current audio file (x3 finished attempts) on audition/narration, and the
      // configured per-call estimates. Explicit flags still win.
      const audioFiles=['audition','narration'].includes(status.pending?.step)?(current(status.project,status.pending.step)?.content?.files?.length??0):0;
      const transcriptionCalls=Number(option('transcription-calls',String(Math.min(32,audioFiles*limitsFor(status.project).finishedWorkerAttempts))));
      const reviewCost=Number(option('review-cost-usd',String(PERCEPTION_ESTIMATES_USD.review))),transcriptionCost=Number(option('transcription-cost-usd',String(PERCEPTION_ESTIMATES_USD.transcription)));
      // Optional live LangSmith tracing: enabled only with LANGSMITH_API_KEY in
      // the --secrets file; off when WIGGLY_TRACING=off or no key. Never breaks a run.
      let budgetQueue=Promise.resolve();
      const inFlightTimers = new Map(), perceptionScope = new AsyncLocalStorage();
      const recordIdx = args.indexOf('--record');
      const hasRecordFlag = recordIdx >= 0;
      if (hasRecordFlag) args.splice(recordIdx, 1);
      const isRecord = hasRecordFlag || process.env.WIGGLY_RECORD === '1';
      const replayCassetteDir = process.env.WIGGLY_REPLAY_CASSETTE || null;

      let cassette = null;
      let cassetteDir = null;
      let cassetteId = null;

      if (replayCassetteDir) {
        globalThis.fetch = () => {
          throw new Error('REPLAY_NETWORK_BLOCKED');
        };
        cassette = await Cassette.open(replayCassetteDir);
        cassette.aliases = runDirAliases(runDir);
      } else if (isRecord) {
        const utcStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + 'Z';
        cassetteId = `${command}-${utcStamp}`;
        cassetteDir = join(runDir, 'cassettes', cassetteId);
        const beforeDir = join(cassetteDir, 'before');
        await mkdir(beforeDir, { recursive: true });
        const runEntries = await readdir(runDir).catch(() => []);
        for (const ent of runEntries) {
          if (ent === 'cassettes' || ent === 'writer.lock') continue;
          await cp(join(runDir, ent), join(beforeDir, ent), {
            recursive: true,
            mode: fs.constants.COPYFILE_FICLONE,
            filter: (src) => !src.endsWith('writer.lock') && !src.includes('/cassettes')
          });
        }

        const sanitizedArgv = [];
        const runnerCliArgs = process.argv.slice(2);
        for (let i = 0; i < runnerCliArgs.length; i++) {
          if (runnerCliArgs[i] === '--secrets' || runnerCliArgs[i] === '--run') {
            i++;
            continue;
          }
          if (runnerCliArgs[i].startsWith('--secrets=') || runnerCliArgs[i].startsWith('--run=')) {
            continue;
          }
          sanitizedArgv.push(runnerCliArgs[i]);
        }

        let codexVer = null;
        try {
          codexVer = spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim();
        } catch {}

        let secretsList = [];
        try {
          const sText = await readFile(secretsPath, 'utf8');
          for (const m of sText.matchAll(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/gm)) {
            const val = m[1].replace(/^(['"])(.*)\1$/, '$2').trim();
            if (val) secretsList.push(val);
          }
        } catch {}

        const header = {
          type: 'header',
          version: 1,
          createdAt: new Date().toISOString(),
          argv: sanitizedArgv,
          codexVersion: codexVer || null,
          profiles: { codex: null, openrouter: null }
        };
        cassette = await Cassette.create(cassetteDir, header, { secrets: secretsList });
        cassette.aliases = runDirAliases(runDir);
      }

      // Optional live LangSmith tracing: enabled only with LANGSMITH_API_KEY in
      // the --secrets file; off when WIGGLY_TRACING=off or no key. Never breaks a run.
      const fallbackTracer=()=>({enabled:false,turn:()=>({end(){},attachImage(){}}),tool:()=>({end(){}}),review(){},paidJob(){},within:(_h,fn)=>fn(),current:()=>null,flush:async()=>{},attachImage(){}});
      let tracer=fallbackTracer();
      try{
        const tracing=await import('./runtime/tracing.mjs');
        const tracerOpts={
          secretsPath,
          runId:basename(runDir),
          runDir,
          rootName:command,
          ...(isRecord && cassetteId ? { tags: [`cassette:${cassetteId}`], metadata: { cassetteId } } : {}),
        };
        tracer=await tracing.createTracer(tracerOpts);
      }catch{tracer=fallbackTracer();}

      const beforeRequest=async({provider,requestDigest,task})=>{
        if(status.project.reviewMode!=='supervised')return;
        const amount=provider==='gemini'?reviewCost:(provider==='cartesia-stt'?transcriptionCost:NaN);
        if(!Number.isFinite(amount)||amount<=0)throw new Error('ACCOUNT_ESTIMATE_REQUIRED: set positive --review-cost-usd / --transcription-cost-usd before paid inference.');
        const tracing = await import('./runtime/tracing.mjs').catch(() => null);
        if (tracing?.paidJobTimer) {
          inFlightTimers.set(requestDigest, tracing.paidJobTimer(tracer, {
            provider,
            jobId: task.taskId,
            estimatedCostUsd: amount,
            actualCostUsd: amount,
            actualCostSource: 'estimate',
          }));
          perceptionScope.getStore()?.digests.push(requestDigest);
        }
        budgetQueue=budgetQueue.then(async()=>{const latest=await workflow.status('project');if(latest.pending.taskId!==task.taskId)throw new Error('STALE_TASK: inference reservation belongs to an older task.');await workflow.respond('project',{taskId:task.taskId,actor:'runtime',action:'reserve-compute',reservation:{id:provider+':'+requestDigest,provider,estimatedCostUsd:amount}});});
        return budgetQueue;
      };
      const afterResponse=async({requestDigest,usage=null})=>{
        const timer = inFlightTimers.get(requestDigest);
        if (timer) {
          inFlightTimers.delete(requestDigest);
          // Gemini direct perception: token counts from the provider; cost stays the estimate.
          timer.ok(usage?{usage}:{});
        }
      };

      let geminiFetcher = fetch, cartesiaFetcher = fetch;
      let orFetcher = fetch;
      if (replayCassetteDir) {
        geminiFetcher = replayFetcher(cassette, 'gemini');
        cartesiaFetcher = replayFetcher(cassette, 'cartesia-stt');
        orFetcher = replayFetcher(cassette, 'openrouter');
      } else if (isRecord) {
        geminiFetcher = recordingFetcher(cassette, 'gemini', fetch);
        cartesiaFetcher = recordingFetcher(cassette, 'cartesia-stt', fetch);
        orFetcher = recordingFetcher(cassette, 'openrouter', fetch);
      }

      // Each perception call runs in its own async scope: a failed call finishes only its own request traces as failed (concurrent calls are unaffected).
      const tracedTools=(tools)=>Object.fromEntries(Object.entries(tools).map(([name,fn])=>[name,typeof fn!=='function'?fn:(...callArgs)=>{const scope={digests:[]};return perceptionScope.run(scope,async()=>{try{return await fn(...callArgs);}catch(error){for(const d of scope.digests){const timer=inFlightTimers.get(d);if(timer){inFlightTimers.delete(d);timer.fail(error);}}throw error;}});}]));
      const perceptionTools={...tracedTools(createGeminiReviewTools({secretsPath,receiptDirectory:join(runDir,'gemini-reviews'),maxCalls:reviewCalls,beforeRequest,afterResponse,fetcher:geminiFetcher})),...tracedTools(createCartesiaTranscriptionTool({secretsPath,receiptDirectory:join(runDir,'cartesia-transcriptions'),maxCalls:transcriptionCalls,beforeRequest,afterResponse,fetcher:cartesiaFetcher})),...createAudioEditTools({runDir})};
      // A four-file review includes twelve tool calls and a structured report.
      // Keep a bounded ten-minute window; timeout still stops without a retry.
      // Codex-backend agents run through CodexHost; OpenRouter agents (the whole
      // crew on Muse Spark today) run through OpenRouterHost. The Codex app-server
      // is only spawned when a codex-backend worker is needed for the command.
      const studioConfig=studioFor(status.project)?.config??loadStudio().config;
      const {codex:wantCodex,openrouter:wantOpenRouter}=CrewHost.backendsNeeded(command,studioConfig,status.project.crew?.workers);

      let codexSpawnProcess = spawn;
      let codexVersionFn = undefined;
      let codexProfileOverride = null;
      let orProfileOverride = null;

      if (replayCassetteDir) {
        codexSpawnProcess = replaySpawn(cassette);
        if (cassette.header?.codexVersion) {
          codexVersionFn = () => cassette.header.codexVersion;
        }
        codexProfileOverride = cassette.header?.profiles?.codex ?? null;
        orProfileOverride = cassette.header?.profiles?.openrouter ?? null;
      } else if (isRecord) {
        codexSpawnProcess = recordingSpawn(cassette, spawn);
      }

      const codexHost=wantCodex?new CodexHost({cwd:join(runDir,'host-workspace'),timeoutMs:600000,perceptionTools,perceptionProfile:{media:GEMINI_REVIEW_PROFILE,transcription:CARTESIA_STT_PROFILE,audioEditing:AUDIO_EDIT_PROFILE},tracer,spawnProcess:codexSpawnProcess,...(codexVersionFn?{codexVersion:codexVersionFn}:{}),profileOverride:codexProfileOverride,onProgress:({worker,item})=>process.stderr.write(`${worker}: ${item}\n`)}):null;
      const openrouterHost=wantOpenRouter?new OpenRouterHost({cwd:join(runDir,'host-workspace'),secretsPath,timeoutMs:600000,perceptionTools,perceptionProfile:{media:GEMINI_REVIEW_PROFILE,transcription:CARTESIA_STT_PROFILE,audioEditing:AUDIO_EDIT_PROFILE},tracer,fetcher:orFetcher,profileOverride:orProfileOverride}):null;

      if (isRecord) {
        // Record host profiles in the header
        let codexProf = null, orProf = null;
        try { if (codexHost) codexProf = await codexHost.profile(); } catch {}
        try { if (openrouterHost) orProf = await openrouterHost.profile(); } catch {}
        cassette.header.profiles = { codex: codexProf, openrouter: orProf };
      }

      if(openrouterHost&&command!=='dispatch-reconcile'){const pre=await spendPreflight(runDir,`crew:${command}`,0);if(pre?.paused)return;}
      const host=new CrewHost({codex:codexHost,openrouter:openrouterHost,config:studioConfig});
      let commandExitCode = 0, commandStdout = null, commandError = null;
      try{
        if(command==='dispatch-reconcile'){
          const turnId=option('turn',null),notDispatched=option('not-dispatched',null),message=option('message');if(args.length)throw new Error('Unknown reconciliation arguments. Use --turn <id> --message "<direction>" or --not-dispatched true --message "<direction>".');
          const workerBackend=status.pending.crewWorker?.backend??studioConfig.agents[status.pending.crewWorker?.role]?.backend??'codex';
          if(workerBackend==='openrouter'){
            if(notDispatched!=='true'||turnId!=null)throw new Error('dispatch-reconcile for an openrouter worker needs --not-dispatched true --message "<direction>" (an OpenRouter worker has no server thread to inspect).');
            const {reconcileRouterNotDispatched}=await import('./runtime/crew-host.mjs');
            const res = await reconcileRouterNotDispatched(status.pending,{receiptDirectory:join(runDir,'host-dispatch'),message});
            commandStdout = res; print(res); return;
          }
          if(!codexHost)throw new Error('CODEX_HOST_MISSING: no codex-bound worker is needed for this run; nothing to reconcile.');
          await codexHost.initialize();
          if(notDispatched!=null){
           if(notDispatched!=='true'||turnId!=null)throw new Error('dispatch-reconcile --not-dispatched true needs --message and no --turn.');
           const res = await reconcileNotDispatched(status.pending,codexHost,{receiptDirectory:join(runDir,'host-dispatch'),message});
           commandStdout = res; print(res); return;
          }
          const res = await reconcileDispatch(status.pending,codexHost,{receiptDirectory:join(runDir,'host-dispatch'),turnId,message});
          commandStdout = res; print(res); return;
        }
        if(['crew-start','crew-refresh'].includes(command)){
          if(command==='crew-refresh'){
            const path=join(runDir,'host-dispatch',status.pending.taskId+'.json');
            try{if((await json(path)).status==='started')throw new Error('CODEX_DISPATCH_UNCERTAIN: reconcile the saved native dispatch before capability refresh.');}catch(error){if(error.code!=='ENOENT')throw error;}
          }
          const message=option('message'),model=option('model');
          if(!message||command==='crew-start'&&status.project.crew||command==='crew-refresh'&&!status.project.crew)throw new Error('crew-start requires an unconfigured run; crew-refresh requires existing bindings. Supply --message with the actual human instruction.');
          if(status.project.jobs.some(j=>['submitting','submitted','uncertain'].includes(j.status)))throw new Error('Reconcile outstanding jobs before changing crew.');
          if(codexHost)await codexHost.initialize();
          const crew=command==='crew-refresh'?await host.refreshCrew(status.project.crew,studioConfig):await host.startCrew(model,studioConfig);
          if(command==='crew-refresh'&&crew.changed?.length)process.stderr.write(`crew-refresh rebound roles: ${crew.changed.join(', ')}\n`);
          const res = presentation(await workflow.respond('project',{taskId:status.pending.taskId,actor:'human',action:'configure-crew',message,crew:{workers:crew.workers}}));
          commandStdout = res; print(res); return;
        }
        if(!status.project.crew)throw new Error('CREW_NOT_CONFIGURED: use crew-start before local Codex dispatch.');
        const maxTasks=command==='work-codex'?1:Number(option('max-tasks',String(limitsFor(status.project).crewTasksPerDispatch))),repair=option('repair-invalid','false');
        const recoveryTask=option('recovery-task'),recoveryNumber=option('recovery-attempt'),recoveryMessage=option('recovery-message');
        const recoveryAttempt=recoveryTask||recoveryNumber||recoveryMessage?{taskId:recoveryTask,attempt:Number(recoveryNumber),message:recoveryMessage}:undefined;
        if(recoveryAttempt&&(!recoveryTask||!Number.isInteger(recoveryAttempt.attempt)||!recoveryMessage||maxTasks!==1))throw new Error('Recovery needs exact --recovery-task, --recovery-attempt, --recovery-message and one task.');
        if(!['true','false'].includes(repair))throw new Error('--repair-invalid needs true or false.');
        if(codexHost)await codexHost.initialize();
        const result=await driveCrew(workflow,'project',host,{maxTasks,repairInvalid:repair==='true',recoveryAttempt,receiptDirectory:join(runDir,'host-dispatch'),verifySubmission,tracer,onProgress:progress=>process.stderr.write(progress.type==='repair-notice'?`DEFECT FOUND: ${progress.notice.key??progress.notice.artifactId}. ${progress.notice.findings?.map(f=>f.evidence).join(' ')??'See the localized repair notice in status.'} Repair routed through the current task.\n`:`${progress.step}: ${progress.gate}\n`)});
        const res = {completed:result.completed,stop:result.stop,...presentation(result.status)};
        commandStdout = res; print(res); return;
      }catch(err){
        commandExitCode = 1;
        commandError = err.message;
        try{tracer.fail?.(err);}catch{}
        throw err;
      }finally{
        try{await tracer.flush(5000);}catch{}
        host.close();
        if(isRecord&&cassette){
          try{
            try {
              const { DatabaseSync } = await import('node:sqlite');
              const dbPath = join(runDir, 'checkpoints.sqlite');
              const syncDb = new DatabaseSync(dbPath);
              syncDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
              syncDb.close();
            } catch {}
            const afterDir = join(cassetteDir, 'after');
            await mkdir(afterDir, { recursive: true });
            const runEntries = await readdir(runDir).catch(() => []);
            for (const ent of runEntries) {
              if (ent === 'cassettes' || ent === 'writer.lock') continue;
              await cp(join(runDir, ent), join(afterDir, ent), {
                recursive: true,
                mode: fs.constants.COPYFILE_FICLONE,
                filter: (src) => !src.endsWith('writer.lock') && !src.includes('/cassettes')
              });
            }
            await cassette.writeLine({
              type: 'result',
              exitCode: commandExitCode,
              stdout: commandStdout,
              error: commandError
            });
            process.stderr.write(`recorded cassette: ${cassetteDir}\n`);
          }catch(e){process.stderr.write(`${e.message}\n`);}
        }
        if(replayCassetteDir&&cassette){
          try { cassette.assertFullyConsumed(); } catch (err) {
            cassette.recordMismatch(err);
          }
          if (cassette.mismatchError) {
            process.stderr.write(`${cassette.mismatchError.message}\n`);
            process.exitCode = 1;
          }
        }
      }
    }
    if(['qualify-audio','qualify-visual','generate','collect','render','preview','finalize'].includes(command)&&!status.project.crew)throw new Error('CREW_NOT_CONFIGURED: bind actual host workers using configure-crew; old approvals never supply capabilities.');
    if(command==='qualify-audio'){
      assertDebugReady(status.project);
      const dataset=await json(option('dataset')),predictions=await json(option('predictions')),worker=option('worker'),model=option('model'),capability=option('capability');
      if(!worker||!model||!capability||args.length)throw new Error('Specify --dataset, --predictions, --worker, --model and --capability.');
      const computed=await qualifyAudio(dataset,predictions,worker,model,capability);print(computed);requireAudioQualification(computed);
      const path=join(runDir,'evaluation','audio-'+digest({dataset:computed.datasetDigest,predictions:computed.predictionDigest,worker,model,capability}));await mkdir(path,{recursive:true});const report={...computed,evidenceDirectory:path};
      for(const [name,value]of Object.entries({dataset,predictions,report}))await writeFile(join(path,`${name}.json`),JSON.stringify(value,null,2)+'\n',{mode:0o600});
      await verifyFiles(report);print(presentation(await workflow.respond('project',{taskId:status.pending.taskId,action:'audio-qualified',actor:'runtime',content:report})));return;
    }
    if(command==='qualify-visual'){
      assertDebugReady(status.project);
      const dataset=await json(option('dataset')),predictions=await json(option('predictions')),worker=option('worker'),model=option('model'),capability=option('capability');
      if(!worker||!model||!capability||args.length)throw new Error('Specify --dataset, --predictions, --worker, --model and --capability.');
      const computed=await qualifyVisual(dataset,predictions,worker,model,capability);print(computed);requireVisualQualification(computed,'image');requireVisualQualification(computed,'video');
      const path=join(runDir,'evaluation',digest({dataset:computed.datasetDigest,predictions:computed.predictionDigest,worker,model,capability}));await mkdir(path,{recursive:true});const report={...computed,evidenceDirectory:path};
      for(const [name,value] of Object.entries({dataset,predictions,report}))await writeFile(join(path,`${name}.json`),JSON.stringify(value,null,2)+'\n',{mode:0o600});
      await verifyFiles(report);
      const result=await workflow.respond('project',{taskId:status.pending.taskId,action:'qualified',actor:'runtime',content:report});
      print(presentation(result));return;
    }
    if(command==='preview'){
      const p=status.project;if(!locked(p,'editPlan')||!['film','complete'].includes(p.step))throw new Error('Preview requires the approved edit and current film stage.');
      assertAllowed(p,'film');await verifyFiles(p.artifacts.filter(a=>a.valid));const manifest=assemblyManifest(p);if(current(p,'film')&&current(p,'film').content.manifestDigest!==digest(manifest))throw new Error('STALE_FILM: renderer or assets changed; reopen film review before preview.');
      const prepared=await prepareComposition(manifest,join(runDir,'assembly',digest(manifest)));const {url}=await servePreview(prepared);print({url,manifestDigest:digest(manifest),approvesNothing:true,providerCalls:0});return;
    }
    if(command==='render'){
      const content=await renderFilm(status.project,runDir);print(presentation(await workflow.respond('project',{taskId:status.pending.taskId,actor:'runtime',action:'rendered',content})));return;
    }
    if(command==='finalize'){
      const p=status.project,film=current(p,'film');if(p.step!=='complete'||!locked(p,'film'))throw new Error('FINALIZATION_BLOCKED: final film must pass agent and human review first.');
      assertAllowed(p,'film');await verifyRenderer();await verifyFiles(p.artifacts.filter(a=>a.valid));
      if(film.content.manifestDigest!==digest(assemblyManifest(p))||film.content.editPlanDigest!==current(p,'editPlan').digest)throw new Error('STALE_FILM: current assets differ from approved film.');
      const inspection=await inspectFilm(film.content.files[0]);assertFilmInspection(inspection);
      const result={formatVersion:VERSION,projectId:p.id,film:film.content.files[0],artifactId:film.id,artifactDigest:film.digest,approvedBy:film.approvedBy,review:film.review,inspection,manifest:assemblyManifest(p),provenance:film.content.provenance,published:false};
      result.endOfRun=await endOfRunCheck({runDir,close:true});
      const path=join(runDir,'finalized.json');await writeFile(path,JSON.stringify(result,null,2)+'\n',{mode:0o600});print({path,film:result.film.path,published:false,endOfRun:result.endOfRun});return;
    }
    if(command==='end-of-run-check'){if(args.length)throw new Error('Unknown end-of-run-check arguments.');const done=status.project.step==='complete';print({step:status.project.step,...await endOfRunCheck({runDir,close:done&&option('flag-only','false')!=='true'})});return;}
    if(command==='present'){print(await presentDeliverable(status));return;}
    if (command === 'status' || command === 'inspect') { print({...presentation(status),...(command==='inspect'&&current(status.project,'film')?{filmMeasurements:await inspectFilm(current(status.project,'film').content.files[0])}:{})}); return; }
    if (command === 'impact') { print(revisionImpact(status.project, args[0])); return; }
    if (command === 'validate') { for (const a of status.project.artifacts.filter(a => a.valid)) await verifyFiles(a); print({ valid: true, pending: status.pending.step, sequence: status.project.sequence }); return; }
    if (command === 'measure') { const a = status.project.artifacts.findLast(a => a.key === args[0] && a.valid); if (!a?.content.files) throw new Error('Specify an existing audio artifact key, e.g. narration or audition.'); print(await Promise.all(a.content.files.map(measureAudio))); return; }
    if (command === 'respond') {
      const event = await json(args[0]);
      if (event.actor === 'runtime') throw new Error('Runtime events are reserved for the provider collector.');
      if (['bible-draft','bible-sign','bible-approve','bible-policy'].includes(event.action)) throw new Error('BIBLE_COMMAND_REQUIRED: use bible-draft, and bible-sign (the human, in an interactive terminal), not respond.');
      if(!status.project.crew&&['agent','reviewer'].includes(event.actor)&&event.action!=='note')throw new Error('CREW_NOT_CONFIGURED: run crew-template, bind actual host IDs/model/tools and submit human configure-crew.');
      await verifySubmission(status,event);
      print(presentation(await workflow.respond('project', event))); return;
    }
    if (command === 'work') {
      if (!['author', 'owner-review', 'review', 'produce'].includes(status.pending.gate)) { print(presentation(status)); return; }
      const modulePath = args[0];
      const task = modulePath ? status.pending : await prepareCrewTask(status.project,status.pending);
      if (!modulePath) { print({communication:communicationFor(status.project), task, responseSchema: z.toJSONSchema(Event), contentSchema: Content[status.pending.step] ? z.toJSONSchema(Content[status.pending.step]) : null,
        instruction: 'The operating host agent must perform this task, write an event JSON, then call respond. A trusted host integration exporting runTask(task, {worker, callTool}) may automate it after configure-crew; supply actual perception tools and inherit the current host model. The format broker checks every tool call; the host must restrict any ambient tools separately.' }); return; }
      const worker = await import(pathToFileURL(resolve(modulePath)).href);
      if (typeof worker.runTask !== 'function') throw new Error('Worker module must export runTask(task).');
      const event = await runCrewTask(status.project,task,worker);
      if (event.actor !== status.pending.actor || !['artifact', 'owner-review', 'review', 'plan'].includes(event.action)) throw new Error('Worker may only author, review or plan; it cannot approve for the user or call providers through the format tools.');
      await verifySubmission(status,event);
      print(presentation(await workflow.respond('project', event))); return;
    }
    if (command === 'upgrade-workflow') {
      const target = Number(option('to', args[0] ?? '5')); if (args.length) args.shift();
      const message = option('message'); if (!message || args.length) throw new Error('upgrade-workflow needs --to 5 and --message "<actual human instruction>".');
      if (target !== 5) throw new Error('Only upgrade to workflow revision 5 is supported.');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'upgrade-workflow', workflowRevision: 5, message }))); return;
    }
    if (command === 'import-sheet') {
      const character = option('character'); const filePath = option('file'); const message = option('message');
      if (!character || !filePath || !message || args.length) throw new Error('import-sheet needs --character <id> --file <abs path> --message "<operator note>".');
      if (!filePath.startsWith('/')) throw new Error('import-sheet --file must be an absolute path.');
      const imported = await importMedia(resolve(filePath), runDir);
      if (!imported.width || !imported.height || imported.durationSeconds) throw new Error('import-sheet needs a measured still image.');
      const { basename: base } = await import('node:path');
      const provenance = { source: 'operator-import', originalPath: base(resolve(filePath)), sha256: imported.sha256, importedAt: new Date().toISOString(), message };
      await verifyFiles(imported);
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'import-sheet', characterId: character, importFile: imported, importProvenance: provenance, message }))); return;
    }
    if (command === 'import-sound') {
      const filePath = option('file'); const message = option('message'); const effect = option('effect');
      if (!filePath || !message || args.length) throw new Error('import-sound needs --file <abs path> --message "<operator note>" [--effect <id>].');
      if (!filePath.startsWith('/')) throw new Error('import-sound --file must be an absolute path.');
      const imported = await importMedia(resolve(filePath), runDir);
      if (!imported.durationSeconds || imported.width || imported.height) throw new Error('import-sound needs a measured audio-only file.');
      await verifyFiles(imported);
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'import-sound', ...(effect ? { effectId: effect } : {}), importFile: imported, message }))); return;
    }
    if (command === 'add-reference') {
      const character = option('character'); const filePath = option('file'); const message = option('message');
      if (!character || !filePath || !message || args.length) throw new Error('add-reference needs --character <id> --file <abs path> --message "<human instruction>".');
      if (!filePath.startsWith('/')) throw new Error('add-reference --file must be an absolute path.');
      const imported = await importMedia(resolve(filePath), runDir);
      if (!imported.width || !imported.height || imported.durationSeconds) throw new Error('add-reference needs a measured still image.');
      await verifyFiles(imported);
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'add-reference', characterId: character, importFile: imported, message }))); return;
    }
    if (command === 'intake-photos') {
      const filePath = option('file'); const label = option('label'); const message = option('message');
      if (!filePath || !label || !message || args.length) throw new Error('intake-photos needs --file <abs path> --label "<who this photo shows>" --message "<maker note>".');
      if (!filePath.startsWith('/')) throw new Error('intake-photos --file must be an absolute path.');
      const imported = await importMedia(resolve(filePath), runDir);
      if (!imported.width || !imported.height || imported.durationSeconds) throw new Error('intake-photos needs a measured still image.');
      await verifyFiles(imported);
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'intake-photos', photoInventory: [{ ...imported, label }], message }))); return;
    }
    if (command === 'settle-transcript') {
      const beat = Number(option('beat')); const message = option('message');
      if (!Number.isInteger(beat) || beat < 1 || beat > 4 || !message || args.length) throw new Error('settle-transcript needs --beat <1-4> and --message "<what the human heard>".');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'settle-transcript', beat, message }))); return;
    }
    if (command === 'prefer-image-provider') {
      const provider = option('provider'); const message = option('message');
      if (!['meta-muse','agy'].includes(provider) || !message || args.length) throw new Error('prefer-image-provider needs --provider meta-muse|agy --message "<text>" --run <run>.');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'prefer-image-provider', provider, message }))); return;
    }
    if (command === 'refresh-visual-instructions') {
      const message = option('message');
      if (!message || args.length) throw new Error('refresh-visual-instructions needs --message "<actual human instruction>" --run <run>.');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'refresh-visual-instructions', message }))); return;
    }
    if (command === 'refresh-keyframe-instructions') {
      const message = option('message');
      if (!message || args.length) throw new Error('refresh-keyframe-instructions needs --message "<actual human instruction>" --run <run>.');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'refresh-keyframe-instructions', message }))); return;
    }
    if (command === 'refresh-crew-models') {
      const message = option('message');
      if (!message || args.length) throw new Error('refresh-crew-models needs --message "<actual human instruction>" --run <run>.');
      const path=join(runDir,'host-dispatch',status.pending.taskId+'.json');
      try{if((await json(path)).status==='started')throw new Error('CODEX_DISPATCH_UNCERTAIN: reconcile the saved native dispatch before changing crew models.');}catch(error){if(error.code!=='ENOENT')throw error;}
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'refresh-crew-models', message }))); return;
    }
    if (command === 'refresh-text-instructions') {
      const message = option('message');
      if (!message || args.length) throw new Error('refresh-text-instructions needs --message "<actual human instruction>" --run <run>.');
      print(presentation(await workflow.respond('project', { taskId: status.pending.taskId, actor: 'human', action: 'refresh-text-instructions', message }))); return;
    }
    if (command === 'generate' || command === 'collect') {
      const { project, pending } = status; const job = pending.job;
      if (pending.gate !== 'collect' || !job) throw new Error('Only a current authorized generation request can be executed/collected.');
      if(command==='generate')assertDebugReady(project);
      await verifyFiles(project.artifacts.filter(a=>a.valid));
      const runtimeEvent = async (action,extra={})=>{
        const latest=await workflow.status('project');return workflow.respond('project',{taskId:latest.pending.taskId,actor:'runtime',jobId:job.id,artifactDigest:job.digest,action,...extra});
      };
      const onJobId=async providerJobId=>{
        const latest=(await workflow.status('project')).project.jobs.find(j=>j.id===job.id);
        if(latest.providerJobId&&latest.providerJobId!==providerJobId)throw new Error('Provider job ID changed; stop and reconcile.');
        if(!latest.providerJobId)await runtimeEvent('job-id',{providerJobId});
      };
      const receiptPath=join(runDir,'receipts',job.id,'result.json');
      try {const result=await json(receiptPath);await verifyFiles(result);print(presentation(await runtimeEvent('receipt',{result})));return;}
      catch(e){if(e.code!=='ENOENT')throw e;}
      if(command==='generate'&&job.status!=='authorized'){
        if(['submitting','submitted'].includes(job.status))await runtimeEvent('provider-error',{message:'Process ended after submission began. Outcome unknown; reconcile existing request.'});
        throw new Error('ALREADY_SUBMITTED: use collect/reconciliation; never resubmit.');
      }
      if(command==='collect'&&job.status==='authorized')throw new Error('NOT_SUBMITTED: collection cannot start a paid request.');
      await verifyFiles(job.request);
      let key='';
      if(job.plan.provider==='agy'&&job.request.fallback){
        try{key=await loadKey('meta-muse',secretsPath);}catch{key='';}
      }else if((command==='generate'||job.plan.provider==='replicate')&&job.plan.provider!=='agy'){
        try{key=await loadKey(job.plan.provider,secretsPath);}catch(e){throw new Error(`${e.message}\n${remediation(job.plan.provider,secretsPath)}`);}
      }
      if(command==='generate'){const pre=await spendPreflight(runDir,`generate:${job.plan.operation}`,job.plan.estimatedCostUsd);if(pre?.paused)return;}
      if(command==='generate')await runtimeEvent('begin');
      const fallbackTracer=()=>({enabled:false,paidJob(){},flush:async()=>{},attachImage(){}});
      let tracer=fallbackTracer();
      try{
        const tracing=await import('./runtime/tracing.mjs');
        tracer=await tracing.createTracer({secretsPath,runId:basename(runDir),runDir,rootName:command});
      }catch{tracer=fallbackTracer();}
      try{
        try{
          const latest=(await workflow.status('project')).project;
          const needsStub=command==='collect'&&job.plan.provider!=='replicate'&&!(job.plan.provider==='agy'&&job.request.fallback);
          const result=await executeJob(latest,latest.jobs.find(j=>j.id===job.id),runDir,key,needsStub?()=>{throw new Error('Collection cannot resubmit synchronous providers.');}:fetch,command==='collect',onJobId,{tracer});
          if(result.pending){print({...presentation(await workflow.status('project')),collection:result});return;}
          await verifyFiles(result);
          if(['sheet','backgroundCandidates','backgroundAngle','keyframe','candidates'].includes(job.plan.operation)&&Array.isArray(result?.files)){
            for(const [idx,f] of result.files.entries()){
              const name=result.files.length===1?(f.path?basename(f.path):'image.png'):`option-${idx}-${f.path?basename(f.path):'image.png'}`;
              try{tracer.attachImage?.({name,path:f.path,sha256:f.sha256});}catch{}
            }
          }
          const receiptStatus = await runtimeEvent('receipt',{result});
          // Opt-in prescreen auto call: at the end of collect, if new status is gate 'review'
          if (command === 'collect' && receiptStatus.pending?.gate === 'review') {
            const pNow = receiptStatus.project;
            const pConf = studioFor(pNow)?.config.prescreen ?? { enabled: false };
            const steps = pConf.steps ?? ['candidates', 'backgroundCandidates', 'backgroundAngle', 'keyframe'];
            if (pConf.enabled && steps.includes(pNow.step)) {
              try {
                const art = current(pNow);
                if (art && art.content?.files?.length) {
                  await verifyFiles(art.content.files);
                  const { runPrescreen, prescreenBrief } = await import('./runtime/decisions-prescreen.mjs');
                  const { criteriaFor } = await import('./runtime/workflow.mjs');
                  const criteria = criteriaFor(pNow);
                  // No reference photos and no likeness: the prescreen checks deformities, text and the brief only.
                  const contextText = prescreenBrief(pNow, art);
                  const prescreenResult = await runPrescreen({
                    config: pConf,
                    secretsPath,
                    step: pNow.step,
                    files: art.content.files,
                    contextText,
                    criteria,
                    tracer,
                  });
                  await workflow.respond('project', {
                    taskId: receiptStatus.pending.taskId,
                    actor: 'runtime',
                    action: 'prescreen',
                    artifactId: art.id,
                    artifactDigest: art.digest,
                    message: 'Decisions prescreen',
                    prescreen: prescreenResult,
                  });
                }
              } catch (err) {
                process.stderr.write(`Prescreen auto-run failed: ${err.message}\n`);
              }
            }
          }
          print(presentation(await workflow.status('project')));
        }catch(e){
          try{tracer.fail?.(e);}catch{}
          const diagnostic=key?e.message.replaceAll(key,'[redacted]'):e.message;
          await runtimeEvent('provider-error',{message:diagnostic});throw new Error(`${diagnostic}\n${remediation(job.plan.provider,secretsPath)}`);
        }
      }finally{
        try{await tracer.flush(5000);}catch{}
      }return;
    }
    if (command === 'prescreen') {
      const { project, pending } = status;
      if (pending.gate !== 'review') {
        print({ message: 'prescreen skipped: pending gate is not review.' });
        return;
      }
      const pConf = studioFor(project)?.config.prescreen ?? { enabled: false };
      const steps = pConf.steps ?? ['candidates', 'backgroundCandidates', 'backgroundAngle', 'keyframe'];
      if (!pConf.enabled || !steps.includes(project.step)) {
        print({ message: `prescreen skipped: prescreen not enabled or step ${project.step} not in configured steps.` });
        return;
      }
      const art = current(project);
      if (!art || !art.content?.files?.length) {
        print({ message: 'prescreen skipped: no files to prescreen.' });
        return;
      }
      await verifyFiles(art.content.files);
      const isDryRun = args.includes('--dry-run');
      const { estimatePrescreenCost, buildRequests, runPrescreen, prescreenBrief } = await import('./runtime/decisions-prescreen.mjs');
      const contextText = prescreenBrief(project, art);
      const { criteriaFor } = await import('./runtime/workflow.mjs');
      const criteria = criteriaFor(project);
      const estCost = estimatePrescreenCost({ model: pConf.model, files: art.content.files, contextText });
      process.stdout.write(`Estimated prescreen cost: $${estCost.toFixed(5)}\n`);
      if (isDryRun) {
        const planned = await buildRequests({ model: pConf.model, step: project.step, files: art.content.files, contextText, criteria });
        print({ plannedRequests: planned.length, imageCount: art.content.files.length, estimatedCostUsd: estCost });
        return;
      }
      const fallbackTracer=()=>({enabled:false,paidJob(){},flush:async()=>{},attachImage(){}});
      let tracer=fallbackTracer();
      try{
        const tracing=await import('./runtime/tracing.mjs');
        tracer=await tracing.createTracer({secretsPath,runId:basename(runDir),runDir,rootName:command});
      }catch{tracer=fallbackTracer();}
      try {
        const testFetcher = await testDecisionsFetcher();
        const prescreenResult = await runPrescreen({
          config: pConf,
          secretsPath,
          ...(testFetcher ? { fetcher: testFetcher } : {}),
          step: project.step,
          files: art.content.files,
          contextText,
          criteria,
          tracer,
        });
        print(presentation(await workflow.respond('project', {
          taskId: pending.taskId,
          actor: 'runtime',
          action: 'prescreen',
          artifactId: art.id,
          artifactDigest: art.digest,
          message: 'Decisions prescreen',
          prescreen: prescreenResult,
        })));
      } catch (err) {
        try { tracer.fail?.(err); } catch {}
        throw err;
      } finally {
        try { await tracer.flush(5000); } catch {}
      }
      return;
    }
    throw new Error('Use check, check-provider, schema, init, status, present, work, respond, use-voice, verify-voice, reuse-voice, input-folder, import, import-sheet, import-sound, add-reference, intake-photos, settle-transcript, prefer-image-provider, refresh-visual-instructions, refresh-keyframe-instructions, refresh-text-instructions, refresh-crew-models, upgrade-workflow, measure, validate, impact, generate, collect, crew-template, crew-start, crew-refresh, dispatch-reconcile, work-codex, drive-codex, debug, debug-next, debug-inspect, audio-tasks, qualify-audio, visual-tasks, qualify-visual, preview, render, finalize, prescreen or replay. See SKILL.md.');
  } catch(error){
    const latest=await workflow.status('project').catch(()=>null);
    if(latest?.project.debug?.enabled&&!latest.project.debug.paused)await workflow.respond('project',{taskId:latest.pending.taskId,actor:'runtime',action:'debug-stop',message:'Command stopped: '+error.message});
    throw error;
  } finally { workflow.close(); await release(); }
}
main().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
