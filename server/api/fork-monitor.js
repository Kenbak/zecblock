/**
 * Fork Monitor — Multi-node chain tip polling
 *
 * Polls external lightwalletd, RPC and dashboard sources every 60s,
 * compares their chain tips to ours, and logs mismatches to tip_reports.
 * Purely additive — if this module fails, the rest of the system is unaffected.
 */

const POLL_INTERVAL_MS = 60_000;
const GRPC_DEADLINE_MS = 5_000;
const { logSafeError } = require('./lib/safe-log');
const { readNodeSnapshot } = require('./lib/zakura-dashboard');

const MAINNET_NODES = [
  { name: 'Cake Wallet', host: 'zec-node.cakewallet.com', port: 443, tls: true },
  { name: 'zprivacy', host: 'zprivacy.online', port: 443, tls: true },
  { name: 'z0n.jp', host: 'lwd.z0n.jp', port: 443, tls: true },
  { name: 'Stardust EU', host: 'eu.zec.stardust.rest', port: 443, tls: true },
  { name: 'ombie.cash (Zaino)', host: 'z.ombie.cash', port: 443, tls: true },
  { name: 'chmodas', host: 'chmodas.org', port: 443, tls: true },
  { name: 'zec.rocks NA', host: 'na.zec.rocks', port: 443, tls: true },
  { name: 'zec.rocks SA', host: 'sa.zec.rocks', port: 443, tls: true },
  { name: 'zec.rocks EU', host: 'eu.zec.rocks', port: 443, tls: true },
  { name: 'zec.rocks AP', host: 'ap.zec.rocks', port: 443, tls: true },
  // Keep the stored report identity stable when changing the public label.
  { name: 'Zakura europe-west-0 (dashboard)', displayName: 'Zakura europe-west-0', host: '159.65.183.89', port: 8090, dashboard: 'europe-west-0' },
];

const TESTNET_NODES = [
  { name: 'zec.rocks testnet', host: 'testnet.zec.rocks', port: 443, tls: true },
  { name: 'TazMiner LWD', host: 'lwd.tazminer.com', port: 9067, tls: true },
  { name: 'TazMiner RPC', host: 'lwd.tazminer.com', port: 18232, tls: false, rpc: true },
];

const network = (process.env.ZCASH_NETWORK || process.env.NETWORK || 'mainnet').toLowerCase();
const MONITORED_NODES = network === 'testnet' ? TESTNET_NODES : MAINNET_NODES;

class ForkMonitor {
  constructor({ pool, grpc, CompactTxStreamer }) {
    this.pool = pool;
    this.grpc = grpc;
    this.CompactTxStreamer = CompactTxStreamer;
    this.interval = null;
    this.clients = new Map();
    this.nodeStatus = new Map();

    for (const node of MONITORED_NODES) {
      this.nodeStatus.set(node.name, {
        name: node.displayName || node.name,
        host: `${node.host}:${node.port}`,
        nodeImpl: null,
        version: null,
        lightwalletdVersion: null,
        height: null,
        hash: null,
        ourHash: null,
        status: 'pending',
        lastChecked: null,
        error: null,
        forkHeight: null,
        commonAncestor: null,
        ...(node.dashboard ? { source: 'zakura-dashboard', observedAt: null } : {}),
      });
    }
  }

  start() {
    if (!this.CompactTxStreamer) {
      console.error('   [ForkMonitor] CompactTxStreamer not available, skipping');
      return;
    }

    console.log(`   [ForkMonitor] Monitoring ${MONITORED_NODES.length} external nodes`);
    this._createClients();

    setTimeout(() => {
      this._fetchNodeInfo();
      this._poll();
    }, 5_000);
    this.interval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    this._infoInterval = setInterval(() => this._fetchNodeInfo(), 10 * 60_000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this._infoInterval) {
      clearInterval(this._infoInterval);
      this._infoInterval = null;
    }
    for (const [, client] of this.clients) {
      try { client.close(); } catch (_) {}
    }
    this.clients.clear();
  }

  getStatus() {
    return Array.from(this.nodeStatus.values());
  }

  _createClients() {
    for (const node of MONITORED_NODES) {
      if (node.rpc || node.dashboard) continue;
      try {
        const address = `${node.host}:${node.port}`;
        const creds = node.tls
          ? this.grpc.credentials.createSsl()
          : this.grpc.credentials.createInsecure();

        const client = new this.CompactTxStreamer(address, creds, {
          'grpc.keepalive_time_ms': 60_000,
          'grpc.keepalive_timeout_ms': 10_000,
        });

        this.clients.set(node.name, client);
      } catch (err) {
        logSafeError('[ForkMonitor] Failed to create client:', err, { node: node.name });
      }
    }
  }

  async _poll() {
    try {
      const tipResult = await this.pool.query(
        'SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1'
      );
      if (tipResult.rows.length === 0) return;

      const ourTip = {
        height: parseInt(tipResult.rows[0].height),
        hash: tipResult.rows[0].hash,
      };

      const checks = MONITORED_NODES.map(node => this._checkNode(node, ourTip));
      await Promise.allSettled(checks);
    } catch (err) {
      logSafeError('[ForkMonitor] Poll error:', err);
    }
  }

  async _checkNode(node, ourTip) {
    if (node.rpc) return this._checkRpcNode(node, ourTip);

    const client = this.clients.get(node.name);
    if (!client && !node.dashboard) {
      this._updateStatus(node.name, { status: 'offline', error: 'No client' });
      return;
    }

    try {
      const snapshot = node.dashboard ? await readNodeSnapshot(node) : null;
      const response = snapshot || await this._getLatestBlock(client);
      const remoteHeight = snapshot ? snapshot.height : parseInt(response.height);
      const remoteHash = snapshot ? snapshot.hash : this._hashToHex(response.hash);

      let status = 'syncing';
      let ourHashAtRemoteHeight = null;

      if (remoteHeight === ourTip.height) {
        ourHashAtRemoteHeight = ourTip.hash;
        status = remoteHash === ourTip.hash ? 'agree' : 'fork';
      } else if (remoteHeight < ourTip.height) {
        const dbResult = await this.pool.query(
          'SELECT hash FROM blocks WHERE height = $1', [remoteHeight]
        );
        if (dbResult.rows.length > 0) {
          ourHashAtRemoteHeight = dbResult.rows[0].hash;
          status = remoteHash === ourHashAtRemoteHeight ? 'behind' : 'fork';
        } else {
          status = 'behind';
        }
      } else {
        status = 'ahead';
      }

      this._updateStatus(node.name, {
        ...snapshot,
        height: remoteHeight,
        hash: remoteHash,
        ourHash: ourHashAtRemoteHeight,
        status,
        error: null,
        forkHeight: null,
        commonAncestor: null,
      });

      if (status === 'fork') {
        console.warn(`   [ForkMonitor] FORK: ${node.name} at height ${remoteHeight} — ${remoteHash.slice(0, 16)} != ${ourHashAtRemoteHeight?.slice(0, 16)}`);
        await this._recordMismatch(node.name, remoteHeight, remoteHash, ourHashAtRemoteHeight);
        // This dashboard supplies a tip, not arbitrary-height RPC access.
        const ancestor = node.dashboard ? null : await this._findCommonAncestor(client, node, remoteHeight);
        if (ancestor) {
          this._updateStatus(node.name, {
            forkHeight: ancestor.forkHeight,
            commonAncestor: ancestor.commonHeight,
          });
        }
      } else {
        this._updateStatus(node.name, { forkHeight: null, commonAncestor: null });
      }
    } catch (err) {
      this._updateStatus(node.name, { status: 'offline', error: err.message, forkHeight: null, commonAncestor: null });
    }
  }

  async _checkRpcNode(node, ourTip) {
    const http = require('http');
    const url = `http://${node.host}:${node.port}/`;
    const rpcCall = (method, params = []) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: GRPC_DEADLINE_MS }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    try {
      const [countRes, hashRes] = await Promise.all([
        rpcCall('getblockcount'),
        rpcCall('getbestblockhash'),
      ]);
      const remoteHeight = countRes.result;
      const remoteHash = hashRes.result || null;
      if (!remoteHeight) throw new Error('No result');
      let status = 'syncing';
      let ourHashAtRemoteHeight = null;
      if (remoteHeight === ourTip.height) {
        ourHashAtRemoteHeight = ourTip.hash;
        status = remoteHash === ourTip.hash ? 'agree' : 'fork';
      } else if (remoteHeight > ourTip.height) {
        status = 'ahead';
      } else {
        const dbResult = await this.pool.query('SELECT hash FROM blocks WHERE height = $1', [remoteHeight]);
        if (dbResult.rows.length > 0) {
          ourHashAtRemoteHeight = dbResult.rows[0].hash;
          status = remoteHash === ourHashAtRemoteHeight ? 'behind' : 'fork';
        } else {
          status = 'behind';
        }
      }
      this._updateStatus(node.name, { height: remoteHeight, hash: remoteHash, ourHash: ourHashAtRemoteHeight, status, error: null });
      if (status === 'fork') {
        await this._recordMismatch(node.name, remoteHeight, remoteHash, ourHashAtRemoteHeight);
        const ancestor = await this._findCommonAncestorRpc(node, remoteHeight);
        if (ancestor) {
          this._updateStatus(node.name, {
            forkHeight: ancestor.forkHeight,
            commonAncestor: ancestor.commonHeight,
          });
        }
      } else {
        this._updateStatus(node.name, { forkHeight: null, commonAncestor: null });
      }
    } catch (err) {
      this._updateStatus(node.name, { status: 'offline', error: err.message });
    }
  }

  async _fetchNodeInfo() {
    const checks = MONITORED_NODES.map(async (node) => {
      if (node.dashboard) return; // Metadata arrives with the validated tip snapshot.
      if (node.rpc) return this._fetchRpcNodeInfo(node);
      const client = this.clients.get(node.name);
      if (!client) return;
      try {
        const info = await this._getLightdInfo(client);
        const subversion = info.zcashdSubversion || '';
        const match = subversion.match(/\/([\w.-]+):([\d.]+)/);
        const nodeImpl = match ? match[1] : null;
        const nodeVersion = match ? match[2] : null;
        this._updateStatus(node.name, {
          nodeImpl: nodeImpl,
          version: nodeVersion,
          lightwalletdVersion: info.version || null,
        });
      } catch (_) {}
    });
    await Promise.allSettled(checks);
  }

  async _fetchRpcNodeInfo(node) {
    const http = require('http');
    const url = `http://${node.host}:${node.port}/`;
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getinfo', params: [] });
      const result = await new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: GRPC_DEADLINE_MS }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      if (result.result) {
        const subversion = result.result.subversion || '';
        const match = subversion.match(/\/([\w.-]+):([\d.]+)/);
        this._updateStatus(node.name, {
          nodeImpl: match ? match[1] : null,
          version: match ? match[2] : null,
        });
      }
    } catch (_) {}
  }

  _getLightdInfo(client) {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + GRPC_DEADLINE_MS);
      client.getLightdInfo({}, { deadline }, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  _getLatestBlock(client) {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + GRPC_DEADLINE_MS);
      client.getLatestBlock({}, { deadline }, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  _hashToHex(hashBytes) {
    if (!hashBytes || hashBytes.length === 0) return '';
    const buf = Buffer.from(hashBytes);
    return Buffer.from(buf).reverse().toString('hex');
  }

  _updateStatus(name, updates) {
    const current = this.nodeStatus.get(name);
    if (current) {
      Object.assign(current, updates, { lastChecked: new Date().toISOString() });
    }
  }

  async _findCommonAncestor(client, node, forkHeight) {
    try {
      let low = Math.max(1, forkHeight - 1000);
      let high = forkHeight;
      let commonHeight = null;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const dbResult = await this.pool.query('SELECT hash FROM blocks WHERE height = $1', [mid]);
        if (dbResult.rows.length === 0) { high = mid - 1; continue; }

        const ourHash = dbResult.rows[0].hash;
        const remoteHash = await this._getBlockHashAtHeight(client, mid);
        if (!remoteHash) break;

        if (ourHash === remoteHash) {
          commonHeight = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (commonHeight !== null) {
        const depth = forkHeight - commonHeight;
        console.warn(`   [ForkMonitor] ${node.name} fork depth: ${depth} blocks (common ancestor: ${commonHeight})`);
        return { commonHeight, forkHeight: commonHeight + 1 };
      }
    } catch (err) {
      logSafeError('[ForkMonitor] Common ancestor search failed:', err, { node: node.name });
    }
    return null;
  }

  async _findCommonAncestorRpc(node, forkHeight) {
    const http = require('http');
    const url = `http://${node.host}:${node.port}/`;
    const rpcCall = (method, params = []) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: GRPC_DEADLINE_MS }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    try {
      let low = Math.max(1, forkHeight - 1000);
      let high = forkHeight;
      let commonHeight = null;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const dbResult = await this.pool.query('SELECT hash FROM blocks WHERE height = $1', [mid]);
        if (dbResult.rows.length === 0) { high = mid - 1; continue; }

        const ourHash = dbResult.rows[0].hash;
        const res = await rpcCall('getblockhash', [mid]);
        const remoteHash = res.result || null;
        if (!remoteHash) break;

        if (ourHash === remoteHash) {
          commonHeight = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (commonHeight !== null) {
        const depth = forkHeight - commonHeight;
        console.warn(`   [ForkMonitor] ${node.name} fork depth: ${depth} blocks (common ancestor: ${commonHeight})`);
        return { commonHeight, forkHeight: commonHeight + 1 };
      }
    } catch (err) {
      logSafeError('[ForkMonitor] Common ancestor RPC search failed:', err, { node: node.name });
    }
    return null;
  }

  _getBlockHashAtHeight(client, height) {
    return new Promise((resolve) => {
      const deadline = new Date(Date.now() + GRPC_DEADLINE_MS);
      client.getBlock({ height }, { deadline }, (err, response) => {
        if (err || !response || !response.hash) { resolve(null); return; }
        resolve(this._hashToHex(response.hash));
      });
    });
  }

  async _recordMismatch(nodeName, height, remoteHash, ourHash) {
    try {
      await this.pool.query(
        `INSERT INTO tip_reports (height, hash, node_id, ip_hash, is_match)
         VALUES ($1, $2, $3, 'monitor', false)
         ON CONFLICT (height, hash, COALESCE(node_id, '')) DO NOTHING`,
        [height, remoteHash, `monitor:${nodeName}`]
      );
    } catch (err) {
      logSafeError('[ForkMonitor] DB write error:', err);
    }
  }
}

module.exports = { ForkMonitor };
