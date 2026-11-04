// A Node consumer with only lib.es2022 must not need DOM type declarations.
import ZcashWASM, { type CompactBlock, type MatchingTransaction } from '../dist/index.js';
declare const key: string;
declare const blocks: CompactBlock[];
const decoder: Promise<ZcashWASM> = ZcashWASM.init();
void ZcashWASM.init(new Uint8Array());
void ZcashWASM.init(new ArrayBuffer(0));
void decoder.then(async wasm => {
  const matches: MatchingTransaction[] = await wasm.filterCompactBlocks(blocks, key);
  return matches;
});
