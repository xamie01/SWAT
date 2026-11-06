import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Redis } from '../node_modules/ioredis/built/index.js';
import { Queue, Worker, QueueEvents } from '../node_modules/bullmq/dist/cjs/index.js';
import { upsertWallet, pool, closePool, listSourceTradeSignalCandidates, insertSourceTradeSignal, claimSourceSignalForCopyExecution, transitionCopyExecution, recordCopyExecutionEvidence } from '../packages/db/src/index.ts';
import { parseConfirmedPolymarketTrade } from '../apps/indexer/src/polymarket-helpers.ts';
import { persistPolymarketSourceTrade } from '../apps/indexer/src/source-trade-lifecycle.ts';
import { parseCanonicalSolanaSwapEvent } from '../apps/indexer/src/parse.ts';
import { persistTrade } from '../apps/trade-executor/src/index.ts';
import { createMeteoraPoolFetcher } from '../apps/lp/src/scanner/meteora-pools.ts';

const root = resolve('threats/runtime');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(root, name + '.json'), 'utf8'));
const report: Record<string, unknown> = { networkDuringReplay: false, realSubmissions: false };
const results: unknown[] = [];
try {
  const rows = fixture('polymarket-trades').data;
  for (const raw of rows) {
    const trade = parseConfirmedPolymarketTrade(raw);
    await upsertWallet({address:trade.proxyWallet,chain:'polygon',source:'manual'});
    const input = {trade,quantity:String(Math.round(trade.size * 1_000_000)),amountUsd:trade.size*trade.price};
    const first = await persistPolymarketSourceTrade(input);
    const repeat = await persistPolymarketSourceTrade(input);
    if (first.event.id !== repeat.event.id) throw new Error('Real fill replay changed source identity');
    await pool.query('INSERT INTO tokens (mint, chain) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING',['polygon:'+trade.asset,'polygon']);
    await pool.query("UPDATE wallets SET status='active', composite_score=92, total_trades=40, last_active=NOW() WHERE address=$1",['polygon:'+trade.proxyWallet]);
    const candidates = await listSourceTradeSignalCandidates({sourceTradeId:first.event.id,maxEventAgeMs:3600000,limit:1});
    results.push({sourceTradeId:first.event.id, replayIdempotent:true, candidates:candidates.length,side:trade.side});
    if (trade.side === 'BUY') {
      const signal = await insertSourceTradeSignal({sourceTradeId:first.event.id,signalScore:92,confidence:.9,triggerData:{review:'real-public-fill'},maxEventAgeMs:3600000,maxPositionEvidenceAgeMs:3600000});
      const claimed = await claimSourceSignalForCopyExecution({signalId:signal.id,targetAccount:'polygon:0x1111111111111111111111111111111111111111',executionMode:'paper',requestedBaseQuantity:input.quantity,maxPositionEvidenceAgeMs:3600000});
      if (!claimed.execution) throw new Error('Real-data paper claim refused: '+claimed.reason);
      if (claimed.execution.state === 'confirmed') {
        const existing=await pool.query('SELECT id FROM trades WHERE copy_execution_id=$1',[claimed.execution.id]);
        if(existing.rows.length===0) await persistTrade({signalId:signal.id,sourceTradeId:first.event.id,copyExecutionId:claimed.execution.id,tokenMint:'polygon:'+trade.asset,size:input.amountUsd,chain:'polygon',executionMode:'paper',direction:'buy',executor:'review-paper',amountUsd:input.amountUsd,tokenAmount:trade.size,priceUsd:trade.price,feeUsd:0});
        results.push({paperExecutionId:claimed.execution.id,state:'confirmed',resumedWithoutReexecution:true,tradePersisted:true});
        continue;
      }
      if (claimed.execution.state === 'claimed') await transitionCopyExecution({executionId:claimed.execution.id,nextState:'simulated',simulationId:'review-real-'+first.event.id});
      if (claimed.execution.state === 'claimed' || claimed.execution.state === 'simulated') await transitionCopyExecution({executionId:claimed.execution.id,nextState:'submitted',submissionType:'order',submissionId:'review-paper-'+first.event.id,nextReconciliationAt:new Date(Date.now()+30000)});
      const evidence={executionId:claimed.execution.id,evidenceType:'paper_simulation' as const,evidenceId:'review-evidence-'+first.event.id,baseQuantity:input.quantity,quoteLeg:{amount:String(input.amountUsd),currency:'USD' as const},priceUsd:String(trade.price/1000000),confirmationState:'finalized' as const,completesExecution:true,occurredAt:new Date()};
      const settled=await recordCopyExecutionEvidence(evidence);
      await recordCopyExecutionEvidence(evidence);
      results.push({paperExecutionId:claimed.execution.id,state:settled.execution.state,syntheticPaperFill:true,sourceEconomicsFromLiveSample:true});
    }
  }
  report.polymarket = results;
  const payload = fixture('meteora-pools');
  const pools = await createMeteoraPoolFetcher({maxPairs:3,fetchImpl:async()=>new Response(JSON.stringify(payload),{status:200})}).fetch();
  report.meteora = pools.map(p=>({pool:p.poolAddress,price:p.currentPrice,tvl:p.tvl,activeTvlExact:p.activeTvlExact}));
  const tx = fixture('solana-transaction-v1-0').result;
  const owners = [...new Set([...tx.meta.preTokenBalances,...tx.meta.postTokenBalances].map((b:any)=>b.owner).filter(Boolean))];
  report.solana={version:tx.version,metaError:tx.meta.err,owners:owners.map(owner=>({owner,parsed:parseCanonicalSolanaSwapEvent(tx,owner as string)}))};
  const connection = new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  const workerConnection = new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  const eventsConnection = new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  const queueName='review-real-data-replay-'+Date.now();
  const queue = new Queue(queueName,{connection});
  const events = new QueueEvents(queueName,{connection:eventsConnection,lastEventId:'0-0'});
  const worker = new Worker(queueName,async(job)=>({parsed:parseConfirmedPolymarketTrade(job.data).transactionHash,paperOnly:true}),{connection:workerConnection,concurrency:1});
  try {
    await events.waitUntilReady();
    const start=performance.now();
    const job=await queue.add('public-fill',rows[0],{jobId:'public-fill-'+Date.now()});
    report.redisRealDataRoundTrip={result:await job.waitUntilFinished(events,10000),milliseconds:performance.now()-start};
  } finally {await worker.close();await events.close();await queue.close();await connection.quit();await workerConnection.quit();await eventsConnection.quit();}
} catch(error) {report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally {await closePool();writeFileSync(resolve(root,'live-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
