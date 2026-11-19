'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {telegramConfig,sendSignalReport,checkSignalTelegram}=require('../lib/signal-telegram');
const env={TELEGRAM_BOT_TOKEN:'123456:abcdefghijklmnopqrstuvwxy',TELEGRAM_CHAT_ID:'-123'};
test('missing or malformed credentials fail before any network request',async()=>{
 for(const e of [{},{TELEGRAM_BOT_TOKEN:'undefined',TELEGRAM_CHAT_ID:'1'},{TELEGRAM_BOT_TOKEN:env.TELEGRAM_BOT_TOKEN}]) assert.throws(()=>telegramConfig(e));
 let calls=0;await assert.rejects(sendSignalReport('x',{env:{},fetchImpl:async()=>{calls++;}}),/not configured/);assert.equal(calls,0);
});
test('API failure and malformed responses cannot be reported as successful sends',async()=>{
 for(const [ok,status,payload] of [[false,404,{ok:false}],[true,200,{ok:false}],[true,200,{}]])await assert.rejects(sendSignalReport('x',{env,fetchImpl:async()=>({ok,status,json:async()=>payload})}),/rejected/);
 await assert.rejects(sendSignalReport('x',{env,fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw Error('bad json');}})}),/invalid response/);
});
test('transport errors do not leak the token URL',async()=>{
 await assert.rejects(sendSignalReport('x',{env,fetchImpl:async()=>{throw Error(env.TELEGRAM_BOT_TOKEN);}}),error=>!error.message.includes(env.TELEGRAM_BOT_TOKEN)&&error.message.includes('15 seconds'));
});
test('validation only calls getMe/getChat; report is sent once to configured chat',async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push([url.split('/').at(-1),JSON.parse(options.body)]);assert.ok(options.signal);return{ok:true,status:200,json:async()=>({ok:true,result:{}})};};
 await checkSignalTelegram({env,fetchImpl});assert.deepEqual(calls.map(x=>x[0]),['getMe','getChat']);
 await sendSignalReport('hello',{env,fetchImpl});assert.equal(calls[2][0],'sendMessage');assert.equal(calls[2][1].chat_id,'-123');assert.equal(calls[2][1].text,'hello');
 assert.equal(calls[2][1].parse_mode,'Markdown');
 await sendSignalReport('<b>x</b>',{env,fetchImpl,parseMode:'HTML'});assert.equal(calls[3][1].parse_mode,'HTML');
 await sendSignalReport('x_y',{env,fetchImpl,parseMode:null});assert.equal('parse_mode' in calls[4][1],false);assert.equal(calls[4][1].text,'x_y');
});
test('a rejection carries its HTTP status and nothing else from the response',async()=>{
 const fetchImpl=async()=>({ok:false,status:400,json:async()=>({ok:false,description:'Bad Request: can\'t parse entities'})});
 await assert.rejects(sendSignalReport('x',{env,fetchImpl}),error=>error.status===400&&/HTTP 400/.test(error.message)&&!/parse entities/.test(error.message)&&!error.message.includes(env.TELEGRAM_BOT_TOKEN));
});
