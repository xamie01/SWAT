import importlib.util
import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

spec=importlib.util.spec_from_file_location('runner', '/home/xahmie/Documents/SWAT/threats/runtime-runner.py')
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
records=[]
for service, entry, port, port_key, paths in [
 ('api','apps/api/src/index.ts',53001,'PORT',['/health','/v1/health','/v1/stats','/v1/me/account','/v1/trading/status']),
 ('lp','apps/lp/src/index.ts',53010,'LP_PORT',['/v1/health','/v1/lp/discover','/v1/lp/positions'])
]:
 env=r.ENV | {port_key:str(port),'API_KEY':'runtime-review-key','DISABLE_BILLING_SWEEPER_DAEMON':'true','RUN_ON_STARTUP':'false','TSX_TSCONFIG_PATH':str(r.ROOT/'threats/runtime-tsconfig.json'),'SOLANA_RPC_URL':'http://127.0.0.1:59999','POLYGON_RPC_URL':'http://127.0.0.1:59999','ROBINHOOD_RPC_URL':'http://127.0.0.1:59999'}
 log=r.OUT/(service+'-startup.log')
 with log.open('w') as stream:
  proc=subprocess.Popen([str(r.ROOT/'node_modules/.bin/tsx'),entry],cwd=r.ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   ready=False
   for i in range(60):
    if proc.poll() is not None: break
    try:
     urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=1).close();ready=True;break
    except urllib.error.HTTPError: ready=True;break
    except Exception: time.sleep(.5)
   print(service,'ready',ready,'exit',proc.poll(),flush=True)
   if ready:
    for path in paths:
     for authenticated in [False,True]:
      req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers=({'X-Api-Key':'runtime-review-key'} if authenticated else {}))
      started=time.monotonic()
      try:
       response=urllib.request.urlopen(req,timeout=8)
      except urllib.error.HTTPError as e: response=e
      try:
       body=response.read().decode(); status=response.code
       records.append({'service':service,'path':path,'service_key':authenticated,'status':status,'body':body,'seconds':round(time.monotonic()-started,3)})
       print(service,path,authenticated,status,body[:500],flush=True)
      except Exception as e: records.append({'service':service,'path':path,'error':str(e)})
   else: records.append({'service':service,'startup_failed':True,'exit_code':proc.poll()})
  finally:
   if proc.poll() is None:
    os.killpg(proc.pid,signal.SIGTERM)
    try: proc.wait(timeout=8)
    except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
 print(log.read_text()[-3500:],flush=True)
(r.OUT/'service-smoke.json').write_text(json.dumps(records,indent=2)+'\n')
