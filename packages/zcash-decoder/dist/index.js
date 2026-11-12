/**
 * @cipherscan/zcash-decoder
 *
 * Client-side decoder for Zcash shielded transactions and memos.
 *
 * Features:
 * - 100% client-side memo decryption (viewing key never leaves browser)
 * - Orchard/Ironwood compact block filtering
 * - Web Worker compatible for large scans
 * - TypeScript support
 *
 * @example
 * ```typescript
 * import { ZcashWASM } from '@cipherscan/zcash-decoder';
 *
 * // Initialize WASM module
 * const wasm = await ZcashWASM.init();
 *
 * // Decrypt a transaction memo
 * const result = await wasm.decryptMemo(txHex, viewingKey);
 * console.log(result.memo, result.amount);
 *
 * // Filter compact blocks
 * const matches = await wasm.filterCompactBlocks(blocks, viewingKey);
 * ```
 */
export * from './types.js';
/**
 * Main ZcashWASM class for client-side Zcash operations
 */
export class ZcashWASM {
    wasmModule = null;
    constructor() { }
    /**
     * Initialize the WASM module
     * @returns Promise<ZcashWASM> Initialized WASM instance
     *
     * @example
     * ```typescript
     * const wasm = await ZcashWASM.init();
     * ```
     */
    static async init(wasmInput) {
        const instance = new ZcashWASM();
        await instance.loadWASM(wasmInput);
        return instance;
    }
    /**
     * Load the WASM module from the wasm/ directory
     */
    async loadWASM(wasmInput) {
        if (this.wasmModule)
            return;
        try {
            // Dynamically import the WASM module
            const wasmInit = await import('../wasm/zcash_wasm.js');
            // Node cannot fetch file: URLs. Read only our packaged artifact locally.
            if (wasmInput === undefined && typeof process !== 'undefined' && process.versions?.node) {
                const moduleName = 'node:fs/promises';
                const { readFile } = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleName);
                wasmInput = await readFile(new URL('../wasm/zcash_wasm_bg.wasm', import.meta.url));
            }
            await wasmInit.default(wasmInput === undefined ? undefined : {
                module_or_path: wasmInput instanceof Uint8Array ? new Uint8Array(wasmInput) : wasmInput,
            });
            this.wasmModule = {
                decrypt_memo: wasmInit.decrypt_memo,
                batch_filter_compact_outputs: wasmInit.batch_filter_compact_outputs,
                detect_key_type: wasmInit.detect_key_type,
            };
        }
        catch (error) {
            throw new Error(`Failed to load WASM module: ${error}`);
        }
    }
    /**
     * Decrypt a shielded transaction memo
     *
     * @param txHex - Raw transaction hex
     * @param viewingKey - Unified Full Viewing Key (UFVK)
     * @returns Promise<DecryptedOutput> Decrypted memo and amount
     *
     * @example
     * ```typescript
     * const result = await wasm.decryptMemo(
     *   '0400008085202f89...',
     *   'uviewtest1...'
     * );
     * console.log('Memo:', result.memo);
     * console.log('Amount:', result.amount, 'ZEC');
     * ```
     */
    async decryptMemo(txHex, viewingKey) {
        if (!this.wasmModule) {
            throw new Error('WASM module not initialized. Call ZcashWASM.init() first.');
        }
        try {
            if (typeof txHex !== 'string' || txHex.length > 4_000_000 ||
                txHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(txHex)) {
                throw new Error('Transaction must be hexadecimal bytes, at most 2 MB.');
            }
            const resultJson = this.wasmModule.decrypt_memo(txHex, viewingKey);
            return JSON.parse(resultJson);
        }
        catch (error) {
            throw new Error(`Failed to decrypt memo: ${error}`);
        }
    }
    /**
     * Filter compact blocks to find transactions matching the viewing key
     *
     * This is much faster than full decryption as it only checks compact block data.
     * This returns Orchard/Ironwood matches only; it does not scan Sapling outputs.
     * Mixed blocks keep supported matches; Sapling-only input is unsupported.
     *
     * @param compactBlocks - Array of compact blocks from Lightwalletd
     * @param viewingKey - Unified Full Viewing Key (UFVK)
     * @param onProgress - Optional progress callback
     * @returns Promise<MatchingTransaction[]> Transactions matching the viewing key
     *
     * @example
     * ```typescript
     * const matches = await wasm.filterCompactBlocks(
     *   compactBlocks,
     *   'uviewtest1...',
     *   (progress) => {
     *     console.log(`${progress.blocksProcessed}/${progress.totalBlocks}`);
     *   }
     * );
     * console.log(`Found ${matches.length} transactions`);
     * ```
     */
    async filterCompactBlocks(compactBlocks, viewingKey, onProgress) {
        if (!this.wasmModule) {
            throw new Error('WASM module not initialized. Call ZcashWASM.init() first.');
        }
        if (!Array.isArray(compactBlocks))
            throw new Error('Compact blocks must be an array.');
        const totalBlocks = compactBlocks.length;
        const matchingTxs = [];
        const txMap = new Map();
        let outputs = [];
        let supportedOutputs = 0;
        let saplingOutputs = 0;
        const flush = () => {
            if (!outputs.length)
                return;
            const matches = JSON.parse(this.wasmModule.batch_filter_compact_outputs(JSON.stringify(outputs), viewingKey));
            for (const match of matches) {
                const output = outputs[match.index];
                if (!output)
                    throw new Error('WASM returned an invalid output index.');
                if (!txMap.has(output.txid)) {
                    const tx = { txid: output.txid, height: output.height, timestamp: output.timestamp };
                    txMap.set(tx.txid, tx);
                    matchingTxs.push(tx);
                }
            }
            outputs = [];
        };
        const field = (value, bytes) => {
            if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
                throw new Error(`Invalid compact field: expected ${bytes} hexadecimal bytes.`);
            }
            return value;
        };
        for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
            const block = compactBlocks[blockIndex];
            if (!block || typeof block.height !== 'string' || !/^[0-9]+$/.test(block.height) ||
                !Number.isSafeInteger(Number(block.height)) || !Number.isSafeInteger(block.time) || block.time < 0 ||
                !Array.isArray(block.vtx))
                throw new Error('Invalid compact block metadata.');
            for (const tx of block.vtx) {
                if (!tx || typeof tx.hash !== 'string' || tx.hash.length > 128 ||
                    (tx.actions !== undefined && !Array.isArray(tx.actions)) ||
                    (tx.outputs !== undefined && !Array.isArray(tx.outputs)))
                    throw new Error('Invalid compact transaction.');
                // Lightwalletd blocks can contain multiple pools. This API filters only
                // Orchard/Ironwood; never reinterpret Sapling ciphertext as Orchard.
                saplingOutputs += tx.outputs?.length || 0;
                for (const action of tx.actions || []) {
                    if (!action || (action.pool !== undefined && action.pool !== 'orchard' && action.pool !== 'ironwood')) {
                        throw new Error('Invalid compact pool.');
                    }
                    supportedOutputs++;
                    outputs.push({
                        pool: action.pool,
                        nullifier: field(action.nullifier, 32), cmx: field(action.cmx, 32),
                        ephemeral_key: field(action.ephemeralKey, 32), ciphertext: field(action.ciphertext, 52),
                        txid: tx.hash, height: Number(block.height), timestamp: block.time,
                    });
                    if (outputs.length === 4096)
                        flush();
                }
            }
            if ((blockIndex + 1) % 250 === 0 || blockIndex + 1 === totalBlocks) {
                flush();
                onProgress?.({ blocksProcessed: blockIndex + 1, totalBlocks, matchesFound: matchingTxs.length });
            }
        }
        if (supportedOutputs === 0 && saplingOutputs > 0) {
            throw new Error('Sapling compact output filtering is not supported by this decoder.');
        }
        return matchingTxs;
    }
    /**
     * Detect the type of viewing key
     *
     * @param viewingKey - Viewing key to detect
     * @returns ViewingKeyType Type of the viewing key
     *
     * @example
     * ```typescript
     * const type = wasm.detectKeyType('uviewtest1...');
     * console.log(type); // 'ufvk-testnet'
     * ```
     */
    detectKeyType(viewingKey) {
        if (!this.wasmModule) {
            throw new Error('WASM module not initialized. Call ZcashWASM.init() first.');
        }
        return this.wasmModule.detect_key_type(viewingKey);
    }
}
/**
 * Default export for convenience
 */
export default ZcashWASM;
