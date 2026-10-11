import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadStudio,studioFor,imageProviderFor,imageUnitCostFor} from '../runtime/instructions.mjs';

// Existing runs (e.g. a paused rev-4 rehearsal) carry a pinned studio snapshot
// with the legacy Muse-only image config. It must keep parsing unchanged:
// StudioSnapshot re-hashes the parsed config, so parsing may not add defaults.
test('legacy Muse-only studio snapshots still load after the agy image config change',async()=>{
 const kit=new URL('../',import.meta.url),current=loadStudio();
 const dir=await mkdtemp(join(tmpdir(),'memoir-legacy-studio-'));
 try{
  const config=JSON.parse(await readFile(new URL('studio.json',kit),'utf8'));
  config.generation.image={provider:'meta-muse',model:'muse-image-1.0',estimatedUnitCostUsd:.01};
  await writeFile(join(dir,'studio.json'),JSON.stringify(config));
  for(const path of Object.keys(current.documents)){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),current.documents[path].content);}
  if(current.config.craft)await writeFile(join(dir,current.config.craft.path),await readFile(new URL(current.config.craft.path,kit)));
  const legacy=loadStudio(pathToFileURL(dir+'/'));
  const p={studio:JSON.parse(JSON.stringify(legacy))};
  assert.deepEqual(studioFor(p).config.generation.image,{provider:'meta-muse',model:'muse-image-1.0',estimatedUnitCostUsd:.01});
  assert.equal(imageProviderFor(p),'meta-muse');
  assert.equal(imageUnitCostFor(p,'meta-muse'),.01);
  assert.equal(imageUnitCostFor(p,'agy'),0);
  // The current bundle round-trips byte-for-byte too (no parse-time defaults).
  assert.deepEqual(studioFor({studio:JSON.parse(JSON.stringify(current))}),current);
 }finally{await rm(dir,{recursive:true});}
});
