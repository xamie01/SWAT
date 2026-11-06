import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path

os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})
OUT = Path('/home/xahmie/Documents/SWAT/threats/runtime')
records = []

def request(name, url, payload=None):
    start = time.monotonic()
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, headers={'User-Agent': 'SWAT-owned-product-read-only-review/1.0', 'Accept': 'application/json', **({'Content-Type': 'application/json'} if body else {})})
    record = {'name': name, 'url': url, 'method': 'POST-read-only-JSON-RPC' if body else 'GET', 'timestamp_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        with urllib.request.urlopen(req, timeout=18) as response:
            raw = response.read(3_000_001)
            if len(raw) > 3_000_000: raise ValueError('Response exceeds bounded sample size')
            value = json.loads(raw)
            record.update(status=response.status, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            (OUT/(name+'.json')).write_bytes(raw)
            print(name, 'OK', response.status, len(raw), flush=True)
    except Exception as error:
        value = None
        record.update(error=str(error))
        print(name, 'ERROR', str(error), flush=True)
    record['seconds'] = round(time.monotonic()-start, 3)
    records.append(record)
    (OUT/'live-fetches.json').write_text(json.dumps(records, indent=2)+'\n')
    return value

if __name__ == '__main__':
    request('solana-version','https://api.mainnet-beta.solana.com',{'jsonrpc':'2.0','id':1,'method':'getVersion'})
    request('solana-slot','https://api.mainnet-beta.solana.com',{'jsonrpc':'2.0','id':1,'method':'getSlot','params':[{'commitment':'finalized'}]})
    sigs=request('solana-signatures','https://api.mainnet-beta.solana.com',{'jsonrpc':'2.0','id':1,'method':'getSignaturesForAddress','params':['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',{'limit':3,'commitment':'finalized'}]})
    if sigs and isinstance(sigs.get('result'),list) and sigs['result']:
        request('solana-transaction','https://api.mainnet-beta.solana.com',{'jsonrpc':'2.0','id':1,'method':'getTransaction','params':[sigs['result'][0]['signature'],{'encoding':'jsonParsed','maxSupportedTransactionVersion':0,'commitment':'finalized'}]})
    request('polygon-chain','https://polygon-bor-rpc.publicnode.com',{'jsonrpc':'2.0','id':1,'method':'eth_chainId'})
    request('polymarket-trades','https://data-api.polymarket.com/v2/trades?limit=5')
    request('polymarket-markets','https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=3')
    request('meteora-pools','https://dlmm.datapi.meteora.ag/pools?page=1&page_size=3&sort_by=volume_24h%3Adesc')
    request('jupiter-quote','https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50')
