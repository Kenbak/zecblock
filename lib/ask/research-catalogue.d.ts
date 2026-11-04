export interface ResearchDataset { readonly id:string; readonly title:string; readonly columns:string; readonly description:string }
export const researchCatalogue:readonly ResearchDataset[];
export const researchIds:readonly string[];
export const coreIds:readonly string[];
export function catalogueFor(extended:boolean):ResearchDataset[];
