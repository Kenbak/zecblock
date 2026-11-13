import { useContext } from 'react';
import type { ComponentProps } from 'react';
import { ExportButton as SharedExportButton } from '../../../../components/ExportButton';
import { PrivateRecordContext } from '../private-record-context';

export function ExportButton(props: ComponentProps<typeof SharedExportButton>) {
  const record = useContext(PrivateRecordContext);
  // Explicit local exports retain the captured exact/null facts and snapshot,
  // rather than the public presentation transform's abbreviated numeric data.
  return <SharedExportButton {...props} data={record ?? props.data} />;
}
