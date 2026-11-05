/**
 * Zebra gRPC Indexer Client
 *
 * Connects to Zebra's gRPC indexer service for real-time streaming of:
 * - Mempool changes (tx added, invalidated, mined)
 * - Chain tip changes (new blocks)
 *
 * Requires Zebra compiled with --features indexer and
 * indexer_listen_addr set in zebrad.toml.
 *
 * The mempool and chain-tip streams are supervised independently by two
 * StreamSupervisor instances sharing one underlying gRPC client/channel.
 * Each stream reconnects with its own exponential backoff + jitter and its
 * own staleness watchdog, so a dead chain-tip stream (which previously had
 * no reconnect logic at all — only the mempool stream's error handler ever
 * triggered a reconnect) can no longer silently stop delivering new blocks
 * while `connected` stays true because the mempool stream happens to be
 * fine, or vice versa.
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { logSafeError } = require('./lib/safe-log');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'indexer.proto');

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 30000;

// How long a stream can go without a data event, while still claiming to
// be "connected", before we treat it as silently hung and force a
// reconnect. Mempool activity can legitimately go quiet for a while, so it
// gets a more generous bound than chain-tip (Zcash targets a block every 75s
// before NU7 and 25s after; 5 minutes is a wide margin for natural variance while
// still catching a truly stuck stream). A false-positive reconnect here is
// cheap (resubscribe), so these bounds are intentionally conservative
// rather than tight.
const MEMPOOL_STALE_AFTER_MS = 10 * 60_000;
const CHAIN_TIP_STALE_AFTER_MS = 5 * 60_000;

/**
 * Supervises a single server-streaming gRPC call: opens it, tracks
 * connected/last-activity state, and reconnects independently of any other
 * stream on the same client with exponential backoff + jitter. Also runs a
 * staleness watchdog that forces a reconnect if the stream claims to be
 * connected but has not delivered any data for `staleAfterMs`.
 *
 * All timing primitives are injectable so tests can drive reconnect/
 * backoff/staleness behavior deterministically without real timers.
 */
class StreamSupervisor {
  constructor({
    name,
    openStream,
    onData,
    onConnectionChange,
    onLog = () => {},
    initialReconnectDelayMs = RECONNECT_DELAY_MS,
    maxReconnectDelayMs = MAX_RECONNECT_DELAY_MS,
    staleAfterMs,
    staleCheckIntervalMs = STALE_CHECK_INTERVAL_MS,
    now = () => Date.now(),
    random = () => Math.random(),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (timer) => clearTimeout(timer),
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (timer) => clearInterval(timer),
  }) {
    if (!name) throw new TypeError('StreamSupervisor requires a name');
    if (typeof openStream !== 'function') throw new TypeError('openStream is required');
    if (typeof onData !== 'function') throw new TypeError('onData is required');
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new RangeError('staleAfterMs must be a positive number');
    }

    this.name = name;
    this.openStream = openStream;
    this.onData = onData;
    this.onConnectionChange = onConnectionChange || (() => {});
    this.onLog = onLog;
    this.initialReconnectDelayMs = initialReconnectDelayMs;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
    this.staleAfterMs = staleAfterMs;
    this.staleCheckIntervalMs = staleCheckIntervalMs;
    this.now = now;
    this.random = random;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.stream = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectDelay = initialReconnectDelayMs;
    this.lastActivityAt = 0;
    this.staleTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
    if (!this.staleTimer) {
      this.staleTimer = this.setIntervalFn(() => this._checkStale(), this.staleCheckIntervalMs);
      if (typeof this.staleTimer?.unref === 'function') this.staleTimer.unref();
    }
  }

  stop() {
    this.stopped = true;
    if (this.staleTimer) {
      this.clearIntervalFn(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._closeStream();
    if (this.connected) {
      this.connected = false;
      this.onConnectionChange(false);
    }
  }

  _connect() {
    if (this.stopped || this.stream) return;

    let stream;
    try {
      stream = this.openStream();
    } catch (err) {
      this.onLog('error', `Failed to open stream: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.stream = stream;
    this.lastActivityAt = this.now();

    stream.on('data', (msg) => {
      if (this.stopped || this.stream !== stream) return;
      this.lastActivityAt = this.now();
      if (!this.connected) {
        this.connected = true;
        this.reconnectDelay = this.initialReconnectDelayMs;
        this.onConnectionChange(true);
        this.onLog('info', 'connected');
      }
      this.onData(msg);
    });

    stream.on('error', (err) => {
      if (this.stopped || this.stream !== stream) return;
      if (err.code === grpc.status.CANCELLED) return;
      this.onLog('error', `stream error: ${err.message}`);
      this._handleDisconnect();
    });

    stream.on('end', () => {
      if (this.stopped || this.stream !== stream) return;
      this.onLog('warn', 'stream ended');
      this._handleDisconnect();
    });
  }

  _closeStream() {
    if (this.stream) {
      const stream = this.stream;
      this.stream = null; // Ignore synchronous cancellation and late terminal events.
      try {
        stream.cancel();
      } catch {
        // Already closed/cancelled — nothing to do.
      }
      this.stream = null;
    }
  }

  _handleDisconnect() {
    if (this.stopped) return;
    if (this.connected) {
      this.connected = false;
      this.onConnectionChange(false);
    }
    this._closeStream();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    // Half-jitter: 50%-100% of the current backoff step. Keeps the delay
    // bounded below by something reasonable while avoiding synchronized
    // reconnect storms if the mempool and chain-tip streams (or, in a
    // multi-instance future, multiple API processes) fail at the same
    // moment — e.g. Zebra restarting.
    const jitterFactor = 0.5 + this.random() * 0.5;
    const delay = Math.round(this.reconnectDelay * jitterFactor);
    this.onLog('info', `reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
  }

  _checkStale() {
    if (this.stopped || !this.connected) return;
    const idleMs = this.now() - this.lastActivityAt;
    if (idleMs <= this.staleAfterMs) return;
    this.onLog('warn', `stream stale (${Math.round(idleMs / 1000)}s idle) — forcing reconnect`);
    this.connected = false;
    this.onConnectionChange(false);
    this._closeStream();
    this.reconnectDelay = this.initialReconnectDelayMs;
    this._connect();
  }
}

class ZebraGrpcClient {
  constructor(grpcUrl, { onMempoolChange, onChainTipChange, onConnectionChange } = {}) {
    this.grpcUrl = grpcUrl;
    this.onMempoolChange = onMempoolChange;
    this.onChainTipChange = onChainTipChange;
    this.onConnectionChange = onConnectionChange || (() => {});
    this.client = null;
    this.stopped = false;
    this.mempoolSupervisor = null;
    this.chainTipSupervisor = null;
    this._clientInitTimer = null;
  }

  start() {
    if (!this.grpcUrl) {
      console.log('⏭️  [GRPC] ZEBRA_GRPC_URL not set — gRPC streaming disabled, falling back to polling');
      return;
    }

    this.stopped = false;
    console.log(`🔗 [GRPC] Connecting to Zebra indexer at ${this.grpcUrl}...`);
    this._initClientAndSupervisors();
  }

  stop() {
    this.stopped = true;
    if (this._clientInitTimer) {
      clearTimeout(this._clientInitTimer);
      this._clientInitTimer = null;
    }
    this.mempoolSupervisor?.stop();
    this.chainTipSupervisor?.stop();
    if (this.client) {
      grpc.closeClient(this.client);
      this.client = null;
    }
  }

  /** Combined connectivity — true only if BOTH streams are connected. */
  isConnected() {
    return Boolean(this.mempoolSupervisor?.connected && this.chainTipSupervisor?.connected);
  }

  /** Per-stream connectivity, for callers that need to react to one stream independently of the other. */
  getStatus() {
    return {
      mempool: Boolean(this.mempoolSupervisor?.connected),
      chainTip: Boolean(this.chainTipSupervisor?.connected),
    };
  }

  _initClientAndSupervisors() {
    if (this.stopped) return;
    try {
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = grpc.loadPackageDefinition(packageDefinition);
      const IndexerService = proto.zebra.indexer.rpc.Indexer;

      // Keepalive pings let the underlying channel detect a dead peer at
      // the transport level (surfacing a stream 'error' promptly) instead
      // of relying solely on the staleness watchdog's polling interval.
      this.client = new IndexerService(this.grpcUrl, grpc.credentials.createInsecure(), {
        'grpc.keepalive_time_ms': 30_000,
        'grpc.keepalive_timeout_ms': 10_000,
        'grpc.keepalive_permit_without_calls': 1,
      });
    } catch (err) {
      logSafeError('[GRPC] Failed to initialize client:', err);
      this._clientInitTimer = setTimeout(() => this._initClientAndSupervisors(), RECONNECT_DELAY_MS);
      return;
    }

    this._reportConnectionChange = () => {
      this.onConnectionChange(this.isConnected(), this.getStatus());
    };

    this.mempoolSupervisor = new StreamSupervisor({
      name: 'mempool',
      openStream: () => this.client.MempoolChange({}),
      onData: (msg) => {
        const txHash = Buffer.from(msg.txHash).toString('hex');
        this.onMempoolChange({ type: msg.changeType, txid: txHash });
      },
      onConnectionChange: () => this._reportConnectionChange(),
      onLog: (level, message) => this._log(level, 'mempool', message),
      staleAfterMs: MEMPOOL_STALE_AFTER_MS,
    });

    this.chainTipSupervisor = new StreamSupervisor({
      name: 'chain-tip',
      openStream: () => this.client.ChainTipChange({}),
      onData: (msg) => {
        const blockHash = Buffer.from(msg.hash).toString('hex');
        console.log(`📦 [GRPC] New block: ${msg.height} (${blockHash.slice(0, 16)}...)`);
        this.onChainTipChange({ height: msg.height, hash: blockHash });
      },
      onConnectionChange: () => this._reportConnectionChange(),
      onLog: (level, message) => this._log(level, 'chain-tip', message),
      staleAfterMs: CHAIN_TIP_STALE_AFTER_MS,
    });

    this.mempoolSupervisor.start();
    this.chainTipSupervisor.start();
  }

  _log(level, streamName, message) {
    const prefix = `[GRPC:${streamName}]`;
    if (level === 'error') console.error(`⚠️  ${prefix} ${message}`);
    else if (level === 'warn') console.warn(`⚠️  ${prefix} ${message}`);
    else console.log(`🔄 ${prefix} ${message}`);
  }
}

module.exports = { ZebraGrpcClient, StreamSupervisor };
