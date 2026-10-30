'use strict';
// Operator evaluation profiles only. Selecting a candidate here never changes
// ASK_MODEL, production defaults, provider credentials or application budgets.
// Reservation minimums are USD per million tokens. Sol assumes the existing
// hard 48000-byte request limit (+4096 overhead) and Standard global processing.
const profiles=Object.freeze({
 'luna-candidate':Object.freeze({id:'luna-candidate',status:'candidate',provider:'openai',model:'gpt-6-luna',reasoningEffort:'none',minimumInputReservationRate:0.25,minimumOutputReservationRate:0.75,documentation:'https://developers.openai.com/api/docs/models/gpt-6-luna'}),
 'sol-candidate':Object.freeze({id:'sol-candidate',status:'candidate',provider:'openai',model:'gpt-6-sol',reasoningEffort:'none',minimumInputReservationRate:2.5,minimumOutputReservationRate:10,documentation:'https://developers.openai.com/api/docs/models/gpt-6-sol'}),
 // Recommended by the October 30, 2026 model comparison (PR #193): prose at
 // low effort; planning runs at ASK_PLANNING_REASONING_EFFORT=medium.
 'terra-candidate':Object.freeze({id:'terra-candidate',status:'candidate',provider:'openai',model:'gpt-6.1-terra',reasoningEffort:'low',minimumInputReservationRate:1,minimumOutputReservationRate:5,documentation:'https://developers.openai.com/api/docs/models/gpt-6.1-terra'}),
 'mini-observed':Object.freeze({id:'mini-observed',status:'comparison',provider:'openai',model:'gpt-4o-mini',reasoningEffort:null,minimumInputReservationRate:0.25,minimumOutputReservationRate:0.75,documentation:'https://developers.openai.com/api/docs/models/gpt-4o-mini'}),
});
function modelProfile(id){if(!Object.hasOwn(profiles,id))throw Error('Explicit reviewed model profile required');return profiles[id];}
function attestRuntime(value,profile,limit,previous=null){
 if(!value||value.isolated!==true||value.provider!==profile.provider||value.model!==profile.model||(value.reasoningEffort??null)!==profile.reasoningEffort||typeof value.runId!=='string'||!/^\w[\w-]{15,79}$/.test(value.runId)||typeof value.revision!=='string'||!/^[a-f0-9]{7,40}$/.test(value.revision)||typeof value.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceDigest)||!Number.isInteger(value.providerAttemptLimit)||value.providerAttemptLimit<1||value.providerAttemptLimit>limit||!Number.isInteger(value.providerAttempts)||value.providerAttempts<0||value.providerAttempts>value.providerAttemptLimit)throw Error('Runtime attestation required');
 if(previous&&(value.runId!==previous.runId||value.revision!==previous.revision||value.sourceDigest!==previous.sourceDigest||value.providerAttemptLimit!==previous.providerAttemptLimit||value.providerAttempts<previous.providerAttempts))throw Error('Runtime attestation changed');
 return Object.freeze({provider:value.provider,model:value.model,reasoningEffort:value.reasoningEffort??null,runId:value.runId,revision:value.revision,sourceDigest:value.sourceDigest,providerAttemptLimit:value.providerAttemptLimit,providerAttempts:value.providerAttempts});
}
module.exports={profiles,modelProfile,attestRuntime};
