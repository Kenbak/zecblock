import { useContext } from 'react';
import type { ComponentProps } from 'react';
import { FactBox as SharedFactBox } from '../../../../components/ui/FactBox';
import { PrivateRecordContext } from '../private-record-context';
import { privateFeeLabel } from '../private-record-facts';
export { CopyableHash, BoldZec } from '../../../../components/ui/FactBox';

// Only the private bundle aliases FactBox through this adapter. Captured null
// fees must not inherit the public transform's numeric zero fallback.
export function FactBox(props: ComponentProps<typeof SharedFactBox>) {
  const record = useContext(PrivateRecordContext);
  if (props.label !== 'Fee' || record === null) return <SharedFactBox {...props} />;
  return <SharedFactBox {...props} tooltip="Captured transaction fee; unavailable values are not inferred as zero.">
    <span id="private-fee" className="text-sm font-mono font-semibold text-primary whitespace-nowrap">{privateFeeLabel(record.detail)}</span>
  </SharedFactBox>;
}
