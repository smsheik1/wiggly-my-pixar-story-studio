// Identity traits from intake: things a person always wears or that are always part of how
// they look (a hijab, a turban, glasses, a birthmark). The human answers once per person;
// Cleo copies the answers into the roster entry's mustKeep, Pia writes every trait into the
// prompt, and Vera fails `likeness` on any image that drops one. Nothing here assumes a trait:
// the religion answer only shapes which example questions are offered.
export const RELIGION_QUESTION={id:'religiousHousehold',once:'story',optional:true,prompt:'Did you grow up in a religious household, and which religion?'};
export const PERSON_FOLLOW_UP={id:'mustKeep',once:'person',optional:true,prompt:"Anything they always wear or that's always part of how they look?"};
const SUGGESTIONS=[
 {match:/\b(muslim|islam(ic)?)\b/i,female:['Did she wear a hijab?'],male:['Did he wear a kufi or prayer cap?'],any:['Did they wear a hijab or a prayer cap?']},
 {match:/\bsikh(ism)?\b/i,female:['Did she wear a turban or a chunni?'],male:['Did he wear a turban (dastar)?'],any:['Did they wear a turban?']},
 {match:/\b(jewish|judaism|orthodox jew)\b/i,female:['Did she wear a head covering (tichel or snood)?'],male:['Did he wear a kippah?'],any:['Did they wear a kippah or head covering?']},
 {match:/\bhindu(ism)?\b/i,female:['Did she wear a bindi?'],male:['Did he wear a tilak?'],any:['Did they wear a bindi or tilak?']},
 {match:/\b(christian|catholic|orthodox)\b/i,any:['Did they always wear a cross or medal?']},
];
const genderOf=g=>/^(f|female|woman|girl)$/i.test(String(g??''))?'female':/^(m|male|man|boy)$/i.test(String(g??''))?'male':'any';
// Follow-up for one person. Suggestions are questions to ask, never answers: mustKeep stays
// empty until the human says yes.
export function identityFollowUp({religion=null,person={}}={}){
 const g=genderOf(person.gender);
 const suggestions=religion?SUGGESTIONS.filter(s=>s.match.test(religion)).flatMap(s=>s[g]??s.any??[]):[];
 return {id:PERSON_FOLLOW_UP.id,personId:person.id??null,name:person.name??null,prompt:PERSON_FOLLOW_UP.prompt,suggestions:[...new Set(suggestions)],assumed:[]};
}
export const mustKeepOf=c=>Array.isArray(c?.mustKeep)?c.mustKeep.filter(t=>typeof t==='string'&&t.trim()):[];
const norm=s=>String(s??'').toLowerCase().replace(/\s+/g,' ').trim();
export const missingTraits=(traits,text)=>traits.filter(t=>!norm(text).includes(norm(t)));
// Roster approval: every confirmed intake trait is copied onto the roster entry.
export function assertMustKeepCopied(intakeCharacters,rosterCharacters){
 const missing=intakeCharacters.flatMap(i=>{const r=rosterCharacters.find(c=>c.id===i.id);const have=new Set(mustKeepOf(r).map(norm));return mustKeepOf(i).filter(t=>!have.has(norm(t))).map(t=>`${i.name} (${i.id}): "${t}"`);});
 if(missing.length)throw new Error(`MUST_KEEP_NOT_COPIED: copy every intake identity trait into the roster entry's mustKeep: ${missing.join('; ')}.`);
}
// Sheet and keyframe prompts: every trait appears in the prompt text.
export function assertPromptKeepsTraits(prompt,characters){
 const missing=characters.flatMap(c=>missingTraits(mustKeepOf(c),prompt).map(t=>`${c.name??c.id}: "${t}"`));
 if(missing.length)throw new Error(`MUST_KEEP_MISSING_FROM_PROMPT: write every mustKeep identity trait into the prompt: ${missing.join('; ')}.`);
}
// Vera on a sheet: a passing likeness check must say it saw every trait; otherwise fail likeness.
export function assertReviewChecksTraits(review,castEntry){
 const traits=mustKeepOf(castEntry);
 if(!traits.length||!['approved','provisional'].includes(review?.decision))return;
 const likeness=(review.checks??[]).find(c=>c.criterion==='likeness');
 const missing=missingTraits(traits,`${likeness?.evidence??''} ${likeness?.finding??''}`);
 if(!likeness||likeness.status!=='pass'||missing.length)throw new Error(`MUST_KEEP_UNCHECKED: likeness must confirm every mustKeep trait is shown in the chosen option (${(missing.length?missing:traits).map(t=>`"${t}"`).join(', ')}). If an option drops one, fail \`likeness\` for it.`);
}
// What the producer asks at a gate: the story question once (answers or script gate, until
// answered), then one follow-up per roster person at the roster gate.
export function identityQuestionsFor(project,artifact){
 const religion=project?.inputs?.religiousHousehold??null;
 const out=[];
 if(['answers','script'].includes(artifact?.kind)&&religion==null)out.push({...RELIGION_QUESTION});
 if(artifact?.kind==='roster')for(const c of artifact.content?.characters??[])out.push(identityFollowUp({religion,person:{id:c.id,name:c.name,gender:c.gender}}));
 return out;
}
