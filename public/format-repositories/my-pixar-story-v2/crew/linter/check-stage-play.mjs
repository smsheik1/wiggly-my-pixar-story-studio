#!/usr/bin/env node
// v2 linter stub: deterministic timing checks on a Story Director stage play JSON.
// Usage: node check-stage-play.mjs <stage-play.json> [--beat-seconds 15]
import {readFileSync} from 'node:fs';
const file=process.argv[2];if(!file){console.error('usage: check-stage-play.mjs <file.json>');process.exit(2);}
const bi=process.argv.indexOf('--beat-seconds');const BEAT=bi>0?Number(process.argv[bi+1]):15;
const doc=JSON.parse(readFileSync(file,'utf8'));const errs=[];
const beats=doc.beats??[];
if(beats.length!==4)errs.push(`expected 4 beats, got ${beats.length}`);
let total=0;
for(const b of beats){
  const tag=`beat ${b.beat}`;
  if(b.durationSeconds!==BEAT)errs.push(`${tag}: durationSeconds ${b.durationSeconds} != ${BEAT}`);
  if(BEAT>30)errs.push(`${tag}: segment > 30 s`);
  const shots=b.shots??[];if(!shots.length)errs.push(`${tag}: no shots`);
  let t=0,sum=0;
  for(const s of shots){
    const id=`${tag} ${s.id}`;
    if(!Number.isInteger(s.start)||!Number.isInteger(s.end))errs.push(`${id}: non-integer timecode ${s.start}-${s.end}`);
    if(s.start!==t)errs.push(`${id}: starts at ${s.start}, expected ${t} (gap/overlap)`);
    const d=s.end-s.start;if(d<2)errs.push(`${id}: ${d}s < 2s minimum`);
    sum+=d;t=s.end;
  }
  if(sum!==BEAT)errs.push(`${tag}: shot durations sum ${sum} != ${BEAT}`);
  if(t!==BEAT)errs.push(`${tag}: last shot ends at ${t}, expected ${BEAT}`);
  for(const q of b.dialogue??[])if(!/^\{[^{}]+\}$/.test(q.line??''))errs.push(`${tag}: dialogue not braced: ${q.line}`);
  if(/\//.test(b.narration??''))errs.push(`${tag}: slash in narration`);
  total+=b.durationSeconds??0;
}
const forbidden=/\b(photorealistic|35mm|film grain|live[- ]action)\b/i;
const m=JSON.stringify(doc).match(forbidden);if(m)errs.push(`forbidden live-action token: ${m[0]}`);
if(errs.length){console.log(`FAIL (${errs.length})`);for(const e of errs)console.log(' - '+e);process.exit(1);}
console.log(`PASS: ${beats.length} beats, ${beats.reduce((n,b)=>n+b.shots.length,0)} shots, ${total}s total`);
