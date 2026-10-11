import {workerBackend} from './crew.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from './contracts.mjs';

// Small router dispatching per worker by its bound backend, so Sol agents
// keep going through CodexHost unchanged and DeepSeek agents go through
// OpenRouter. runCrewTask/driveCrew use only runTask/preflight/tools.
export class CrewHost {
 constructor({codex=null, openrouter=null, config=null}={}){
  this.codex=codex;this.openrouter=openrouter;this.config=config;
 }
 backendFor(worker){
  return workerBackend(worker,this.config);
 }
 hostFor(worker){
  const backend=this.backendFor(worker);
  const host=backend==='openrouter'?this.openrouter:this.codex;
  if(!host)throw new Error(backend==='openrouter'?'OPENROUTER_HOST_MISSING: no openrouter worker host is bound for this command.':'CODEX_HOST_MISSING: no codex worker host is bound for this command.');
  return host;
 }
 get tools(){
  return this.codex?.tools??this.openrouter?.tools??{};
 }
 get tracer(){
  return this.codex?.tracer??this.openrouter?.tracer??null;
 }
 async preflight(worker){
  return this.hostFor(worker).preflight(worker);
 }
 async runTask(task,{worker,callTool}){
  return this.hostFor(worker).runTask(task,{worker,callTool});
 }
 // Which backends a runner command must start. crew-start/crew-refresh bind to the
 // configured backends only (a still-bound codex worker whose role now points at
 // openrouter is rebound there, so it never needs Codex). Dispatch commands also
 // honour workers still bound to codex.
 static backendsNeeded(command,config,boundWorkers=[]){
  const configured=new Set(Object.values(config?.agents??{}).map(a=>a.backend??'codex'));
  const bound=new Set((boundWorkers??[]).map(w=>w.backend??'codex'));
  const bindOnly=['crew-start','crew-refresh'].includes(command);
  return {codex:configured.has('codex')||(!bindOnly&&bound.has('codex')),openrouter:configured.has('openrouter')||(!bindOnly&&bound.has('openrouter'))};
 }
 needsCodex(roles){
  return roles.some(role=>((this.config?.agents?.[role]?.backend)??'codex')==='codex');
 }
 // Mixed-backend start: codex roles via CodexHost thread/start, openrouter
 // roles via a per-model connectivity check. Each backend keeps its own partial-
 // start file (crew-startup.json / crew-startup-openrouter.json), so a
 // partial start recovers per backend without repeating certain workers.
 async startCrew(model,config){
  const cfg=config??this.config;
  const codexRoles=Object.entries(cfg.agents).filter(([,a])=>(a.backend??'codex')==='codex').map(([r])=>r);
  const openRoles=Object.entries(cfg.agents).filter(([,a])=>(a.backend??'codex')==='openrouter').map(([r])=>r);
  const workers=[];
  if(codexRoles.length){
   if(!this.codex)throw new Error('CODEX_HOST_MISSING: codex-bound roles need a codex host.');
   const codexConfig={...cfg,agents:Object.fromEntries(codexRoles.map(r=>[r,cfg.agents[r]]))};
   const started=await this.codex.startCrew(model,codexConfig);
   for(const w of started.workers)workers.push({...w,backend:'codex'});
  }
  if(openRoles.length){
   if(!this.openrouter)throw new Error('OPENROUTER_HOST_MISSING: openrouter-bound roles need an openrouter host.');
   const openConfig={...cfg,agents:Object.fromEntries(openRoles.map(r=>[r,cfg.agents[r]]))};
   const started=await this.openrouter.startCrew(model,openConfig);
   for(const w of started.workers)workers.push({...w,backend:'openrouter'});
  }
  workers.sort((a,b)=>Object.keys(cfg.agents).indexOf(a.role)-Object.keys(cfg.agents).indexOf(b.role));
  return {workers};
 }
 // Refresh keeps unchanged workers' IDs and explicitly rebinds roles whose
 // configured model/backend differs, returning {workers, changed:[roles]}.
 async refreshCrew(crew,config){
  const cfg=config??this.config;
  const changed=[],workers=[];
  const codexKept=[],openKept=[];
  for(const worker of crew.workers){
   const configured=cfg?.agents?.[worker.role];
   const wantBackend=(configured?.backend)??worker.backend??'codex';
   const wantModel=configured?.model??worker.modelVersion;
   if(worker.backend!==undefined&&worker.backend!==wantBackend||worker.modelVersion!==wantModel){
    changed.push(worker.role);
    continue;
   }
   (wantBackend==='openrouter'?openKept:codexKept).push(worker.role);
   workers.push(worker);
  }
  const refreshed=[];
  if(codexKept.length){
   if(!this.codex)throw new Error('CODEX_HOST_MISSING: codex-bound roles need a codex host.');
   const out=await this.codex.refreshCrew({workers:crew.workers.filter(w=>codexKept.includes(w.role))});
   for(const w of out.workers)refreshed.push({...w,backend:'codex'});
  }
  if(openKept.length){
   if(!this.openrouter)throw new Error('OPENROUTER_HOST_MISSING: openrouter-bound roles need an openrouter host.');
   const out=await this.openrouter.refreshCrew({workers:crew.workers.filter(w=>openKept.includes(w.role))});
   for(const w of out.workers)refreshed.push({...w,backend:'openrouter'});
  }
  for(const role of changed){
   const configured=cfg.agents[role];
   const wantBackend=configured.backend??'codex';
   if(wantBackend==='openrouter'){
    if(!this.openrouter)throw new Error('OPENROUTER_HOST_MISSING: openrouter-bound roles need an openrouter host.');
    const fresh=await this.openrouter.startRole(role,configured);
    refreshed.push(fresh);workers.push(fresh);
   }else{
    if(!this.codex)throw new Error('CODEX_HOST_MISSING: codex-bound roles need a codex host.');
    const fresh=await this.codex.startRole(role,configured);
    refreshed.push({...fresh,backend:'codex'});workers.push({...fresh,backend:'codex'});
   }
  }
  refreshed.sort((a,b)=>Object.keys(cfg.agents).indexOf(a.role)-Object.keys(cfg.agents).indexOf(b.role));
  return {workers:refreshed,changed};
 }
 close(){
  try{this.codex?.close();}catch{}
  try{this.openrouter?.close();}catch{}
 }
}

// Not-dispatched recovery for an OpenRouter worker: it keeps no server
// thread, so there is no native turn to inspect. Only a started receipt
// with no turn reference at all may be marked not-dispatched; anything
// referencing a turn stays refused.
export async function reconcileRouterNotDispatched(task,{receiptDirectory,message}){
 const path=join(receiptDirectory,task.taskId+'.json');
 let receipt;try{receipt=JSON.parse(await readFile(path,'utf8'));}catch(e){throw new Error('DISPATCH_RECONCILIATION_DENIED: no started receipt to reconcile.');}
 if(typeof message!=='string'||!message.trim()||receipt?.status!=='started'||receipt.taskId!==task.taskId||digest({...receipt.worker,backend:receipt.worker.backend??'codex',capabilityVersion:null})!==digest({...task.crewWorker,backend:task.crewWorker.backend??'codex',capabilityVersion:null}))throw new Error('DISPATCH_RECONCILIATION_DENIED: current started receipt, exact worker and human direction required.');
 if(receipt.turnId!=null||receipt.turn!=null||receipt.event!=null||receipt.reconciliation!=null)throw new Error('DISPATCH_RECONCILIATION_DENIED: receipt records a turn reference; no retry permitted.');
 const archive=path+`.not-dispatched-${receipt.attempt}.json`;
 try{await writeFile(archive,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 const reconciled={...receipt,status:'not-dispatched',reconciliation:{outcome:'confirmed-not-dispatched',message,at:new Date().toISOString()}};
 await writeFile(path,JSON.stringify(reconciled)+'\n',{mode:0o600});
 return reconciled;
}
