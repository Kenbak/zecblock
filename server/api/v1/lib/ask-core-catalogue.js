'use strict';
const {datasets,compileQuery}=require('./ask-query-plan');
const transactionFields={...datasets.transactions.fields};delete transactionFields.orchard_actions;delete transactionFields.ironwood_actions;
const coreDatasets=Object.freeze({
 blocks:Object.freeze({...datasets.blocks,view:'blocks_query'}),
 transactions:Object.freeze({...datasets.transactions,view:'transactions_query',fields:Object.freeze(transactionFields)}),
 flows:Object.freeze({...datasets.flows,view:'flows_query'}),
});
const coreCatalogue=Object.entries(coreDatasets).map(([dataset,d])=>({dataset,label:d.label,fields:d.fields,notes:d.notes}));
const coreViews=Object.freeze(['coverage','blocks','transactions','flows','blocks_query','transactions_query','flows_query','dataset_coverage','daily_query','swaps_query','addresses_query','address_activity_query','activity_daily_query','address_daily_query','flow_daily_query','supply_daily_query','issuance_query','mining_daily_query','software_daily_query','block_timing_query','issuance_daily_query']);
function compileCorePlan(input,now){if(input?.version!==2)throw Error('Core relational plan required');return compileQuery(input,now,coreDatasets,'analytics_public');}
module.exports={coreCatalogue,coreViews,compileCorePlan};
