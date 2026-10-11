// Decides whether a PR must run the slow kit suite. Reads changed paths (repo-relative,
// one per line) on stdin; prints "true" or "false". Fail-safe allowlist: the slow suite
// is skipped ONLY when every changed file is known not to affect any slow test. Anything
// unknown (kit runtime, prompts, studio.json, crew skills, fixtures, CI, packaging...)
// runs the slow suite. An empty diff also runs it.
// Usage: git diff --name-only base...HEAD | node tests/needs-slow.mjs
import {readFileSync} from 'node:fs';
import {fastFiles} from './list-tests.mjs';

const KIT='public/format-repositories/my-pixar-story-v1/';
const fast=new Set(fastFiles().map(f=>KIT+f));
export function fastOnly(path){
 if(fast.has(path))return true; // a fast test file itself
 if(/^docs\//.test(path))return true;
 if(/^[^/]+\.md$/.test(path))return true; // top-level README/AGENTS
 if(/^lib\//.test(path))return true;
 // Studio harness code: covered by the studio job, not by kit tests, except the
 // memoir format packaging the kit renderer bundle comes from.
 if(/^scripts\/studio-spike\//.test(path)&&!/^scripts\/studio-spike\/(format-packages\/|memoir-format\.ts$|setup-memoir\.ts$)/.test(path))return true;
 return false;
}
export function needsSlow(paths){
 const list=paths.map(p=>p.trim()).filter(Boolean);
 return list.length===0||list.some(p=>!fastOnly(p));
}
if(import.meta.url===`file://${process.argv[1]}`){
 const paths=readFileSync(0,'utf8').split('\n');
 const list=paths.map(p=>p.trim()).filter(Boolean);
 for(const p of list)if(!fastOnly(p))console.error(`slow trigger: ${p}`);
 console.log(String(needsSlow(paths)));
}
