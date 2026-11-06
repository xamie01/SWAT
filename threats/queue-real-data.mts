import { writeFileSync, readFileSync } from 'node:fs';
import { Redis } from '../node_modules/ioredis/built/index.js';
import { Queue, Worker, QueueEvents } from '../node_modules/bullmq/dist/cjs/index.js';
import { parseConfirmedPolymarketTrade } from '../apps/indexer/src/polymarket-helpers.ts';
const row=JSON.parse(readFileSync('threats/runtime/polymarket-trades.json','utf8')).data[0];
const connections=Array.from({length:3},()=>new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null}));
const name='review-real-data-'+Date.now();
const events=new QueueEvents(name,{connection:connections[2],lastEventId:'0-0'});
const queue=new Queue(name,{connection:connections[0]});
const worker=new Worker(name,async(job)=>({hash:parseConfirmedPolymarketTrade(job.data).transactionHash,noBroadcast:true}),{connection:connections[1],concurrency:1});
const start=performance.now();
try {
 await events.waitUntilReady();await worker.waitUntilReady();
 const job=await queue.add('public-fill',row);
 const result=await job.waitUntilFinished(events,30000);
 const state=await job.getState();
 if(state!=='completed')throw new Error('Unexpected durable job state: '+state);
 const report={state,result,milliseconds:performance.now()-start,queue:name,cpuAffinityInherited:true,workerConcurrency:1};
 writeFileSync('threats/runtime/queue-real-data.json',JSON.stringify(report,null,2));console.log(report);
} finally {await worker.close();await events.close();await queue.close();for(const connection of connections)await connection.quit();}
