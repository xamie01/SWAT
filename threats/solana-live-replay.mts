import { readFileSync,writeFileSync } from 'node:fs';
import { parseCanonicalSolanaSwapEvent } from '../apps/indexer/src/parse.ts';
const payload=JSON.parse(readFileSync('threats/runtime/solana-success-transaction.json','utf8'));
const tx=payload.result;
const owners=[...new Set([...tx.meta.preTokenBalances,...tx.meta.postTokenBalances].map((row:any)=>row.owner).filter(Boolean))];
const parsed=owners.map(owner=>({owner,event:parseCanonicalSolanaSwapEvent(tx,owner as string)}));
const result={version:tx.version,error:tx.meta.err,parsed};
writeFileSync('threats/runtime/solana-success-replay.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
