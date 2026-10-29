const elements = {
  form: document.querySelector('#lookup-form'),
  input: document.querySelector('#txid'),
  button: document.querySelector('#lookup-button'),
  clear: document.querySelector('#clear-button'),
  runtime: document.querySelector('#runtime-status'),
  status: document.querySelector('#lookup-status'),
  error: document.querySelector('#lookup-error'),
  sampleArea: document.querySelector('#sample-area'),
  samples: document.querySelector('#samples'),
  result: document.querySelector('#result-section'),
  facts: document.querySelector('#result-facts'),
  metrics: document.querySelector('#metrics'),
};
const stages = ['query', 'server', 'decode'];
const worker = new Worker('/worker.js', { type: 'module' });
let ready = false;
let busy = false;
let currentRequest = 0;

function setBusy(value) {
  busy = value;
  elements.input.disabled = value;
  elements.button.disabled = !ready || value;
  elements.button.firstChild.textContent = value ? 'Working privately ' : 'Look up privately ';
  elements.clear.disabled = value;
  for (const button of elements.samples.querySelectorAll('button')) button.disabled = value;
}

function setStages(active = null, complete = false) {
  const activeIndex = stages.indexOf(active);
  for (const [index, stage] of stages.entries()) {
    const state = complete || (activeIndex >= 0 && index < activeIndex)
      ? 'done' : index === activeIndex ? 'active' : '';
    document.querySelector(`#stage-${stage}`).dataset.state = state;
  }
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function hideError() {
  elements.error.textContent = '';
  elements.error.hidden = true;
  elements.input.removeAttribute('aria-invalid');
}

function labelFor(key) {
  const labels = {
    txid: 'Transaction ID', transaction_id: 'Transaction ID', transactionId: 'Transaction ID',
    height: 'Fixture block height', block_height: 'Fixture block height', blockHeight: 'Fixture block height',
    fee_zat: 'Fee (zatoshis)', fee_zats: 'Fee (zatoshis)', fee_zatoshis: 'Fee (zatoshis)', feeZatoshis: 'Fee (zatoshis)',
    expiry_height: 'Expiry height', expiryHeight: 'Expiry height',
    source: 'Transparent funding script', network: 'Network', version: 'Transaction version',
    transparent_inputs: 'Transparent input count', transparent_outputs: 'Transparent output count',
    flags: 'Display flags',
  };
  return labels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
}

function renderResult(result, measurements) {
  elements.facts.replaceChildren();
  for (const [key, value] of Object.entries(result)) {
    const row = document.createElement('div');
    row.className = 'result-fact';
    if (/txid|transaction.?id|source/i.test(key) || (typeof value === 'object' && value !== null)) row.classList.add('wide');
    const term = document.createElement('dt');
    term.textContent = labelFor(key);
    const description = document.createElement('dd');
    description.textContent = value === null ? 'Unavailable in fixture' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    row.append(term, description);
    elements.facts.append(row);
  }
  elements.metrics.replaceChildren();
  const values = [
    ['Encrypted query', `${measurements.queryBytes.toLocaleString()} bytes`],
    ['Encrypted reply', `${measurements.responseBytes.toLocaleString()} bytes`],
    ['Browser encryption', `${Math.round(measurements.encryptMs).toLocaleString()} ms`],
    ['Local request', `${Math.round(measurements.requestMs).toLocaleString()} ms`],
    ['Browser decoding', `${Math.round(measurements.decodeMs).toLocaleString()} ms`],
    ['Total lookup', `${Math.round(measurements.totalMs).toLocaleString()} ms`],
  ];
  for (const [label, value] of values) {
    const item = document.createElement('div');
    const caption = document.createElement('span');
    caption.className = 'metric-label';
    caption.textContent = label;
    const content = document.createElement('span');
    content.className = 'metric-value';
    content.textContent = value;
    item.append(caption, content);
    elements.metrics.append(item);
  }
  elements.result.hidden = false;
}

function renderSamples(samples) {
  elements.samples.replaceChildren();
  for (const [index, sample] of samples.entries()) {
    if (!sample || typeof sample.txid !== 'string' || !/^[a-f\d]{64}$/i.test(sample.txid)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-button';
    button.textContent = typeof sample.label === 'string' ? sample.label : `Fixture ${index + 1}`;
    const identifier = document.createElement('span');
    identifier.className = 'sample-txid';
    identifier.textContent = `${sample.txid.slice(0, 8)}…${sample.txid.slice(-6)}`;
    button.append(identifier);
    button.addEventListener('click', () => {
      hideError();
      elements.input.value = sample.txid;
      elements.input.focus();
    });
    elements.samples.append(button);
  }
  elements.sampleArea.hidden = !elements.samples.childElementCount;
}

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  if (!ready || busy) return;
  hideError();
  const txid = elements.input.value.trim().toLowerCase();
  if (!/^[a-f\d]{64}$/.test(txid)) {
    elements.input.setAttribute('aria-invalid', 'true');
    showError('Enter exactly 64 hexadecimal characters. Validation stays in this browser.');
    return;
  }
  elements.result.hidden = true;
  setBusy(true);
  setStages('query');
  elements.status.textContent = 'Preparing the encrypted query in the browser worker.';
  worker.postMessage({ type: 'lookup', requestId: ++currentRequest, txid });
});

elements.clear.addEventListener('click', () => {
  if (busy) return;
  elements.input.value = '';
  elements.result.hidden = true;
  elements.facts.replaceChildren();
  elements.metrics.replaceChildren();
  hideError();
  setStages();
  elements.status.textContent = 'Ready for a fixture transaction. No ordinary lookup fallback is enabled.';
  elements.input.focus();
});

worker.addEventListener('message', ({ data }) => {
  if (data.type === 'ready') {
    ready = true;
    setBusy(false);
    elements.runtime.dataset.state = 'ready';
    elements.runtime.textContent = 'WASM client ready';
    elements.status.textContent = 'Ready for a fixture transaction. No ordinary lookup fallback is enabled.';
    renderSamples(Array.isArray(data.samples) ? data.samples : []);
    return;
  }
  if (data.requestId !== undefined && data.requestId !== currentRequest) return;
  if (data.type === 'stage') {
    setStages(data.stage);
    elements.status.textContent = data.stage === 'server'
      ? 'Sending the encrypted binary query to the local evaluator.'
      : 'Decoding and checking the result in this browser.';
  } else if (data.type === 'result') {
    setBusy(false);
    setStages(null, true);
    renderResult(data.result, data.measurements);
    elements.status.textContent = 'Lookup complete. The selected transaction ID stayed out of the request path and plaintext body.';
  } else if (data.type === 'error') {
    setBusy(false);
    setStages();
    showError(data.message);
    elements.status.textContent = 'Stopped safely. No ordinary transaction lookup was attempted.';
    if (!ready) {
      elements.runtime.dataset.state = 'error';
      elements.runtime.textContent = 'Client unavailable';
    }
  }
});

worker.addEventListener('error', event => {
  event.preventDefault();
  ready = false;
  setBusy(false);
  setStages();
  elements.runtime.dataset.state = 'error';
  elements.runtime.textContent = 'Client unavailable';
  elements.status.textContent = 'Stopped safely. Reload this local page to restart the worker.';
  showError('The browser worker could not continue. No ordinary transaction lookup was attempted.');
});

worker.postMessage({ type: 'initialize' });
