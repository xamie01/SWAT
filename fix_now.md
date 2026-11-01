 1. Fix Working Tree Breakages:                                             
      • Guard accrueMasterCapacityFillNotional in index.ts:1286 so pnpm      
      typecheck passes cleanly across all 11 packages.                       
      • Supply transactionHash in lot-exits.integration.test.ts:21 so the    
      integration suite passes.                                              
  2. Complete Batch 1 Lifecycle Exit Consumer:                               
      • Wire listCloseAllLotJobs into the executor queue to automatically    
      execute sells for winding-down subscriptions, then trigger             
      endCompletedCloseAllSubscriptions.                                     
  3. Execute Batch 2 (Multi-Tenant Paper Fan-Out):                           
      • Run end-to-end integration tests with 2 distinct users copying the   
      same source signal on a clean DB, verifying separate balances,         
      positions, lot tracking, and independent risk caps.      
