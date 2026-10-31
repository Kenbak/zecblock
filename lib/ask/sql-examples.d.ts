export interface SQLExample { readonly id:string; readonly title:string; readonly description:string; readonly extended:boolean; readonly datasets?:readonly string[]; readonly sql:string }
export const sqlExamples:readonly SQLExample[];
export function examplesFor(extended:boolean,options?:{preview?:boolean}):SQLExample[];
