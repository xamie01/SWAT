import { query } from '@swat/db';

async function seed() {
  console.log('Seeding initial high-conviction Alpha Masters across Solana, Robinhood Chain, and Polymarket...');

  const masters = [
    {
      address: 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      chain: 'solana',
      nickname: 'Solana Alpha Whale',
      source: 'discovered',
      discoveryMethod: 'token-early',
      status: 'active',
      composite_score: 94.5,
      tier: 'elite',
      win_rate: 0.82,
      realized_roi: 2.85,
      total_trades: 142
    },
    {
      address: 'solana:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
      chain: 'solana',
      nickname: 'Raydium Momentum Sniper',
      source: 'discovered',
      discoveryMethod: 'counterparty',
      status: 'active',
      composite_score: 88.0,
      tier: 'pro',
      win_rate: 0.74,
      realized_roi: 1.95,
      total_trades: 98
    },
    {
      address: 'robinhood-chain:0x534631Bcf33BDb069fB20A75d2791C868E2f50F9',
      chain: 'robinhood-chain',
      nickname: 'Arbitrum L2 Yield Syndicate',
      source: 'discovered',
      discoveryMethod: 'funding',
      status: 'active',
      composite_score: 91.2,
      tier: 'elite',
      win_rate: 0.79,
      realized_roi: 2.10,
      total_trades: 115
    },
    {
      address: 'polygon:0x4f87A0463E5E65d6c29A7AcDb8FE62506b12f671',
      chain: 'polygon',
      nickname: 'Polymarket Macro Arb Master',
      source: 'discovered',
      discoveryMethod: 'counterparty',
      status: 'active',
      composite_score: 86.5,
      tier: 'pro',
      win_rate: 0.71,
      realized_roi: 1.65,
      total_trades: 84
    }
  ];

  for (const m of masters) {
    await query(`
      INSERT INTO wallets (
        address, chain, nickname, source, discovery_method, status,
        composite_score, tier, win_rate, realized_roi, total_trades, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (address) DO UPDATE SET
        chain = EXCLUDED.chain,
        nickname = EXCLUDED.nickname,
        composite_score = EXCLUDED.composite_score,
        tier = EXCLUDED.tier,
        win_rate = EXCLUDED.win_rate,
        realized_roi = EXCLUDED.realized_roi,
        total_trades = EXCLUDED.total_trades,
        status = 'active',
        updated_at = NOW();
    `, [
      m.address, m.chain, m.nickname, m.source, m.discoveryMethod, m.status,
      m.composite_score, m.tier, m.win_rate, m.realized_roi, m.total_trades
    ]);
  }

  // Also seed a default subscription for trader@swat.internal so their dashboard shows an active mirrored master
  const [trader] = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', ['trader@swat.internal']);
  if (trader) {
    await query(`
      INSERT INTO user_wallet_subscriptions (user_id, wallet_address, label, source, state, membership_slot)
      VALUES ($1, 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'Solana Alpha Whale', 'discovered', 'active', 1)
      ON CONFLICT (user_id, wallet_address) DO UPDATE SET
        state = 'active',
        membership_slot = 1;
    `, [trader.id]);
    console.log('Seeded subscription for trader:', trader.id);
  }

  console.log('Alpha Masters seeded successfully!');
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
