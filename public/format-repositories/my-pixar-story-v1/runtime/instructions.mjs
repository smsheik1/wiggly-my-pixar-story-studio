import {z} from 'zod';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const checksum=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sha=s=>createHash('sha256').update(s).digest('hex');
// Config may narrow permissions. It cannot grant ambient tools or another role's tools.
export const maximumTools={"script-writer": ["readAsset"], "text-reviewer": ["readAsset", "viewImage"], "cast-designer": ["readAsset", "viewImage"], "sheet-prompter": ["readAsset", "viewImage"], "background-product-owner": ["readAsset", "viewImage"], "pixar-prompter": ["readAsset", "viewImage"], "shot-planner": ["readAsset", "viewImage"], "composition-writer": ["readAsset", "viewImage"], "motion-director": ["readAsset", "viewImage"], "video-prompt-engineer": ["readAsset", "viewImage"], "sound-designer": ["readAsset", "listenAudio", "measureAudio"], "film-editor": ["readAsset", "viewImage", "watchVideo", "listenAudio", "measureAudio", "transcribe", "inspectAudio", "renderAudioEdit"], "audio-reviewer": ["readAsset", "listenAudio", "measureAudio", "transcribe", "speakerSimilarity"], "visual-reviewer": ["readAsset", "viewImage", "watchVideo"], "scene-reviewer": ["readAsset", "viewImage", "watchVideo"], "generation-planner": ["readAsset", "viewImage"], "voice-director": ["readAsset", "listenAudio", "measureAudio", "transcribe", "inspectAudio", "renderAudioEdit"]};
const text=z.string().trim().min(1);
const names={"script-writer": "Leo", "text-reviewer": "Sage", "cast-designer": "Cleo", "sheet-prompter": "Pia", "background-product-owner": "Beau", "pixar-prompter": "Theo", "shot-planner": "Sam", "composition-writer": "Cam", "motion-director": "Mo", "video-prompt-engineer": "Vin", "sound-designer": "Finn", "film-editor": "Eli", "audio-reviewer": "Ava", "visual-reviewer": "Vera", "scene-reviewer": "June", "generation-planner": "Max", "voice-director": "Nora"};
const agents=z.object(Object.fromEntries(Object.entries(maximumTools).map(([role,tools])=>[role,z.object({name:z.literal(names[role]),backend:z.enum(['codex','openrouter']).optional(),model:text,skill:z.literal(`crew/${names[role].toLowerCase()}/SKILL.md`),tools:z.array(z.enum(tools)).min(1).refine(v=>new Set(v).size===v.length)}).strict()]))).strict();
export const backendForAgent=(agent)=>agent?.backend??'codex';
const autoLockSteps=z.array(z.enum(['shotIntentions','backgrounds','backgroundBrief','backgroundPrompt','backgroundAngleBrief','backgroundAnglePrompt','characterPrompt','sheetPrompt','shots','keyframePrompt']));
const autoAuthorizeOperations=z.array(z.enum(['candidates','sheet','backgroundCandidates','backgroundAngle','keyframe','audition','narration']));
const gatesBlock=z.object({defaultPolicy:z.enum(['per-step','pick-only']),autoLockSteps,autoAuthorizeOperations}).strict();
const prescreenBlock=z.object({enabled:z.boolean(),provider:z.literal('openrouter-decisions'),model:text,steps:z.array(z.enum(['candidates','backgroundCandidates','backgroundAngle','keyframe'])).min(1),passAbove:z.number().min(0).max(1),failBelow:z.number().min(0).max(1),maxPerArtifact:z.number().int().positive(),estimatedCostUsdPerCall:z.number().nonnegative()}).strict().refine(v=>v.failBelow<v.passAbove&&v.failBelow>0&&v.passAbove<1,'prescreen thresholds need 0 < failBelow < passAbove < 1');
const craftBlock=z.object({path:text,sections:z.record(z.string(),z.array(text))}).strict();
export const StudioConfig=z.object({version:z.literal(1),writingPolicy:z.literal('grounded-v1').optional(),agents,
 craft:craftBlock.optional(),
 generation:z.object({voice:z.object({provider:z.literal('cartesia'),model:text,apiVersion:text}).strict(),image:z.union([z.object({provider:z.enum(['agy','meta-muse']),model:text,metaMuseEstimatedUnitCostUsd:z.number().nonnegative(),agyEstimatedUnitCostUsd:z.number().nonnegative()}).strict(),z.object({provider:z.literal('meta-muse'),model:z.literal('muse-image-1.0'),estimatedUnitCostUsd:z.literal(.01)}).strict()]),video:z.object({provider:z.literal('replicate'),profile:z.literal('seedance-mini-480p'),model:z.literal('seedance-2.0-mini'),resolution:z.literal('480p'),rates:z.record(z.string(),z.object({usdPerSecond:z.number().positive(),source:text,basis:text,verifiedAt:text}).strict()).optional()}).strict(),mediaReview:z.object({provider:z.literal('gemini'),model:z.literal('gemini-3.8-flash'),samplingFps:z.literal(4)}).strict(),music:z.object({provider:z.literal('elevenlabs'),model:z.literal('music_v2_5'),enabledByDefault:z.literal(false),usdPerMinute:z.number().nonnegative().optional(),source:text.optional(),verifiedAt:text.optional(),basis:text.optional()}).strict(),effect:z.object({provider:z.literal('elevenlabs'),model:z.literal('eleven_text_to_sound_v2'),enabledByDefault:z.literal(false),usdPerMinute:z.number().nonnegative().optional(),source:text.optional(),verifiedAt:text.optional(),basis:text.optional()}).strict()}).strict(),
 limits:z.object({generationAttempts:z.number().int().min(1).max(3),reviewDisagreements:z.number().int().min(1).max(2),finishedWorkerAttempts:z.number().int().min(1).max(3),crewTasksPerDispatch:z.number().int().min(1).max(32),initialSpendCeilingUsd:z.literal(0)}).strict(),
 reviewers:z.object({'text-reviewer':z.literal('evaluation/rubrics/text.md'),'audio-reviewer':z.literal('evaluation/rubrics/audio.md'),'visual-reviewer':z.literal('evaluation/rubrics/visual.md'),'scene-reviewer':z.literal('evaluation/rubrics/scene.md')}).strict(),
 recipes:z.object({characterPrompt:z.literal('character-prompter.md'),sheetPrompt:z.literal('character-sheet-recipe.md'),backgroundPrompt:z.literal('background-prompter.md'),backgroundAnglePrompt:z.literal('background-prompter.md')}).strict(),communication:z.literal('orchestrator-voice.md'),gates:gatesBlock.optional(),prescreen:prescreenBlock.optional()}).strict();
const Document=z.object({content:z.string().min(1),sha256:text.regex(/^[a-f0-9]{64}$/)}).strict().refine(d=>sha(d.content)===d.sha256,'Instruction content hash changed.');
export const StudioSnapshot=z.object({config:StudioConfig,documents:z.record(z.string(),Document),sha256:text}).strict().superRefine((s,ctx)=>{
 if(checksum({config:s.config,documents:s.documents})!==s.sha256)ctx.addIssue({code:'custom',message:'STUDIO_SNAPSHOT_CHANGED: bundle hash mismatch.'});
 for(const path of [...Object.values(s.config.agents).map(a=>a.skill),...Object.values(s.config.reviewers),...Object.values(s.config.recipes),s.config.communication])if(!s.documents[path])ctx.addIssue({code:'custom',message:`Missing pinned instruction ${path}`});
 if(s.config.craft){
  for(const entries of Object.values(s.config.craft.sections)){
   for(const entry of entries){
    const docKey=`${s.config.craft.path}#${entry}`;
    if(!s.documents[docKey])ctx.addIssue({code:'custom',message:`Missing pinned craft document ${docKey}`});
   }
  }
 }
});
export function loadStudio(root=new URL('../',import.meta.url)){
 const config=StudioConfig.parse(JSON.parse(readFileSync(new URL('studio.json',root),'utf8'))),documents={};
 for(const [role,agent] of Object.entries(config.agents)){
  if(agent.backend!==undefined&&agent.backend!=='codex'&&agent.backend!=='openrouter')throw new Error(`STUDIO_BACKEND_UNKNOWN: ${role} has unknown backend.`);
  if(agent.backend===undefined||!agent.model)throw new Error(`STUDIO_BACKEND_MISSING: ${role} needs an explicit backend (codex|openrouter) and model.`);
 }
 for(const path of new Set([...Object.values(config.agents).map(a=>a.skill),...Object.values(config.reviewers),...Object.values(config.recipes),config.communication])){const content=readFileSync(new URL(path,root),'utf8');documents[path]={content,sha256:sha(content)};}
 // Per-step guides: pin any crew/<name>/steps/<step>.md that exists, for any
 // agent whose skill dir has a steps/ folder. Optional: old snapshots without
 // these documents still load (the schema check above never requires them).
 for(const agent of Object.values(config.agents)){
  const dir=agent.skill.replace(/\/SKILL\.md$/,'');
  let entries;try{entries=readdirSync(new URL(`${dir}/steps/`,root));}catch{continue;}
  for(const file of entries.filter(f=>f.endsWith('.md')).sort()){
   const path=`${dir}/steps/${file}`;
   if(documents[path])continue;
   const content=readFileSync(new URL(path,root),'utf8');documents[path]={content,sha256:sha(content)};
  }
 }
 if(config.craft){
  for(const role of Object.keys(config.craft.sections)){
   if(!config.agents[role])throw new Error(`CRAFT_UNKNOWN_ROLE: Role "${role}" in craft mapping is not in agents.`);
  }
  const raw=readFileSync(new URL(config.craft.path,root),'utf8');
  const sectionHeadingRegex=/^##\s*\[([a-zA-Z0-9_-]+)\][^\r\n]*/gm;
  const headings=[];
  let match;
  while((match=sectionHeadingRegex.exec(raw))!==null){
   headings.push({id:match[1],index:match.index});
  }
  const seenSections=new Set();
  const sectionContents=new Map();
  const seenRules=new Map();
  const sectionRules=new Map();

  for(let i=0;i<headings.length;i++){
   const {id,index}=headings[i];
   if(seenSections.has(id))throw new Error(`CRAFT_DUPLICATE_SECTION: Duplicate section ID "${id}" in craft guide.`);
   seenSections.add(id);
   const end=i+1<headings.length?headings[i+1].index:raw.length;
   const content=raw.slice(index,end).trim();
   sectionContents.set(id,content);
   const ruleMap=new Map();
   sectionRules.set(id,ruleMap);

   const ruleRegex=/^[ \t]*-[ \t]*\[([A-Z0-9_-]+)\][^\r\n]*/gm;
   let rMatch;
   while((rMatch=ruleRegex.exec(content))!==null){
    const ruleId=rMatch[1],ruleLine=rMatch[0].trim();
    if(seenRules.has(ruleId)){
     throw new Error(`CRAFT_DUPLICATE_RULE: Duplicate rule ID "${ruleId}" in craft guide (in "${seenRules.get(ruleId)}" and "${id}").`);
    }
    seenRules.set(ruleId,id);
    ruleMap.set(ruleId,ruleLine);
   }
  }

  for(const [role,entries] of Object.entries(config.craft.sections)){
   for(const entry of entries){
    if(entry.includes('#')){
     const [secId,ruleId,...extra]=entry.split('#');
     if(extra.length>0||!secId||!ruleId)throw new Error(`CRAFT_MALFORMED_ENTRY: Invalid mapping entry "${entry}".`);
     if(!seenSections.has(secId))throw new Error(`CRAFT_UNKNOWN_SECTION: Unknown section "${secId}" in mapping entry "${entry}".`);
     if(!sectionRules.get(secId)?.has(ruleId))throw new Error(`CRAFT_UNKNOWN_RULE: Unknown rule "${ruleId}" in section "${secId}" for mapping entry "${entry}".`);
    }else{
     if(!seenSections.has(entry))throw new Error(`CRAFT_UNKNOWN_SECTION: Unknown section "${entry}" in craft mapping for role "${role}".`);
    }
   }
  }

  for(const [secId,content] of sectionContents.entries()){
   const key=`${config.craft.path}#${secId}`;
   documents[key]={content,sha256:sha(content)};
  }

  for(const entries of Object.values(config.craft.sections)){
   for(const entry of entries){
    if(entry.includes('#')){
     const [secId,ruleId]=entry.split('#');
     const ruleLine=sectionRules.get(secId).get(ruleId);
     const key=`${config.craft.path}#${secId}#${ruleId}`;
     documents[key]={content:ruleLine,sha256:sha(ruleLine)};
    }
   }
  }
 }
 return StudioSnapshot.parse({config,documents,sha256:checksum({config,documents})});
}
// Missing snapshot means an older project; never silently adopt current editable files.
export const studioFor=p=>p.studio?StudioSnapshot.parse(p.studio):null;
export const limitsFor=p=>studioFor(p)?.config.limits??{generationAttempts:3,reviewDisagreements:2,finishedWorkerAttempts:3,crewTasksPerDispatch:8,initialSpendCeilingUsd:0};
export function recipeFor(p,stage,fallback){const s=studioFor(p);return s?s.documents[s.config.recipes[stage]]:fallback;}
export function workerInstructions(p,role){
 const s=studioFor(p);if(!s)return null;const agent=s.config.agents[role];if(!agent)return null;
 const res={skill:{path:agent.skill,...s.documents[agent.skill]},allowedTools:agent.tools,studioVersion:s.config.version,studioSha256:s.sha256};
 if(s.config.craft){
  const entries=s.config.craft.sections[role]??[];
  res.craft=entries.map(entry=>{
   const doc=s.documents[`${s.config.craft.path}#${entry}`];
   return {id:entry,content:doc.content,sha256:doc.sha256};
  });
 }
 return res;
}
export function communicationFor(p){const s=studioFor(p);return s?{path:s.config.communication,...s.documents[s.config.communication]}:null;}

// Historical runs have no snapshot. Keep their supported defaults fixed.
export const legacyGeneration={voice:{model:'sonic-3.6-2026-08-27',apiVersion:'2026-08-14'},image:{provider:'meta-muse',model:'muse-image-1.0',metaMuseEstimatedUnitCostUsd:.01,estimatedUnitCostUsd:.01,agyEstimatedUnitCostUsd:0},video:{model:'seedance-2.0-mini',resolution:'480p'},music:{model:'music_v2_5'},effect:{model:'eleven_text_to_sound_v2'}};
export const imageProviderFor=p=>(studioFor(p)?.config.generation??legacyGeneration).image.provider??'meta-muse';
export const imageUnitCostFor=(p,provider=imageProviderFor(p))=>{
  const image=(studioFor(p)?.config.generation??legacyGeneration).image;
  if(provider==='agy')return image.agyEstimatedUnitCostUsd??0;
  return image.metaMuseEstimatedUnitCostUsd??image.estimatedUnitCostUsd;
};
export const imageAspectFor=operation=>['candidates','sheet'].includes(operation)?'4:3':'16:9';
export const metaMuseSizeFor=aspect=>aspect==='4:3'?'1536x1152':'1536x864';
