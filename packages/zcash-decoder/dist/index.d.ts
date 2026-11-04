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
import type { DecryptedOutput, CompactBlock, MatchingTransaction, FilterProgress, ViewingKeyType } from './types.js';
/**
 * Main ZcashWASM class for client-side Zcash operations
 */
export declare class ZcashWASM {
    private wasmModule;
    private constructor();
    /**
     * Initialize the WASM module
     * @returns Promise<ZcashWASM> Initialized WASM instance
     *
     * @example
     * ```typescript
     * const wasm = await ZcashWASM.init();
     * ```
     */
    static init(wasmInput?: ArrayBuffer | Uint8Array): Promise<ZcashWASM>;
    /**
     * Load the WASM module from the wasm/ directory
     */
    private loadWASM;
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
    decryptMemo(txHex: string, viewingKey: string): Promise<DecryptedOutput>;
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
    filterCompactBlocks(compactBlocks: CompactBlock[], viewingKey: string, onProgress?: (progress: FilterProgress) => void): Promise<MatchingTransaction[]>;
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
    detectKeyType(viewingKey: string): ViewingKeyType;
}
/**
 * Default export for convenience
 */
export default ZcashWASM;
//# sourceMappingURL=index.d.ts.map