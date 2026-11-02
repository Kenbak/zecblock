import { zatToZec } from '@/lib/format-numbers';
import type { TransactionData } from './types';

export function transformExpressTxData(txData: any): TransactionData {
  const transformedInputs = (txData.inputs || []).map((input: any) => ({
    ...input,
    value: input.value ? zatToZec(input.value) : 0,
    txid: input.prev_txid,
    vout: input.prev_vout,
  }));

  const transformedOutputs = (txData.outputs || []).map((output: any) => ({
    value: output.value ? zatToZec(output.value) : 0,
    n: output.vout_index,
    spent: output.spent || false,
    scriptPubKey: {
      hex: output.script_pubkey || '',
      addresses: output.address ? [output.address] : [],
    },
  }));

  const transparentInputSum = transformedInputs.reduce(
    (sum: number, i: any) => sum + (i.value || 0),
    0,
  );
  const transparentOutputSum = transformedOutputs.reduce(
    (sum: number, o: any) => sum + (o.value || 0),
    0,
  );

  const transformedData: TransactionData = {
    txid: txData.txid,
    status: txData.status,
    isCanonical: txData.isCanonical,
    blockHeight: txData.blockHeight,
    blockHash: txData.blockHash,
    timestamp: parseInt(txData.blockTime),
    confirmations: parseInt(txData.confirmations),
    inputs: transformedInputs,
    outputs: transformedOutputs,
    totalInput: txData.totalInput != null ? txData.totalInput : transparentInputSum,
    totalInputZat: txData.totalInputZat ?? null,
    totalOutput: txData.totalOutput != null ? txData.totalOutput : transparentOutputSum,
    totalOutputZat: txData.totalOutputZat ?? null,
    fee: txData.fee ?? null,
    feeZat: txData.feeZat ?? null,
    size: parseInt(txData.size),
    version: parseInt(txData.version),
    locktime: parseInt(txData.locktime),
    expiryHeight: txData.expiryHeight ? parseInt(txData.expiryHeight) : null,
    saplingSpendCount: txData.saplingSpendCount || 0,
    saplingOutputCount: txData.saplingOutputCount || 0,
    hasShieldedData: txData.hasSapling || txData.hasShielded || txData.hasIronwood || false,
    hasSprout: txData.hasSprout === true,
    isCoinbase: txData.isCoinbase || false,
    orchardActions: txData.orchardActions || 0,
    ironwoodActions: txData.ironwoodActions || 0,
    valueBalance: txData.valueBalance == null ? undefined : Number(txData.valueBalance),
    valueBalanceZat: txData.valueBalanceZat ?? null,
    valueBalanceSapling: txData.valueBalanceSapling == null ? undefined : Number(txData.valueBalanceSapling),
    valueBalanceSaplingZat: txData.valueBalanceSaplingZat ?? null,
    valueBalanceOrchard: txData.valueBalanceOrchard == null ? undefined : Number(txData.valueBalanceOrchard),
    valueBalanceOrchardZat: txData.valueBalanceOrchardZat ?? null,
    valueBalanceIronwood: txData.valueBalanceIronwood == null ? undefined : Number(txData.valueBalanceIronwood),
    valueBalanceIronwoodZat: txData.valueBalanceIronwoodZat ?? null,
    valueBalanceSprout: txData.valueBalanceSprout == null ? undefined : Number(txData.valueBalanceSprout),
    valueBalanceSproutZat: txData.valueBalanceSproutZat ?? null,
    bindingSig: txData.bindingSig,
    bindingSigSapling: txData.bindingSigSapling,
    finality: txData.finality || null,
    bridge: txData.bridge || null,
    bridges: txData.bridges || [],
    stakingAction: txData.stakingAction || null,
    coinbaseHex: txData.coinbaseHex || null,
    coinbaseText: txData.coinbaseText || null,
    zip318: txData.zip318 || null,
  };

  return transformedData;
}
