import type {ResearchDocument,ResearchLibrary} from './research-contract';
export const STORAGE_KEY:string;
export const MAX_BYTES:number;
export function emptyLibrary():ResearchLibrary;
export function readLibrary(storage:Pick<Storage,'getItem'>):{raw:string|null;library:ResearchLibrary};
export function writeLibrary(storage:Pick<Storage,'getItem'|'setItem'>,library:ResearchLibrary,previous:string|null):string;
export function readPortable(text:string):ResearchDocument|ResearchLibrary;
export function mergePortable(current:ResearchLibrary,incoming:ResearchDocument|ResearchLibrary,uuid:()=>string):ResearchLibrary;
export function markdownReport(document:ResearchDocument):string;

export function csvReport(document:ResearchDocument):string;
