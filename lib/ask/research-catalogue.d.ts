export interface ResearchDataset { readonly id:string; readonly title:string; readonly columns:string; readonly description:string; readonly published?:false }
export const researchCatalogue:readonly ResearchDataset[];
export const researchIds:readonly string[];
export const coreIds:readonly string[];
export const publishedIds:readonly string[];
export function isPublished(id:string,options?:{preview?:boolean}):boolean;
export function catalogueFor(extended:boolean,options?:{preview?:boolean}):ResearchDataset[];
