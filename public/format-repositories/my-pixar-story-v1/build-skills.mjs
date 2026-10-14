// Builds crew/<name>/SKILL.md from shared sources + a short role file, so shared
// rules live in one place and can't drift between agents (crew/build.json).
// Usage: node build-skills.mjs          write every built SKILL.md
//        node build-skills.mjs --check  fail if any built SKILL.md is stale or a check fails
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=new URL('./',import.meta.url);
const read=p=>readFileSync(new URL(p,ROOT),'utf8');
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');

// Zoning colours (the r5 red-nose bug): a colour word tied to nose, cheeks, ears or lips.
const COLOUR=String.raw`(?:red|reddish|pink|pinkish|rose|rosy|blush(?:ed|ing)?|peach|peachy|coral|crimson|scarlet|salmon|magenta|ruddy|flushed)`;
const ZONE=String.raw`(?:nose|nasal|cheeks?|ears?|ear rims?|lips?)`;
export const ZONING_COLOUR=new RegExp(String.raw`\b${COLOUR}\b(?:\W+\w+){0,4}?\W+${ZONE}\b|\b${ZONE}\b(?:\W+\w+){0,4}?\W+${COLOUR}\b`,'i');
// Shared sources carry no colour words at all; colour belongs to the photo.
export const ANY_COLOUR=new RegExp(String.raw`\b${COLOUR}\b`,'i');
export const PROMO=/higgsfield|dankieft|dan kieft|https?:\/\/|use code|link in bio|subscribe|sign up at/i;
export const FORBIDDEN=/\bseedance\b|lock the dialogue|render is the source of truth/i;
// Background roles (beau, theo) must never tell the agent to use a muted palette.
// Rule: every "muted" in those role sources must sit in a "never muted" / "not muted"
// sentence (i.e. the same sentence must also contain "never", "not" or "n't").
// Failure-describing examples comply by adding ", which is never allowed" to the sentence.
export function backgroundMutedProblems(text){
 const bad=[];
 for(const s of String(text).split(/(?<=[.!?;])\s+|\n+/)) if(/\bmuted\b/i.test(s)&&!/\bnever\b|\bnot\b|\bn['’]t\b/i.test(s)) bad.push(s.trim().slice(0,80));
 return bad;
}

export function splitFrontmatter(text){
 const m=text.match(/^---\n[\s\S]*?\n---\n/);
 return m?{front:m[0],body:text.slice(m[0].length).replace(/^\n+/,'')}:{front:'',body:text};
}
const headings=text=>[...text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map(m=>m[1].toLowerCase());
const ruleLines=text=>text.split('\n').map(l=>l.trim().replace(/^[-*\d.]+\s*/,'')).filter(l=>l.length>=60);

export function buildAgent(manifest,name,{readSource=read}={}){
 const spec=manifest.agents[name];
 if(!spec)throw new Error(`BUILD_UNKNOWN_AGENT: ${name}`);
 const shared=[...manifest.shared,...(spec.visual?manifest.visualShared??[]:[])];
 const sources=[...shared.map(path=>({path,text:readSource(path),shared:true})),{path:spec.role,text:readSource(spec.role),shared:false}];
 const errors=[];
 const role=splitFrontmatter(sources.at(-1).text);
 if(!role.front)errors.push(`${spec.role}: role file needs the SKILL frontmatter (name, description)`);
 for(const s of sources){
  if(s.shared&&splitFrontmatter(s.text).front)errors.push(`${s.path}: shared sources carry no frontmatter`);
  if(PROMO.test(s.text))errors.push(`${s.path}: promo line or link (${s.text.match(PROMO)[0]})`);
  if(FORBIDDEN.test(s.text))errors.push(`${s.path}: forbidden term (${s.text.match(FORBIDDEN)[0]})`);
  if(spec.visual&&ZONING_COLOUR.test(s.text))errors.push(`${s.path}: colour named for a face zone (${s.text.match(ZONING_COLOUR)[0]}); facial colour comes from the photo`);
  if(s.shared&&ANY_COLOUR.test(s.text))errors.push(`${s.path}: shared source names a colour (${s.text.match(ANY_COLOUR)[0]})`);
 }
  const seen=new Map();
  for(const s of sources)for(const h of headings(s.text)){
   if(seen.has(h))errors.push(`duplicate section "${h}" in ${seen.get(h)} and ${s.path}`);else seen.set(h,s.path);
  }
  if(name==='beau'||name==='theo')for(const bad of backgroundMutedProblems(role.body))errors.push(`${spec.role}: "muted" outside a "never/not muted" sentence ("${bad}…"); rephrase with never/not in the same sentence`);
 const sharedLines=new Map();
 for(const s of sources.filter(x=>x.shared))for(const l of ruleLines(s.text))sharedLines.set(l,s.path);
 for(const l of ruleLines(role.body))if(sharedLines.has(l))errors.push(`${spec.role} copies a shared rule from ${sharedLines.get(l)}: "${l.slice(0,60)}…"`);
 if(errors.length)throw new Error(`BUILD_CHECK_FAILED for ${name}:\n- ${errors.join('\n- ')}`);
 const sourcesSha=sha(sources.map(s=>`${s.path}\n${sha(s.text)}`).join('\n'));
 const header=`<!-- Built by build-skills.mjs from ${sources.map(s=>s.path).join(' + ')}. Do not edit; edit the sources and rebuild. sources-sha256: ${sourcesSha} -->\n\n`;
 const shared_=sources.filter(s=>s.shared).map(s=>s.text.trim()).join('\n\n');
 const text=`${role.front}${header}${shared_}\n\n${role.body.trim()}\n`;
 return {path:`crew/${name}/SKILL.md`,text,sourcesSha,sha256:sha(text)};
}

export function buildAll({check=false}={}){
 const manifest=JSON.parse(read('crew/build.json'));
 const out=[];
 for(const name of Object.keys(manifest.agents).sort()){
  const b=buildAgent(manifest,name);
  const url=new URL(b.path,ROOT);
  const current=existsSync(url)?readFileSync(url,'utf8'):null;
  if(check){if(current!==b.text)throw new Error(`BUILD_STALE: ${b.path} differs from its sources. Run node build-skills.mjs.`);}
  else if(current!==b.text)writeFileSync(url,b.text);
  out.push(b);
 }
 return out;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const check=process.argv.includes('--check');
 try{for(const b of buildAll({check}))console.log(`${check?'ok':'built'} ${b.path} sha256=${b.sha256}`);}
 catch(e){console.error(e.message);process.exit(1);}
}
