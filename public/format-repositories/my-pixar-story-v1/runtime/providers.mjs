import { readFile, writeFile, mkdir, rename, copyFile, unlink, stat } from 'node:fs/promises';
import {assertDebugReady} from './debug.mjs';
import { join, extname, resolve } from 'node:path';
import {legacyGeneration,studioFor,imageUnitCostFor,imageAspectFor,metaMuseSizeFor} from './instructions.mjs';
import { generateAgyImage, agyBrainDir, agyBinary, agyTimeoutMs, isAgyQuotaError, parseAgyQuotaReset } from './agy-image.mjs';
export { isAgyQuotaError, parseAgyQuotaReset };
import { videoBinding, effectFor } from './studio.mjs';
import { executeVideo } from './video-provider.mjs';
import { shotReferences } from './shots.mjs';
import { digest, VoiceLookup } from './contracts.mjs';
import { assertAllowed, keyFor, miniProduction, voiceBasis } from './gates.mjs';
import { importMedia, verifyFiles, narrationWindow } from './media.mjs';
import { planTotalCost } from './budget.mjs';
import { paidJobTimer } from './tracing.mjs';
const artifact = (p, key) => p.artifacts.findLast(a => a.key === key && a.valid);
// Published Pro overage rate is a conservative reservation, not an account balance
// or a claim that included subscription credits incur an additional charge.
export function narrationGenerationTexts(p,operation=p.step){
 const beats=artifact(p,'script')?.content.beats;if(!beats)return [];
 if(operation==='narration'&&p.narrationRegeneration)return [{beat:p.narrationRegeneration.beat,text:p.narrationRegeneration.spokenText}];
 return beats.slice(0,operation==='audition'?1:4).map(b=>({beat:b.beat,text:b.narration}));
}
export function generationEstimate(p, operation=p.step) {
 if(['audition','narration'].includes(operation)){const beats=artifact(p,'script')?.content.beats;if(!beats)return null;const characters=narrationGenerationTexts(p,operation).reduce((n,b)=>n+Array.from(b.text).length,0);return {provider:'cartesia',operation,characters,creditsPerCharacter:1,usdPerMillionCredits:65,estimatedCostUsd:Math.max(.01,Math.ceil(characters*65/1000000*100)/100),source:'https://cartesia.ai/pricing',verifiedAt:'2026-10-05',basis:'Published Pro overage rate, rounded up to cents. Included credits may cover the request. Current balance and final billing are unverified.'};}
 const generation=studioFor(p)?.config.generation??legacyGeneration;
 if(operation==='video'){const b=(()=>{try{return videoBinding(p);}catch{return null;}})();if(!b)return null;const model=miniProduction(p)?generation.video.model:'seedance-2.0',resolution=miniProduction(p)?generation.video.resolution:'1080p',rate=generation.video.rates?.[`${model}@${resolution}`];if(!rate||!(rate.usdPerSecond>0))return null;const generationSeconds=b.clip.generationSeconds;return {provider:'replicate',operation,generationSeconds,usdPerSecond:rate.usdPerSecond,estimatedCostUsd:Math.max(.01,Math.ceil(generationSeconds*rate.usdPerSecond*100)/100),source:rate.source,verifiedAt:rate.verifiedAt,basis:rate.basis};}
 if(operation==='music'){const rate=generation.music;if(!(rate.usdPerMinute>0)||!rate.source||!rate.verifiedAt||!rate.basis)return null;return {provider:'elevenlabs',operation,seconds:60,usdPerMinute:rate.usdPerMinute,estimatedCostUsd:Math.max(.01,Math.ceil(60*rate.usdPerMinute/60*100)/100),source:rate.source,verifiedAt:rate.verifiedAt,basis:rate.basis};}
 if(operation==='effect'){const rate=generation.effect,target=(()=>{try{return effectFor(p);}catch{return null;}})();if(!(rate.usdPerMinute>0)||!rate.source||!rate.verifiedAt||!rate.basis||!target)return null;return {provider:'elevenlabs',operation,durationSeconds:target.durationSeconds,usdPerMinute:rate.usdPerMinute,estimatedCostUsd:Math.max(.01,Math.ceil(target.durationSeconds*rate.usdPerMinute/60*100)/100),source:rate.source,verifiedAt:rate.verifiedAt,basis:rate.basis};}
 return null;
}
export function requestDescriptor(p, plan) {
  const generation=studioFor(p)?.config.generation??legacyGeneration;
  if(p.studio&&['clone','audition','narration'].includes(plan.operation)&&(plan.parameters.model&&plan.parameters.model!==generation.voice.model||plan.parameters.cartesiaVersion&&plan.parameters.cartesiaVersion!==generation.voice.apiVersion))throw new Error('STUDIO_BINDING_CHANGED: use the pinned Cartesia model/API version.');
  if(plan.operation==='video'){if(plan.parameters.model)throw new Error('Video model is fixed by the project productionProfile; unsupported override.');const b=videoBinding(p),model=miniProduction(p)?generation.video.model:'seedance-2.0',resolution=miniProduction(p)?generation.video.resolution:'1080p',costEstimate=generationEstimate(p,'video');if(costEstimate){if(plan.estimatedCostUsd+1e-9<costEstimate.estimatedCostUsd)throw new Error('VIDEO_ESTIMATE_REQUIRED: reserve at least the sourced per-second video estimate (operator-verified positive cost estimate).');}else if(!(plan.estimatedCostUsd>0))throw new Error('Video needs an operator-verified positive cost estimate.');return {prompt:plan.parameters.prompt,endpoint:`https://api.replicate.com/v1/models/bytedance/${model}/predictions`,frame:b.frame.content.files[0],input:{prompt:plan.parameters.prompt,duration:b.clip.generationSeconds,resolution,aspect_ratio:'16:9',generate_audio:false}};}
  if(['music','effect'].includes(plan.operation)){if(plan.parameters.model)throw new Error('Sound adapters use their documented fixed models.');const costEstimate=generationEstimate(p,plan.operation);if(costEstimate){if(plan.estimatedCostUsd+1e-9<costEstimate.estimatedCostUsd)throw new Error('SOUND_ESTIMATE_REQUIRED: reserve at least the sourced per-minute sound estimate (verified positive cost estimate).');}else if(!(plan.estimatedCostUsd>0))throw new Error('Sound generation needs a verified positive cost estimate.');const target=plan.operation==='music'?artifact(p,'soundPlan').content.music:effectFor(p);if(target.mode!=='generate')throw new Error('Imported sound cannot invoke a provider.');return {prompt:plan.parameters.prompt,endpoint:`https://api.elevenlabs.io/v1/${plan.operation==='music'?'music':'sound-generation'}?output_format=mp3_44100_128`,body:plan.operation==='music'?{prompt:target.prompt,music_length_ms:60000,model_id:generation.music.model,force_instrumental:true}:{text:target.prompt,duration_seconds:target.durationSeconds,model_id:generation.effect.model,loop:false},provenance:target.provenance};}
  const sample = artifact(p, 'voiceSample')?.content;
  if(plan.operation==='clone'&&p.voiceChoice)throw new Error('EXISTING_VOICE_SELECTED: do not create a replacement for the selected voice.');
  if (plan.operation === 'clone') return { endpoint: 'https://api.cartesia.ai/voices/clone', cartesiaVersion: plan.parameters.cartesiaVersion ?? generation.voice.apiVersion,
    clip: sample.files[0], language: sample.language, name: `${(artifact(p,'answers')?.content.inputs??p.inputs).subject.preferredName} — ${p.id}`, access: 'private' };
  if (['audition', 'narration'].includes(plan.operation)) {
    if(plan.operation==='narration'&&p.narrationRegeneration){const parent=artifact(p,'narration'),scope=p.narrationRegeneration;if(parent?.id!==scope.artifactId||parent.digest!==scope.artifactDigest||!parent.content.sourceFiles||!parent.content.tailSilenceSeconds||parent.content.model!==generation.voice.model)throw new Error('NARRATION_REGENERATION_STALE: current complete parent and pinned voice model required.');}
    const costEstimate=generationEstimate(p,plan.operation);
    if(!costEstimate||plan.estimatedCostUsd+1e-9<costEstimate.estimatedCostUsd)throw new Error('AUDIO_ESTIMATE_REQUIRED: reserve at least the sourced character-based estimate.');
    return { costEstimate, endpoint: 'https://api.cartesia.ai/tts/bytes', cartesiaVersion: plan.parameters.cartesiaVersion ?? generation.voice.apiVersion,
    model_id: plan.parameters.model ?? generation.voice.model, voice: artifact(p, 'clone').content.voiceId, language: voiceBasis(p).language,
    transcripts:narrationGenerationTexts(p,plan.operation).map(b=>b.text),
    ...(plan.operation==='narration'&&p.narrationRegeneration?{regeneration:{...p.narrationRegeneration,parent:structuredClone(artifact(p,'narration'))}}:{}),
    ...(plan.operation==='narration'&&p.workflowRevision>=3?{beatWindowSeconds:15}:{}),
    output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }, generation_config: { speed: 1, volume: 1 } };
  }
  let images, n;
  if (plan.operation === 'keyframe') { images = shotReferences(p).map(r => r.file); n = 1; }
  else if (plan.operation === 'backgroundCandidates') { images = artifact(p, `backgroundBrief:${p.locationId}`).content.references; n = 3; }
  else if (plan.operation === 'backgroundAngle') {
    const master = artifact(p, `backgroundCandidates:${p.locationId}`);
    images = [master.content.files[master.selection]]; n = 1;
  } else {
    const selected = artifact(p, `candidates:${p.characterId}`);
    images = plan.operation === 'sheet' ? [selected.content.files[selected.selection]] : artifact(p, 'roster').content.characters.find(c => c.id === p.characterId).references;
    n = plan.operation === 'sheet' ? 1 : 3;
  }
  const aspectRatio = imageAspectFor(plan.operation);
  const provider = plan.provider;
  if (!['agy', 'meta-muse'].includes(provider)) throw new Error('Image provider must be agy or meta-muse.');
  const unitCost = imageUnitCostFor(p, provider);
  if (plan.estimatedCostUsd + 1e-9 < n * unitCost) throw new Error(provider === 'agy' ? 'agy estimate must account for every requested image ($0 each).' : 'Muse estimate must account for every requested image ($0.01 each).');
  if (provider === 'agy') {
    const base = { provider: 'agy', prompt: plan.parameters.prompt, images, n, aspectRatio, estimatedUnitCostUsd: 0 };
    if (plan.fallbackEstimatedCostUsd === undefined) return base;
    const museUnit = imageUnitCostFor(p, 'meta-muse');
    if (plan.fallbackEstimatedCostUsd + 1e-9 < n * museUnit) throw new Error(`agy fallback estimate must reserve at least ${n} x $${museUnit} Muse images.`);
    return { ...base, fallback: { provider: 'meta-muse', endpoint: `https://api.meta.ai/v1/images/${images.length ? 'edits' : 'generations'}`, model: generation.image.model, size: metaMuseSizeFor(aspectRatio), aspectRatio, response_format: 'b64_json', output_format: 'webp', tool_enablement: { enable_web_search: false, enable_image_search: false, enable_shell: false }, unitCostUsd: museUnit } };
  }
  return { endpoint: `https://api.meta.ai/v1/images/${images.length ? 'edits' : 'generations'}`, model: generation.image.model, prompt: plan.parameters.prompt, images, n, size: metaMuseSizeFor(aspectRatio), aspectRatio, response_format: 'b64_json', output_format: 'webp',
    tool_enablement: { enable_web_search: false, enable_image_search: false, enable_shell: false } };
}
export function museRequestBody(fields, images) {
  const body = {};
  for (const k of ['model', 'prompt', 'n', 'size', 'response_format', 'output_format', 'tool_enablement']) if (fields[k] !== undefined) body[k] = fields[k];
  if (images?.length) body.images = images;
  return body;
}
export async function atomicJson(path, value) { const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path); }
// Operator guidance is canonical data, not a claim that an API request failed.
export function planningAccountGuide(p){
 const imageProvider=(studioFor(p)?.config.generation??legacyGeneration).image.provider??'meta-muse';
 const provider=['clone','audition','narration'].includes(p.step)?'Cartesia':['music','effect'].includes(p.step)?'ElevenLabs':p.step==='video'?'Replicate':imageProvider==='agy'?'agy':'Muse Image';
 const accountStep={Cartesia:'Open https://play.cartesia.ai/subscription and sign in to the account used by this project. Check the Subscription page’s current plan and credits.',ElevenLabs:'Sign in at https://elevenlabs.io. Click your profile icon at the top right, then Subscription; check your plan and credits.',Replicate:'Open https://replicate.com/account/billing and sign in to the account used by this project. Check the credit balance and billing status.','Muse Image':'Open https://dev.meta.ai and sign in to the account used by this project. Find its billing and usage information.',agy:'Verify the local agy CLI is installed (`agy --version`) and the configured brain directory is writable. No API key or paid balance is required.'}[provider];
 return {problem:`A sourced cost estimate for this ${provider} request is missing.`,solution:'Obtain the provider rate and estimate this exact request, then use the existing approval and budget gates.',steps:[`Check ${provider==='Cartesia'?'https://cartesia.ai/pricing':provider==='Replicate'?'https://replicate.com/bytedance/seedance-2.0-mini':provider==='ElevenLabs'?'https://elevenlabs.io/pricing':provider==='agy'?'local agy installation (no paid rate)':'https://dev.meta.ai'} for the applicable rate.`,"Calculate the estimate for this exact request; identify the rate source and any uncertainty.","Present the estimate and obtain authorization within the project budget. Unknown credits alone do not block planning.",accountStep]};
}

export function remediation(provider, secretsPath) {
  if(provider==='gemini')return `STOP: Gemini media review failed. No fallback or retry was submitted.\n1. Open https://aistudio.google.com/api-keys and sign in; select the key's Google Cloud project.\n2. Open Dashboard → Usage/Billing (https://aistudio.google.com/usage); check quota, billing and payment for that project.\n3. Open API keys → Create API key; verify Gemini API access and any key restrictions.\n4. Open ${resolve(secretsPath)} and set GEMINI_API_KEY=<your-key> on its own line. Never paste the key in chat.\n5. Inspect the run's gemini-reviews receipts before another request. An uncertain request is never automatically repeated; HTTP 429 requires waiting for the quota window.`;
  if(provider==='agy')return `STOP: agy image generation failed. Quota failures fall back to Muse only when the authorized request carries a bound fallback and META_API_KEY exists; otherwise no fallback or retry was submitted.\n1. Run \`${agyBinary()} --version\` locally; reinstall the Antigravity CLI if missing.\n2. Check WIGGLY_AGY_BIN and WIGGLY_AGY_BRAIN_DIR env values and brain-dir write access.\n3. Inspect receipts/<jobId> started markers, quota markers (*.quota.json) and receipts; reconcile the uncertain subrequest, never duplicate a started subrequest without a receipt or quota marker.\n4. For quota exhaustion with a bound fallback, reconcile with collect-existing then collect to finish quota-marked images on Muse; without a quota marker collection refuses. No API key is required for agy itself.`;
  const cartesia = provider === 'cartesia'; const key = {cartesia:'CARTESIA_API_KEY','meta-muse':'META_API_KEY',replicate:'REPLICATE_API_TOKEN',elevenlabs:'ELEVENLABS_API_KEY'}[provider];
  return `STOP: ${provider} failed. No fallback or retry was submitted.\n1. Open ${{cartesia:'https://play.cartesia.ai','meta-muse':'https://dev.meta.ai',replicate:'https://replicate.com/account/billing',elevenlabs:'https://elevenlabs.io/app/settings/subscription'}[provider]} and sign in.\n2. Open the account's Billing/Usage page; check credits and payment, and add funds if needed.\n3. Open API Keys, verify access to ${{cartesia:'voice cloning and Sonic TTS','meta-muse':'Muse Image',replicate:'Seedance video; API tokens at https://replicate.com/account/api-tokens',elevenlabs:'Music/Sound Effects; API keys at https://elevenlabs.io/app/settings/api-keys'}[provider]}, and copy a valid key.\n4. Open ${resolve(secretsPath)} and set ${key}=<your-key> on its own line. Never paste the key in chat.\n5. Read status and reconcile the recorded job before another request. For 429, wait for the provider retry window; for an outage, check the provider status/support page.`;
}
export async function loadKey(provider, secretsPath) {
  if(provider==='agy')throw new Error('agy needs no API key; do not call loadKey for agy.');
  const name = {cartesia:'CARTESIA_API_KEY','meta-muse':'META_API_KEY',replicate:'REPLICATE_API_TOKEN',elevenlabs:'ELEVENLABS_API_KEY',gemini:'GEMINI_API_KEY',openrouter:'OPENROUTER_API_KEY'}[provider];if(!name)throw new Error('Unknown provider.');
  const source = await readFile(secretsPath, 'utf8');
  const match = source.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)\\s*$`, 'm'));
  if (!match) throw new Error(`Missing named ${name} in ${resolve(secretsPath)}.`);
  const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!value) throw new Error(`Empty ${name}.`); return value;
}
// An authenticated metadata lookup, never a clone/TTS request or quality approval.
export async function lookupExistingVoice(p,secretsPath,fetcher=fetch){
 const choice=p.voiceChoice;if(!choice)throw new Error('Select the actual human-provided Cartesia voice first.');
 const apiVersion=(studioFor(p)?.config.generation??legacyGeneration).voice.apiVersion,endpoint=`https://api.cartesia.ai/voices/${choice.voiceId}`;
 let key;
 try{
  key=await loadKey('cartesia',secretsPath);
  const response=await fetcher(endpoint,{method:'GET',headers:{Authorization:`Bearer ${key}`,'Cartesia-Version':apiVersion},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Get Voice HTTP ${response.status}.`);
  const v=await response.json();
  if(v.id!==choice.voiceId||v.name!==choice.name||v.is_owner!==true||v.status!=='active')throw new Error('Selected voice ID/name must match an active voice owned by this account.');
  return VoiceLookup.parse({voiceId:v.id,name:v.name,language:v.language,isOwner:v.is_owner,status:v.status,access:v.access,apiVersion,checkedAt:new Date().toISOString(),endpoint,httpStatus:200});
 }catch(e){throw new Error(`${key?e.message.replaceAll(key,'[redacted]'):e.message}\n${remediation('cartesia',secretsPath)}`);}
}
// Metadata-only checks cannot establish paid generation entitlement or output quality.
export async function checkProvider(provider,secretsPath,fetcher=fetch,spawnFn){
 if(provider==='agy'){
  const { spawnSync } = await import('node:child_process');
  const bin = process.env.WIGGLY_AGY_BIN || 'agy';
  const run = spawnFn ?? spawnSync;
  let result;
  try { result = run(bin, ['--version'], { encoding: 'utf8' }); }
  catch (e) { throw new Error(`agy binary not found at ${bin}: ${e.message}\n${remediation('agy', secretsPath)}`); }
  if(result.error?.code==='ENOENT')throw new Error(`agy binary not found at ${bin}.\n${remediation('agy', secretsPath)}`);
  if(result.status!==0)throw new Error(`agy --version failed: ${(result.stderr||result.stdout||'').slice(0,400)}\n${remediation('agy', secretsPath)}`);
  return {provider:'agy',checkedAt:new Date().toISOString(),status:'binary-verified',binary:bin,version:(result.stdout||'').trim().slice(0,200),authenticatedRead:false,generationReady:true,unverified:['actual generation/output quality'],mediaGenerationCalls:0,projectStateMutated:false};
 }
 const definitions={cartesia:{urls:['https://api.cartesia.ai/voices?limit=1'],docs:'https://docs.cartesia.ai/api-reference/voices/list'},'meta-muse':{urls:['https://api.meta.ai/v1/models/muse-image-1.0'],docs:'https://dev.meta.ai/docs/api-reference/models/retrieve-model'},replicate:{urls:['https://api.replicate.com/v1/account','https://api.replicate.com/v1/models/bytedance/seedance-2.0-mini'],docs:'https://replicate.com/docs/reference/http'},elevenlabs:{urls:['https://api.elevenlabs.io/v1/user/subscription'],docs:'https://elevenlabs.io/docs/api-reference/user/subscription/get'}};
 definitions.gemini={urls:['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash'],docs:'https://ai.google.dev/api/models#method:-models.get'};
 const definition=definitions[provider];if(!definition)throw new Error('Use cartesia, meta-muse, agy, replicate, elevenlabs or gemini.');
 let apiKey;
 try{
  apiKey=await loadKey(provider,secretsPath);const bodies=[];
  for(const url of definition.urls){
   const response=await fetcher(url,{method:'GET',headers:provider==='gemini'?{'x-goog-api-key':apiKey}:provider==='elevenlabs'?{'xi-api-key':apiKey}:{Authorization:`Bearer ${apiKey}`,...(provider==='cartesia'?{'Cartesia-Version':'2026-08-14'}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok){const body=await response.text();throw new Error(`GET ${url}: HTTP ${response.status}: ${body.replaceAll(apiKey,'[redacted]').slice(0,400)}`);}
   bodies.push(await response.json());
  }
  if(provider==='cartesia'&&!Array.isArray(bodies[0].data)||provider==='meta-muse'&&bodies[0].id!=='muse-image-1.0'||provider==='replicate'&&(!bodies[0].type||bodies[1].owner!=='bytedance'||bodies[1].name!=='seedance-2.0-mini')||provider==='elevenlabs'&&typeof bodies[0].status!=='string')throw new Error('Provider metadata response does not match its documented contract.');
  if(provider==='gemini'&&bodies[0].name!=='models/gemini-3.8-flash')throw new Error('Gemini metadata must identify the exact selected model.');
  return {provider,checkedAt:new Date().toISOString(),status:'metadata-verified',endpoints:definition.urls,documentation:definition.docs,authenticatedRead:true,...(provider==='elevenlabs'?{subscriptionStatus:bodies[0].status}:{}),generationReady:false,unverified:['paid generation entitlement and funds','account-specific price and spend estimate','actual generation/output quality'],mediaGenerationCalls:0,projectStateMutated:false};
 }catch(error){const message=apiKey?error.message.replaceAll(apiKey,'[redacted]'):error.message;throw new Error(`${message}\n${remediation(provider,secretsPath)}`);}
}
// Each subrequest has a durable started marker and result. Unknown outcomes are never retried.
export async function executeJob(p, job, runDir, apiKey, fetcher = fetch, collectOnly = false, onJobId, { tracer = null } = {}) {
  if(!collectOnly)assertDebugReady(p);
  const recorded = p.jobs.find(j => j.id === job.id && j.digest === job.digest);
  if (p.gate !== 'collect' || p.step !== job.plan.operation || !recorded?.authorization || !['submitting', 'submitted', 'uncertain'].includes(recorded.status) || recorded.key !== keyFor(p) || digest({ plan: job.plan, request: job.request, dependencies: job.dependencies }) !== recorded.digest || job.dependencies.some(id => !p.artifacts.some(a => a.id === id && a.valid))) throw new Error('UNAUTHORIZED_PROVIDER_CALL: use the current recorded request after the runner checkpoints submission.');
  assertAllowed(p, p.step);
  if(job.request.regeneration){const parent=artifact(p,'narration'),scope=job.request.regeneration;if(!p.narrationRegeneration||parent?.id!==scope.artifactId||parent.digest!==scope.artifactDigest||digest(parent)!==digest(scope.parent)||digest(requestDescriptor(p,job.plan))!==digest(job.request))throw new Error('NARRATION_REGENERATION_STALE: exact current parent, human scope and request required.');}
  return executeMediaRequest(job, runDir, apiKey, fetcher, collectOnly, onJobId, { tracer });
}
// Trusted transport boundary. The caller must authorize and persist the exact request
// before entry; workers never receive this function or provider credentials.
export async function executeMediaRequest(job, runDir, apiKey, fetcher = fetch, collectOnly = false, onJobId, { tracer = null } = {}) {
  const request = job.request; await verifyFiles(request);
  const dir = join(runDir, 'receipts', job.id); await mkdir(dir, { recursive: true });
  if(job.plan.provider==='replicate'){const cached=join(dir,'result.json');try{return JSON.parse(await readFile(cached,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}const result=await executeVideo({...job,request:{...job.request,runDir}},dir,apiKey,fetcher,collectOnly,onJobId);if(!result.pending)await atomicJson(cached,result);return result;}
  const post = async (index, body, headers, binary = false) => {
    const receipt = join(dir, `${index}.json`); const started = join(dir, `${index}.started`);
    try { return JSON.parse(await readFile(receipt, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (collectOnly) throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${index}; no completed receipt exists. Collection will not submit it.`);
    try { await writeFile(started, JSON.stringify({ jobId: job.id, digest: job.digest, index }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${index}. Reconcile its existing result; never duplicate it.`); throw e; }
    const estimatedCostUsd = planTotalCost(job.plan);
    const timer = paidJobTimer(tracer, {
      provider: job.plan.provider,
      jobId: job.id,
      operation: job.plan.operation,
      step: job.plan.operation,
      estimatedCostUsd,
      actualCostUsd: estimatedCostUsd,
      actualCostSource: 'estimate',
    });
    let response;
    try {
      response = await fetcher(request.endpoint, { method: 'POST', headers: { ...(job.plan.provider==='elevenlabs'?{'xi-api-key':apiKey}:{Authorization:`Bearer ${apiKey}`}), ...headers }, body, signal: AbortSignal.timeout(180000) });
    } catch (err) {
      timer.fail(err);
      throw err;
    }
    if (!response.ok) {
      const diagnostic = (await response.text()).replaceAll(apiKey, '[redacted]').slice(0, 800);
      const err = new Error(`HTTP ${response.status}: ${diagnostic}`);
      err.status = response.status;
      timer.fail(err);
      throw err;
    }
    let result;
    if (binary) { const path = join(dir, `${index}.${job.plan.provider==='elevenlabs'?'mp3':'wav'}`); await writeFile(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 }); result = { file: await importMedia(path, runDir) }; }
    else result = await response.json();
    timer.ok();
    await atomicJson(receipt, result); return result;
  };
  let result;
  if(job.plan.provider==='elevenlabs'){const response=await post(0,JSON.stringify(request.body),{'Content-Type':'application/json'},true);result={files:[response.file],prompt:job.plan.parameters.prompt,provenance:request.provenance};}
  else if (job.plan.operation === 'clone') {
    const form = new FormData(); form.append('clip', new Blob([await readFile(request.clip.path)]), `sample${extname(request.clip.path)}`);
    form.append('language', request.language); form.append('name', request.name); form.append('access', 'private');
    const response = await post(0, form, { 'Cartesia-Version': request.cartesiaVersion });
    if (typeof response.id !== 'string' || !response.id) throw new Error('Clone response is missing voice ID.');
    result = { voiceId: response.id, provider: 'cartesia', receiptId: job.id };
  } else if (job.plan.provider === 'cartesia') {
    const files = [];
    for (const [i, transcript] of request.transcripts.entries()) {
      const { file } = await post(i, JSON.stringify({ model_id: request.model_id, voice: request.voice, transcript, language: request.language, output_format: request.output_format, generation_config: request.generation_config }),
        { 'Content-Type': 'application/json', 'Cartesia-Version': request.cartesiaVersion }, true);
      files.push(file);
    }
    const windows=request.beatWindowSeconds===15?[]:null;
    if(windows)for(const [i,file] of files.entries())windows.push(await narrationWindow(file,runDir,join(dir,`window-${i}.wav`)));
    result = job.plan.operation === 'audition' ? { files, voiceId: request.voice, transcript: request.transcripts[0] } : { files:windows?windows.map(w=>w.file):files, voiceId: request.voice, transcripts: request.transcripts, model: request.model_id,...(windows?{sourceFiles:files,tailSilenceSeconds:windows.map(w=>w.tailSilenceSeconds)}:{}) };
    if(request.regeneration){
      const scope=request.regeneration,i=scope.beat-1;result=structuredClone(scope.parent.content);
      result.files[i]=windows[0].file;result.sourceFiles[i]=files[0];result.tailSilenceSeconds[i]=windows[0].tailSilenceSeconds;
      const edits=result.audioEdits?.filter(e=>e.beat!==scope.beat);if(edits?.length)result.audioEdits=edits;else delete result.audioEdits;
      result.audioRegenerations=[...(result.audioRegenerations??[]).filter(e=>e.beat!==scope.beat),{beat:scope.beat,spokenText:scope.spokenText,parentArtifactId:scope.artifactId,parentArtifactDigest:scope.artifactDigest,jobId:job.id,requestDigest:job.digest}];
    }
  } else if (job.plan.provider === 'agy') {
    const fallback = request.fallback ?? null;
    const readJsonOrNull = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
    const files = Array(request.n).fill(null);
    const providers = Array(request.n).fill(null);
    for (let i = 0; i < request.n; i++) {
      const r = await readJsonOrNull(join(dir, `${i}.json`));
      if (r?.file) { files[i] = r.file; providers[i] = { index: i, provider: r.provider ?? 'agy', costUsd: r.costUsd ?? (r.provider === 'meta-muse' ? (fallback?.unitCostUsd ?? 0.01) : 0) }; }
    }
    const missingIndices = () => files.map((f, i) => f ? null : i).filter(v => v !== null);
    const finishResult = () => {
      const kind = providers.every(p => p?.provider === 'agy') ? 'agy' : providers.every(p => p?.provider === 'meta-muse') ? 'meta-muse' : 'mixed';
      return { files: [...files], prompt: request.prompt, provider: kind, imageProviders: [...providers] };
    };
    const runMuseFallback = async indices => {
      if (job.plan.operation === 'video') throw new Error('No image fallback for video operations.');
      if (!fallback) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up; no fallback bound to this job.`);
      if (!apiKey) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up; no META_API_KEY for the Muse fallback.`);
      for (const j of indices) {
        if (files[j]) continue;
        const quota = await readJsonOrNull(join(dir, `${j}.quota.json`));
        try { await writeFile(join(dir, `${j}.started`), JSON.stringify({ jobId: job.id, digest: job.digest, index: j, fallback: true }), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code === 'EEXIST') { if (!quota) throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${j}. Reconcile its existing result; never duplicate it.`); } else throw e; }
        // One Muse attempt per index: a fallback that started without a receipt is uncertain (it may have been billed).
        try { await writeFile(join(dir, `${j}.fallback.started`), JSON.stringify({ jobId: job.id, digest: job.digest, index: j }), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code === 'EEXIST') throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${j}. Its Muse fallback already started without a receipt; reconcile it, never duplicate it.`); throw e; }
      }
      const images = await Promise.all(request.images.map(async f => ({ image_url: `data:image/${extname(f.path).slice(1).replace('jpg', 'jpeg')};base64,${(await readFile(f.path)).toString('base64')}` })));
      const body = museRequestBody({ model: fallback.model, prompt: request.prompt, n: indices.length, size: fallback.size, response_format: fallback.response_format, output_format: fallback.output_format, tool_enablement: fallback.tool_enablement }, images);
      const museEstimate = (fallback.unitCostUsd ?? 0.01) * indices.length;
      const museTimer = paidJobTimer(tracer, {
        provider: 'meta-muse',
        jobId: job.id,
        operation: job.plan.operation,
        step: job.plan.operation,
        estimatedCostUsd: museEstimate,
        actualCostUsd: museEstimate,
        actualCostSource: 'estimate',
        fallbackFrom: 'agy',
      });
      let response;
      try { response = await fetcher(fallback.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) }); }
      catch (e) {
        museTimer.fail(e);
        throw new Error((apiKey ? e.message.replaceAll(apiKey, '[redacted]') : e.message));
      }
      if (!response.ok) {
        const diagnostic = (await response.text()).replaceAll(apiKey, '[redacted]').slice(0, 800);
        const err = new Error(`HTTP ${response.status}: ${diagnostic}`);
        err.status = response.status;
        museTimer.fail(err);
        throw err;
      }
      const parsed = await response.json();
      if (!Array.isArray(parsed.data) || parsed.data.length !== indices.length || parsed.data.some(d => !d.b64_json)) {
        const err = new Error('Muse must return the exact requested image count as base64; no remote-image fallback.');
        museTimer.fail(err);
        throw err;
      }
      const museFiles = [];
      for (const [k, j] of indices.entries()) {
        if (files[j]) continue;
        const path = join(dir, `${j}.${fallback.output_format}`);
        await writeFile(path, Buffer.from(parsed.data[k].b64_json, 'base64'), { mode: 0o600 });
        const file = await importMedia(path, runDir);
        const recorded = { file, provider: 'meta-muse', costUsd: fallback.unitCostUsd };
        await atomicJson(join(dir, `${j}.json`), recorded);
        files[j] = file; providers[j] = { index: j, provider: 'meta-muse', costUsd: fallback.unitCostUsd };
        museFiles.push({ sha256: file.sha256, bytes: file.bytes });
      }
      museTimer.ok({ files: museFiles });
    };
    if (collectOnly) {
      const miss = missingIndices();
      if (!miss.length) result = finishResult();
      else {
        if (!fallback) throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${miss[0]}. Reconcile its existing result; never duplicate it.`);
        let haveQuota = false;
        for (let q = 0; q < request.n; q++) if (await readJsonOrNull(join(dir, `${q}.quota.json`))) { haveQuota = true; break; }
        if (!haveQuota) throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${miss[0]}. Reconcile its existing result; never duplicate it.`);
        for (const j of miss) {
          if (await readJsonOrNull(join(dir, `${j}.quota.json`))) continue;
          try { await stat(join(dir, `${j}.started`)); throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${j}. Reconcile its existing result; never duplicate it.`); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        if (!apiKey) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up; no META_API_KEY for the Muse fallback.`);
        await runMuseFallback(miss);
        result = finishResult();
      }
    } else {
      for (let i = 0; i < request.n; i++) {
        if (files[i]) continue;
        try { await writeFile(join(dir, `${i}.started`), JSON.stringify({ jobId: job.id, digest: job.digest, index: i }), { flag: 'wx', mode: 0o600 }); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (!await readJsonOrNull(join(dir, `${i}.quota.json`))) throw new Error(`UNCERTAIN_SUBREQUEST: ${job.id}/${i}. Reconcile its existing result; never duplicate it.`);
          const miss = missingIndices();
          if (!fallback) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up; no fallback bound to this job.`);
          if (!apiKey) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up; no META_API_KEY for the Muse fallback.`);
          await runMuseFallback(miss);
          break;
        }
        const agyTimer = paidJobTimer(tracer, {
          provider: 'agy',
          jobId: job.id,
          operation: job.plan.operation,
          step: job.plan.operation,
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          actualCostSource: 'free',
        });
        try {
          const outPath = join(dir, `${i}.png`);
          const { outputPath } = await generateAgyImage({ prompt: request.prompt, aspectRatio: request.aspectRatio, imageName: `${job.id}-${i}`, imagePaths: request.images.map(f => f.path), outputPath: outPath, brainDir: process.env.WIGGLY_AGY_BRAIN_DIR ? resolve(process.env.WIGGLY_AGY_BRAIN_DIR) : undefined, bin: process.env.WIGGLY_AGY_BIN || undefined, timeoutMs: process.env.WIGGLY_AGY_TIMEOUT_MS ? Number(process.env.WIGGLY_AGY_TIMEOUT_MS) : undefined });
          const file = await importMedia(outputPath, runDir);
          const recorded = { file, provider: 'agy', costUsd: 0 };
          await atomicJson(join(dir, `${i}.json`), recorded);
          files[i] = file; providers[i] = { index: i, provider: 'agy', costUsd: 0 };
          agyTimer.ok({ files: [{ sha256: file.sha256, bytes: file.bytes }] });
        } catch (e) {
          agyTimer.fail(e);
          if (!isAgyQuotaError(e.message)) throw e;
          const reset = parseAgyQuotaReset(e.message);
          const diagnostic = String(e.message ?? e).slice(0, 800);
          await atomicJson(join(dir, `${i}.quota.json`), { diagnostic, reset, at: new Date().toISOString() });
          const miss = missingIndices();
          if (!fallback) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up${reset ? ` (resets ${reset})` : ''}; no fallback bound to this job.`);
          if (!apiKey) throw new Error(`AGY_QUOTA_EXHAUSTED: agy image quota is used up${reset ? ` (resets ${reset})` : ''}; no META_API_KEY for the Muse fallback.`);
          await runMuseFallback(miss);
          break;
        }
      }
      result = finishResult();
    }
  } else {
    const images = await Promise.all(request.images.map(async f => ({ image_url: `data:image/${extname(f.path).slice(1).replace('jpg', 'jpeg')};base64,${(await readFile(f.path)).toString('base64')}` })));
    const response = await post(0, JSON.stringify(museRequestBody(request, images)), { 'Content-Type': 'application/json' });
    if (!Array.isArray(response.data) || response.data.length !== request.n || response.data.some(d => !d.b64_json)) throw new Error('Muse must return the exact requested image count as base64; no remote-image fallback.');
    const files = [];
    for (const [i, data] of response.data.entries()) { const path = join(dir, `${i}.${request.output_format}`); await writeFile(path, Buffer.from(data.b64_json, 'base64'), { mode: 0o600 }); files.push(await importMedia(path, runDir)); }
    const unit = job.plan.estimatedCostUsd / request.n;
    result = { files, prompt: request.prompt, provider: 'meta-muse', imageProviders: files.map((_, i) => ({ index: i, provider: 'meta-muse', costUsd: unit })) };
  }
  await atomicJson(join(dir, 'result.json'), result); return result;
}
