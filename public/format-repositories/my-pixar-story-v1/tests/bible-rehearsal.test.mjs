import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBibleEvent} from '../runtime/bible.mjs';
const ev=(action,extra={})=>({taskId:'t',actor:'human',action,message:'Shaz in chat 4:51 AM CT: approved',...extra});
test('bible-policy switches an existing run to advisory rehearsal',()=>{
  const p={bible:{policy:'required',versions:[]}};
  applyBibleEvent(p,ev('bible-policy',{content:{policy:'advisory',rehearsal:true}}));
  assert.deepEqual(p.bible,{policy:'advisory',rehearsal:true,versions:[]});
});
test('bible-approve via chat is refused on a required (production) policy',()=>{
  const p={bible:{policy:'required',versions:[{version:1,hash:'h',state:'draft'}]}};
  assert.throws(()=>applyBibleEvent(p,ev('bible-approve',{artifactDigest:'h',content:{by:'Shaz'}})),/CHAT_APPROVAL_NOT_ALLOWED/);
});
test('rehearsal runs never redraft after signing',()=>{
  const p={bible:{policy:'advisory',rehearsal:true,versions:[{version:1,hash:'h',state:'signed',signature:{by:'Shaz',message:'m',at:'x'}}]}};
  assert.throws(()=>applyBibleEvent(p,ev('bible-draft')),/BIBLE_FROZEN_IN_REHEARSAL/);
});
test('agents can never use the new bible actions',()=>{
  assert.throws(()=>applyBibleEvent({bible:{policy:'advisory',rehearsal:true,versions:[]}},{...ev('bible-policy',{content:{policy:'advisory'}}),actor:'agent'}),/human authority/);
});
