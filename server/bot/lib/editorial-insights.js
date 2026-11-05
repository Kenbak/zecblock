'use strict';

const { addDays, day } = require('../../lib/transaction-activity');
const { candidate } = require('./editorial-policy');
const { HISTORY_DAYS, readInsightSource } = require('./editorial-insight-source');
const f = require('./editorial-format');

const ZAT = 100000000n;
const MIN_NET = 1000n*ZAT;
const abs = n => n<0n ? -n : n;
const sign = n => n<0n ? -1 : n>0n ? 1 : 0;
const amount = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const sum = (rows,key) => rows.reduce((n,r) => n+BigInt(r[key]),0n);
const net = rows => sum(rows,'shieldZat')-sum(rows,'deshieldZat');

// Preserve exact zatoshis in evidence and truncate only the displayed cents.
function zec(value) {
  const cents = abs(value)/1000000n;
  const whole = (cents/100n).toLocaleString('en-US'), part = cents%100n;
  return part ? `${whole}.${part.toString().padStart(2,'0')}` : whole;
}
function changePct(current,previous) {
  if (previous<=0n) return null;
  return Number((current-previous)*1000n/previous)/10;
}
const deltaText = n => n === null ? 'prior week unavailable' : `${f.signedPct(n)} vs prior week`;

function validDays(source,target) {
  day(target);
  const days = source?.days;
  if (source?.network !== 'mainnet' || !Array.isArray(days) || days.length !== HISTORY_DAYS) return null;
  if (days.some((r,i) => r.date !== addDays(target,i-HISTORY_DAYS+1) || r.complete !== true
    || !Number.isSafeInteger(r.totalTransactions) || r.totalTransactions<0
    || !Number.isSafeInteger(r.shieldedTransactions) || r.shieldedTransactions<0
    || r.shieldedTransactions>r.totalTransactions)) return null;
  return days;
}

function weeklyBriefing(source,target) {
  const days = validDays(source,target);
  if (!days) return null;
  // A failed Monday read can recover the same complete week on a later day.
  // The newest completed Sunday is at most six days before the source target.
  const offset = new Date(`${target}T00:00:00Z`).getUTCDay();
  const reportTarget = addDays(target,-offset), end = days.length-offset;
  const current = days.slice(end-7,end), prior = days.slice(end-14,end-7);
  if ([...current,...prior].some(r => amount(r.feesZat) === null)) return null;
  const totals = rows => ({ transactions:sum(rows,'totalTransactions'), shielded:sum(rows,'shieldedTransactions'), fees:sum(rows,'feesZat') });
  const a = totals(current), b = totals(prior);
  if (a.transactions === 0n || b.transactions === 0n) return null;
  const share = Number(a.shielded*1000n/a.transactions)/10, previousShare = Number(b.shielded*1000n/b.transactions)/10;
  // Derive the change from the exact fractions, not the two displayed shares.
  // BigInt division truncates toward zero, conservatively at one decimal point.
  const shareChangeNumerator = (a.shielded*b.transactions-b.shielded*a.transactions)*100n;
  const shareChangeDenominator = a.transactions*b.transactions;
  const shareDelta = Number(shareChangeNumerator*10n/shareChangeDenominator)/10;
  const txChange = changePct(a.transactions,b.transactions), feeChange = changePct(a.fees,b.fees);
  const start = current[0].date, period = { start,endExclusive:addDays(reportTarget,1) };
  const pts = `${shareDelta>=0 ? '+' : '−'}${Math.abs(shareDelta).toFixed(1)} pts`;
  const feesComparison = feeChange === null ? '' : ` (${f.signedPct(feeChange)})`;
  let content = `🟨 This week in Zcash (${f.rangeText(start,reportTarget)} UTC):\n\n`
    + `${a.transactions.toLocaleString('en-US')} transactions (${f.signedPct(txChange)}).\n`
    + `${share.toFixed(1)}% used shielded pools (${pts}).\n`
    + `${zec(a.fees)} ZEC paid in fees${feesComparison}.\n\nCoinbase excluded.\nhttps://zecblock.com/charts`;
  if (content.length>280) content = content.replace(feesComparison,'');
  if (content.length>280) return null;
  const significance = Math.min(85,50+Math.floor(Math.min(Math.abs(txChange),40)/2)+Math.floor(Math.min(Math.abs(shareDelta),15)));
  const card = { kicker:'Network · Weekly briefing', title:'This week in Zcash', hero:a.transactions.toLocaleString('en-US'),
    line:'transactions over seven complete days.', qualifier:'Transaction counts exclude coinbase.', tone:'gold',
    source:'zecblock.com/charts',date:f.rangeText(start,reportTarget), visual:{ kind:'briefing',items:[
      { label:'Transactions',value:a.transactions.toLocaleString('en-US'),detail:deltaText(txChange),tone:'gold' },
      { label:'Shielded share',value:`${share.toFixed(1)}%`,detail:`${pts} vs prior week`,tone:'gold' },
      { label:'Fees paid',value:`${zec(a.fees)} ZEC`,detail:feeChange === null ? 'Prior week: 0 ZEC' : deltaText(feeChange),tone:'gold' },
    ] } };
  return candidate('network_briefing',`analysis:network-briefing:${start}`,content,{
    ...source,target:reportTarget,period,previousPeriod:{start:prior[0].date,endExclusive:start},
    totals:{transactions:a.transactions.toString(),shieldedTransactions:a.shielded.toString(),feesZat:a.fees.toString()},
    previousTotals:{transactions:b.transactions.toString(),shieldedTransactions:b.shielded.toString(),feesZat:b.fees.toString()},
    stats:{changePct:txChange,shieldedShare:share,previousShieldedShare:previousShare,shareChangePoints:shareDelta,feesChangePct:feeChange},
    fractions:{shieldedShare:{numerator:a.shielded.toString(),denominator:a.transactions.toString()},
      previousShieldedShare:{numerator:b.shielded.toString(),denominator:b.transactions.toString()},
      shareChangePoints:{numerator:shareChangeNumerator.toString(),denominator:shareChangeDenominator.toString()},
      display:{decimalPlaces:1,rounding:'toward-zero'}},
    editorial:{topic:'network',lens:'weekly_briefing',significance},card,
  },significance);
}

function poolTrend(source,target) {
  const days = validDays(source,target);
  if (!days || days.some(r => r.publicFlowComplete !== true || amount(r.shieldZat) === null || amount(r.deshieldZat) === null)) return null;
  const current = days.slice(-7), prior = days.slice(-14,-7), baseline = days.slice(0,-7);
  const currentNet = net(current), priorNet = net(prior), baselineNet = net(baseline);
  const direction = sign(currentNet), gross = sum(current,'shieldZat')+sum(current,'deshieldZat');
  // Tiny net differences within heavy two-way flow are not standalone stories.
  if (abs(currentNet)<MIN_NET || gross===0n || abs(currentNet)*10n<gross) return null;
  let streak = 0;
  for (let i=days.length-1;i>=0 && sign(net([days[i]]))===direction;i--) streak++;
  let lens, headline, detail, significance, stats = { changePct:null };
  const dir = direction>0 ? 'inflows' : 'outflows', into = direction>0 ? 'in' : 'out';
  const other = direction>0 ? 'out' : 'in';
  const magnitudeChange = changePct(abs(currentNet)*30n,abs(baselineNet)*7n);
  if (sign(priorNet) === -direction && abs(priorNet)>=MIN_NET) {
    lens = 'flow_reversal'; significance = 85;
    headline = `Net public shielding changed direction over the past 7 days.`;
    detail = `${zec(currentNet)} ZEC net ${into}, after ${zec(priorNet)} ZEC net ${other} in the prior 7.`;
  } else if ([7,14,21,30].includes(streak)) {
    lens = 'flow_streak'; significance = Math.min(90,65+streak);
    headline = `Public shielding has logged ${streak} straight days of net ${dir}.`;
    detail = `${zec(currentNet)} ZEC net ${into} over the latest 7 days.`;
    stats.streakDays = streak;
  } else if (sign(baselineNet) === direction && magnitudeChange !== null && Math.abs(magnitudeChange)>=50) {
    lens = 'flow_change'; significance = Math.min(90,65+Math.floor(Math.min(Math.abs(magnitudeChange),100)/4));
    headline = `Net public ${dir} ran ${Math.abs(magnitudeChange).toFixed(1)}% ${magnitudeChange>0 ? 'above' : 'below'} their prior 30-day pace.`;
    detail = `${zec(currentNet)} ZEC net ${into} over 7 days; the prior 30-day pace was ${zec(abs(baselineNet)*7n/30n)} ZEC per week.`;
    stats.changePct = magnitudeChange;
  } else return null;
  const start = current[0].date;
  const content = `🟨 ${headline}\n\n${detail}\n\n${f.rangeText(start,target)} UTC. Sapling/Orchard/Ironwood; Sprout & migrations excluded.\nhttps://zecblock.com/pools#flows`;
  if (content.length>280) return null;
  const card = { kicker:'Pools · Public flow trend',title:headline,hero:`${direction>0 ? '+' : '−'}${zec(currentNet)}`,unit:'ZEC',
    tone:direction>0 ? 'in' : 'out',line:`net public ${dir} over seven complete days.`,
    qualifier:'Sapling / Orchard / Ironwood. Sprout & migrations excluded.',source:'zecblock.com/pools#flows',date:f.rangeText(start,target),
    visual:{kind:'series',values:days.map(r => Number(net([r]))/1e8),unit:'ZEC',label:'Net public shielding / day',
      start:days[0].date,end:target,reference:Number(baselineNet)/30/1e8,referenceLabel:'Prior 30-day daily average',allowNegative:true} };
  return candidate('pool_trend',`analysis:pool-trend:${lens}:${target}`,content,{
    ...source,target,period:{start,endExclusive:addDays(target,1)},
    previousPeriod:{start:prior[0].date,endExclusive:start},baselinePeriod:{start:baseline[0].date,endExclusive:start},
    totals:{shieldZat:sum(current,'shieldZat').toString(),deshieldZat:sum(current,'deshieldZat').toString(),netZat:currentNet.toString()},
    previousTotals:{netZat:priorNet.toString()},baselineTotals:{netZat:baselineNet.toString(),days:30},
    stats,editorial:{topic:'public_shielding',lens,significance},card,
  },significance);
}

function insightStories(source,target) {
  return [weeklyBriefing(source,target),poolTrend(source,target)].filter(Boolean);
}

async function insightCandidates(pool,now) {
  const source = await readInsightSource(pool,now);
  return insightStories(source,addDays(now.toISOString().slice(0,10),-1));
}

// Synthetic, reproducible gallery inputs. They never read a database or post.
function insightFixtures() {
  const target = '2026-10-25';
  const fixture = fn => ({ network:'mainnet',historyStart:addDays(target,-36),capturedAt:'2026-10-26T08:00:00Z',
    tip:{height:3530000,hash:'f'.repeat(64),timestamp:Date.parse('2026-10-26T07:55:00Z')/1000},
    flowScope:'Synthetic canonical public balance fixtures; migrations excluded.',
    days:Array.from({length:HISTORY_DAYS},(_,i) => ({date:addDays(target,i-36),complete:true,
      totalTransactions:i<30 ? 10000 : 12000,shieldedTransactions:i<30 ? 5000 : 7200,
      feesZat:String((i<30 ? 20n : 25n)*ZAT),publicFlowComplete:true,
      shieldZat:String((i<30 ? 200n : 800n)*ZAT),deshieldZat:String((i<30 ? 400n : 100n)*ZAT),...fn(i)})) });
  const reversal = fixture(() => ({}));
  const streak = fixture(i => ({shieldZat:String((i>=30 ? 800n : i===29 ? 10n : 200n)*ZAT),
    deshieldZat:String((i>=30 ? 100n : i===29 ? 400n : 100n)*ZAT)}));
  const change = fixture(i => ({shieldZat:String((i>=30 ? 1000n : 300n)*ZAT),deshieldZat:String((i===31 ? 1100n : 100n)*ZAT)}));
  return [weeklyBriefing(reversal,target),poolTrend(reversal,target),poolTrend(streak,target),poolTrend(change,target)].filter(Boolean);
}

module.exports = { weeklyBriefing,poolTrend,insightStories,insightCandidates,insightFixtures };
