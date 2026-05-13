import { query } from '@swat/db';

export type SafetyResult = {
  isSafe: boolean;
  flags: string[];
  warnings: string[];
};

export async function checkTokenSafety(tokenMint: string): Promise<SafetyResult> {
  const flags: string[] = [];
  const warnings: string[] = [];
  let isSafe = true;

  const rows = await query<{ mint_authority_disabled: boolean, freeze_authority_disabled: boolean }>(
    `SELECT mint_authority_disabled, freeze_authority_disabled FROM tokens WHERE mint = $1`,
    [tokenMint]
  );
  
  const token = rows[0];
  if (!token) {
    return { isSafe: false, flags: ['unverified_token'], warnings: ['Token not fully indexed'] };
  }

  // In MVP, we just use the DB flags which would be populated by an RPC fetcher in the indexer
  if (!token.mint_authority_disabled) {
    isSafe = false;
    flags.push('mint_enabled');
    warnings.push('Mint authority is still enabled!');
  }

  if (!token.freeze_authority_disabled) {
    isSafe = false;
    flags.push('freeze_enabled');
    warnings.push('Freeze authority is still enabled!');
  }

  // Example placeholder for low liquidity
  // flags.push('low_liquidity');
  // isSafe = false;

  return { isSafe, flags, warnings };
}
