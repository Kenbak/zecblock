import { createContext } from 'react';
import type { PrivateRecord } from './TransactionView';

export const PrivateRecordContext = createContext<PrivateRecord | null>(null);
