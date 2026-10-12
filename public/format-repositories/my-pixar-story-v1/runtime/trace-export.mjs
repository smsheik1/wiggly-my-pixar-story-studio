// Text export of a run's trace journal (<runDir>/trace/trace.jsonl, written by tracing.mjs).
//   node runner.mjs trace-export --run <runDir | trace.jsonl> [--out file.md]
// One section per crew turn (pipeline step/gate) in order: agent, prompt sections, system prompt,
// packet, response, LLM requests with tokens/cost, tool calls, review verdict, paid jobs, errors.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

export const EXPORT_TEXT_MAX=8000;
const clip=(v,max=EXPORT_TEXT_MAX)=>{
 const s=typeof v==='string'?v:JSON.stringify(v,null,1);
 if(s==null)return '';
 return s.length>max?`${s.slice(0,max)}\n…[export truncated ${s.length-max} chars]`:s;
};
const usd=n=>`$${(Number(n)||0).toFixed(4)}`;
const num=n=>Number(n)||0;

export async function resolveJournal(target){
 if(!target)throw Object.assign(new Error('trace-export needs --run <runDir | trace.jsonl>.'),{exitCode:2});
 let path=target;
 try{const st=await stat(target);if(st.isDirectory())path=join(target,'trace','trace.jsonl');}catch{}
 try{await stat(path);}catch{throw Object.assign(new Error(`TRACE_NOT_FOUND: ${path} (tracing was off for this run)`),{exitCode:2});}
 return path;
}

// Merge start/end lines into nodes {id,parentId,kind,name,start,end,ts,endTs,children}.
export function buildTree(lines){
 const nodes=new Map(),order=[];
 for(const line of lines){
  let e;try{e=JSON.parse(line);}catch{continue;}
  if(!e?.id)continue;
  let n=nodes.get(e.id);
  if(!n){n={id:e.id,parentId:e.parentId??null,kind:e.kind,name:e.name,start:{},end:null,ts:e.ts,endTs:null,children:[]};nodes.set(e.id,n);order.push(n);}
  if(e.phase==='end'){n.end=e.fields??{};n.endTs=e.ts;}
  else{n.start=e.fields??{};n.kind=e.kind??n.kind;n.name=e.name??n.name;n.parentId=e.parentId??n.parentId;n.ts=e.ts??n.ts;}
 }
 const roots=[];
 for(const n of order){const p=n.parentId&&nodes.get(n.parentId);if(p)p.children.push(n);else roots.push(n);}
 return {nodes,order,roots};
}
const descendants=n=>n.children.flatMap(c=>[c,...descendants(c)]);

export function exportTraceMarkdown(text,{source='trace.jsonl'}={}){
 const {order,roots}=buildTree(text.split('\n').filter(Boolean));
 const llms=order.filter(n=>n.kind==='llm'),turns=order.filter(n=>n.kind==='crew-turn');
 const paid=order.filter(n=>n.kind==='paid-job'),errors=order.filter(n=>n.end&&(n.end.error||n.end.errorText));
 const tot=llms.reduce((t,n)=>{const e=n.end??{};t.in+=num(e.inputTokens??e.usage_metadata?.input_tokens);t.out+=num(e.outputTokens??e.usage_metadata?.output_tokens);t.reason+=num(e.reasoningTokens??e.usage_metadata?.output_token_details?.reasoning);t.cost+=num(e.costUsd);return t;},{in:0,out:0,reason:0,cost:0});
 const paidCost=paid.reduce((s,n)=>s+num((n.end??n.start).actualCostUsd??(n.end??n.start).estimatedCostUsd),0);
 const sessions=roots.filter(r=>r.kind==='root');
 const out=[];
 out.push(`# Trace export: ${sessions[0]?.start?.runId??source}`,'');
 out.push(`Source: ${source}`);
 if(order.length)out.push(`Span: ${order[0].ts??'?'} → ${order.reduce((m,n)=>(n.endTs??n.ts)>m?(n.endTs??n.ts):m,'')}`);
 out.push(`Commands: ${sessions.map(s=>s.name).join(', ')||'-'}`);
 out.push(`Totals: ${turns.length} agent turns, ${llms.length} model requests, tokens in ${tot.in} / out ${tot.out} / reasoning ${tot.reason}, model cost ${usd(tot.cost)}, ${paid.length} paid jobs ${usd(paidCost)}, ${errors.length} errors`,'');
 let i=0;
 for(const t of turns){
  i++;const s=t.start,e=t.end??{};
  const kids=descendants(t);
  const calls=kids.filter(k=>k.kind==='agent-call'),llm=kids.filter(k=>k.kind==='llm'),tools=kids.filter(k=>k.kind==='tool'),reviews=kids.filter(k=>k.kind==='review'),jobs=kids.filter(k=>k.kind==='paid-job');
  const tIn=llm.reduce((a,n)=>a+num(n.end?.inputTokens),0),tOut=llm.reduce((a,n)=>a+num(n.end?.outputTokens),0),tR=llm.reduce((a,n)=>a+num(n.end?.reasoningTokens),0),tC=llm.reduce((a,n)=>a+num(n.end?.costUsd),0);
  out.push(`## ${i}. ${s.step??'?'} / ${s.gate??'?'} — ${s.label??s.role??'?'} (${s.model??'?'})`,'');
  out.push(`- Task: ${s.taskId??'-'}${s.caseId?` (case ${s.caseId})`:''}, attempt ${s.attempt??'-'}`);
  out.push(`- Outcome: ${e.outcome??'(unfinished)'}${e.reasonCode?` [${e.reasonCode}]`:''}, ${num(e.durationMs)} ms`);
  out.push(`- Tokens: in ${tIn} / out ${tOut} / reasoning ${tR}; cost ${usd(tC)} over ${llm.length} requests`);
  if(e.error)out.push(`- Error: ${clip(e.error,600)}`);
  for(const c of calls){
   const cs=c.start,ce=c.end??{};
   if(Array.isArray(cs.promptSections)&&cs.promptSections.length){
    out.push('','Prompt sections:','','| kind | id | sha256 | chars |','|---|---|---|---|');
    for(const p of cs.promptSections)out.push(`| ${p.kind} | ${p.id} | ${String(p.sha256??'-').slice(0,12)} | ${p.chars??'-'} |`);
   }
   out.push('',`Packet: ${cs.packetChars??'?'} chars, sha256 ${String(cs.packetSha256??'-').slice(0,12)}${cs.attached?.length?`, images ${cs.attached.join(', ')}`:''}`);
   out.push('','<details><summary>System prompt</summary>','','```',clip(cs.system??''),'```','</details>');
   out.push('','<details><summary>Prompt packet</summary>','','```json',clip(cs.packet??''),'```','</details>');
   out.push('','Response:','','```',clip(ce.output??ce.finishedResult??ce.error??'(none)'),'```');
   if(ce.validationRetries)out.push(`Validation retries: ${ce.validationRetries}`);
  }
  if(llm.length){
   out.push('','Model requests:','');
   for(const n of llm){const ne=n.end??{};out.push(`- ${n.name}${n.start?.inputs?.continuation?' (continuation)':''}: ${ne.error?`FAILED ${ne.status??''} ${ne.reasonCode??''} ${clip(ne.error,200)}`:`${ne.finish_reason??'-'}, in ${num(ne.inputTokens)} / out ${num(ne.outputTokens)} / reasoning ${num(ne.reasoningTokens)}, ${usd(ne.costUsd)}`}, ${num(ne.durationMs)} ms`);}
  }
  if(tools.length){
   out.push('','Tool calls:','');
   for(const n of tools){const a=n.start?.args??n.end?.args??{};const ne=n.end??{};out.push(`- ${n.start?.toolName??n.name}(${a.sha256?String(a.sha256).slice(0,12):''}${a.region?` region ${JSON.stringify(a.region)}`:''}) → ${ne.outcome??'?'}, ${num(ne.durationMs)} ms${ne.error?`: ${clip(ne.error,200)}`:''}`);}
  }
  for(const r of reviews){
   const rs=r.start;out.push('',`Review verdict: ${rs.decision??'-'}${rs.selection!=null?`, pick ${rs.selection}`:''}`);
   for(const c of rs.checks??[])out.push(`- ${c.criterion}: ${c.status} — ${clip(c.evidence??'',300)}${c.repair?` (repair: ${clip(c.repair,200)})`:''}`);
  }
  for(const j of jobs){const je=j.end??{};out.push('',`Paid job ${j.start?.provider??''}: ${je.outcome??'-'}, ${usd(je.actualCostUsd??je.estimatedCostUsd)} (${je.actualCostSource??'actual'}), ${num(je.durationMs)} ms${je.error?`: ${clip(je.error,200)}`:''}`);}
  out.push('');
 }
 const loose=paid.filter(j=>!turns.some(t=>descendants(t).includes(j)));
 if(loose.length){out.push('## Paid jobs outside agent turns','');for(const j of loose){const je=j.end??j.start;out.push(`- ${j.start?.provider??'?'} ${j.start?.jobId??''}: ${je.outcome??'-'}, ${usd(je.actualCostUsd??je.estimatedCostUsd)}, ${num(je.durationMs)} ms${je.error?`: ${clip(je.error,200)}`:''}`);}out.push('');}
 if(!turns.length&&!loose.length)out.push('_No agent turns or paid jobs recorded._','');
 return out.join('\n');
}

export async function traceExport({run,out=null}){
 const path=await resolveJournal(run);
 const md=exportTraceMarkdown(await readFile(path,'utf8'),{source:path});
 if(out)await writeFile(out,md);
 return {path,markdown:md};
}
