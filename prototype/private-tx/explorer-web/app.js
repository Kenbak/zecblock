import init, { ExplorerPirBrowser } from './pkg/zecblock_pir_browser.js';

const $ = (id) => document.getElementById(id);
const zec = (zat) => zat == null ? '—' : `${(Number(BigInt(zat)) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} ZEC`;
const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const ms = (t) => `${t.toFixed(0)} ms`;

let client;
let tip;

async function bytes(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return { body: new Uint8Array(await res.arrayBuffer()), res };
}

async function setup() {
  const t0 = performance.now();
  await init();
  const manifestText = await (await fetch('/manifest')).text();
  const manifest = JSON.parse(manifestText);
  const [main, overflow] = await Promise.all([bytes('/publics/main'), bytes('/publics/overflow')]);
  client = new ExplorerPirBrowser(manifestText, main.body, overflow.body);
  tip = manifest.snapshotTip;
  $('snapshot').textContent = `Snapshot: ${manifest.records.toLocaleString()} transactions up to block ${tip.toLocaleString()} · ${manifest.main.instances} main + ${manifest.overflow.instances} overflow PIR tables · setup ${ms(performance.now() - t0)} (public parameters ${kb(main.body.length + overflow.body.length)})`;
  $('go').disabled = false;
  // The fragment never reaches the server, unlike a query string.
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('tx');
  if (fromUrl) { $('txid').value = fromUrl; lookup(fromUrl); }
}

async function ask(table, upload, rows) {
  const t = performance.now();
  const { body, res } = await bytes(`/query/${table}`, { method: 'POST', body: upload });
  const server = Number(res.headers.get('x-server-ns') || 0) / 1e6;
  rows.push([`${table} round trip`, ms(performance.now() - t), `server ${ms(server)} (scan ${ms(Number(res.headers.get('x-scan-ns')) / 1e6)}, pack ${ms(Number(res.headers.get('x-pack-ns')) / 1e6)}) · sent ${kb(upload.length)}, received ${kb(body.length)}`]);
  return body;
}

async function lookup(txid) {
  $('go').disabled = true;
  $('result').innerHTML = '<p class="muted">Querying…</p>';
  const rows = [];
  const total = performance.now();
  try {
    let t = performance.now();
    const upload = client.query_main(txid);
    rows.push(['Encrypt row selection', ms(performance.now() - t), 'in this browser']);
    const reply = await ask('main', upload, rows);
    t = performance.now();
    let out = JSON.parse(client.decode_main(reply));
    rows.push(['Decrypt main reply', ms(performance.now() - t), 'in this browser']);
    if (out.needsOverflow) {
      t = performance.now();
      const more = client.query_overflow();
      rows.push([`Encrypt ${out.needsOverflow} overflow row(s)`, ms(performance.now() - t), 'large record: the server can tell an overflow fetch happened']);
      const reply2 = await ask('overflow', more, rows);
      t = performance.now();
      out = JSON.parse(client.decode_overflow(reply2));
      rows.push(['Decrypt overflow reply', ms(performance.now() - t), 'in this browser']);
    }
    rows.push(['Total', ms(performance.now() - total), '']);
    render(out);
    history.replaceState(null, '', `#tx=${encodeURIComponent(txid.trim())}`);
  } catch (error) {
    $('result').innerHTML = `<p class="error">${esc(error.message || error)}</p>`;
  } finally {
    $('timing').hidden = false;
    $('timing-rows').innerHTML = rows.map(([a, b, c]) => `<tr><th>${esc(a)}</th><td class="num">${esc(b)}</td><td class="muted">${esc(c)}</td></tr>`).join('');
    $('go').disabled = false;
  }
}

function render(tx) {
  if (!tx.found) {
    $('result').innerHTML = `<h2 class="absent">Not in this snapshot</h2><p class="mono">${esc(tx.txid)}</p><p class="muted">No confirmed transaction with this ID up to block ${tip.toLocaleString()}. The server cannot tell this lookup from a found one.</p>`;
    return;
  }
  const pools = [tx.isCoinbase && 'Coinbase', tx.hasSprout && 'Sprout', tx.hasSapling && 'Sapling', tx.hasOrchard && 'Orchard', tx.hasIronwood && 'Ironwood'].filter(Boolean);
  const facts = [
    ['Block', tx.blockHeight.toLocaleString()], ['Confirmations at snapshot', (tip - tx.blockHeight + 1).toLocaleString()],
    ['Time', new Date(tx.blockTime * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')],
    ['Fee', zec(tx.feeZat)], ['Total in', zec(tx.totalInputZat)], ['Total out', zec(tx.totalOutputZat)],
    ['Size', tx.size == null ? '—' : `${tx.size.toLocaleString()} bytes`], ['Version', tx.version], ['Position in block', tx.txIndex],
    ['Sapling spends / outputs', `${tx.saplingSpendCount} / ${tx.saplingOutputCount}`], ['Orchard actions', tx.orchardActions],
    ['Sapling value balance', zec(tx.valueBalanceSaplingZat)], ['Orchard value balance', zec(tx.valueBalanceOrchardZat)],
    ['Lock time', tx.locktime], ['Expiry height', tx.expiryHeight],
  ];
  const ins = tx.inputs.map((i) => `<tr><td class="mono">${i.prev_txid ? `${esc(i.prev_txid.slice(0, 16))}…:${i.prev_vout}` : 'coinbase'}</td><td class="mono">${esc(i.address)}</td><td class="num">${zec(i.value)}</td></tr>`).join('');
  const outs = tx.outputs.map((o) => `<tr><td class="num">${o.vout_index}</td><td class="mono">${esc(o.address)}</td><td class="num">${zec(o.value)}</td><td>${o.spent ? 'spent' : 'unspent'}</td></tr>`).join('');
  $('result').innerHTML = `
    <h2 class="found">Found privately</h2>
    <p class="mono">${esc(tx.txid)}</p>
    <p>${pools.map((p) => `<span class="badge">${p}</span>`).join('') || '<span class="badge">Transparent</span>'}</p>
    <div class="grid">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <p class="muted mono">Block hash ${esc(tx.blockHash)}</p>
    <div class="io">
      <div><h2>Transparent inputs (${tx.inputCount})</h2>${ins ? `<table><thead><tr><th>Previous output</th><th>Address</th><th>Value</th></tr></thead><tbody>${ins}</tbody></table>` : '<p class="muted">None</p>'}</div>
      <div><h2>Transparent outputs (${tx.outputCount})</h2>${outs ? `<table><thead><tr><th>#</th><th>Address</th><th>Value</th><th>State</th></tr></thead><tbody>${outs}</tbody></table>` : '<p class="muted">None</p>'}</div>
    </div>`;
}

$('form').addEventListener('submit', (event) => { event.preventDefault(); lookup($('txid').value); });
setup().catch((error) => { $('snapshot').innerHTML = `<span class="error">Setup failed: ${esc(error.message || error)}</span>`; });
