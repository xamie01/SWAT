import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { query } from '@swat/db';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
    if (!telegramToken || !telegramChatId) {
        console.log('[alert-service] Telegram not configured — would send:\n', message);
        return;
    }
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chat_id: telegramChatId,
            text: message,
            parse_mode: 'HTML'
        })
    });
    if (!response.ok)
        throw new Error(`Telegram error: ${response.status}`);
}
// ─── Token metadata helper ────────────────────────────────────────────────────
async function getTokenMeta(mint) {
    const rows = await query(`SELECT symbol, name FROM tokens WHERE mint = $1`, [mint]);
    return rows[0] ?? { symbol: null, name: null };
}
async function getClusterMeta(clusterId) {
    const rows = await query(`SELECT name, confidence, total_realized_roi, avg_composite_score, wallet_count
      FROM wallet_clusters WHERE id = $1`, [clusterId]);
    return rows[0] ?? null;
}
function formatSafe(val) {
    if (val === undefined)
        return '❓ Unknown';
    return val ? '✅ Passed' : '🛑 Failed';
}
function formatLiquidity(liquidity) {
    if (liquidity == null)
        return '❓ Unknown';
    if (liquidity >= 1_000_000)
        return `$${(liquidity / 1_000_000).toFixed(1)}M ✅`;
    if (liquidity >= 50_000)
        return `$${(liquidity / 1000).toFixed(0)}K ✅`;
    return `$${(liquidity / 1000).toFixed(0)}K 🛑 LOW`;
}
function formatHolderConc(pct) {
    if (pct == null)
        return '❓ Unknown';
    if (pct > 60)
        return `${pct}% 🛑 HIGH`;
    if (pct > 35)
        return `${pct}% ⚠️`;
    return `${pct}% ✅`;
}
function patternHeader(pattern, score) {
    const scoreStr = score != null ? ` — Score: ${score}/100` : '';
    const icons = {
        snipe: `🎯 SNIPE SIGNAL${scoreStr}`,
        accumulation: `📈 ACCUMULATION SIGNAL${scoreStr}`,
        rotation: `🔄 ROTATION SIGNAL${scoreStr}`,
        exit: `🔴 EXIT SIGNAL${scoreStr}`,
        stealth: `🕵️ STEALTH BUY${scoreStr}`
    };
    return icons[pattern] ?? `⚡ SIGNAL [${pattern.toUpperCase()}]${scoreStr}`;
}
async function formatSignalAlert(payload) {
    const ca = payload.tokenMint ?? 'N/A';
    const token = payload.tokenMint ? await getTokenMeta(payload.tokenMint) : null;
    const cluster = payload.clusterId ? await getClusterMeta(payload.clusterId) : null;
    const isExit = payload.pattern === 'exit';
    const tokenLabel = token?.symbol ? `$${token.symbol}` : 'Unknown Token';
    const tokenName = token?.name ?? '';
    const lines = [
        `<b>${patternHeader(payload.pattern, payload.score)}</b>`,
        ''
    ];
    // ── CA block (most important) ──
    if (!isExit) {
        lines.push(`📋 <b>CA:</b> <code>${ca}</code>`);
        if (tokenLabel !== 'Unknown Token') {
            lines.push(`Token: ${tokenLabel}${tokenName ? ` (${tokenName})` : ''}`);
        }
        lines.push('');
    }
    else {
        lines.push(`Token: ${tokenLabel} — <code>${ca}</code>`);
        lines.push('');
    }
    // ── Cluster intel ──
    if (cluster) {
        const roi = cluster.total_realized_roi != null
            ? `${cluster.total_realized_roi >= 0 ? '+' : ''}${(cluster.total_realized_roi * 100).toFixed(0)}% ✅`
            : 'N/A';
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push('<b>📊 CLUSTER INTEL</b>');
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`Cluster: ${cluster.name ?? payload.clusterId}`);
        lines.push(`Cluster 90d ROI: ${roi}`);
        lines.push(`Cluster confidence: ${Math.round(cluster.confidence * 100)}%`);
        lines.push(`Wallets triggered: ${payload.buyerCount ?? payload.sellerCount ?? '?'} of ${cluster.wallet_count}`);
        lines.push(`Pattern: ${payload.pattern.charAt(0).toUpperCase() + payload.pattern.slice(1)}`);
        if (payload.window)
            lines.push(`Window: ${payload.window}`);
        if (payload.buyVolume)
            lines.push(`Volume: $${payload.buyVolume.toLocaleString()}`);
        if (payload.exitVolume)
            lines.push(`Exit volume: $${payload.exitVolume.toLocaleString()}`);
        if (isExit && payload.sellerPct)
            lines.push(`Sellers: ${payload.sellerPct}% of cluster`);
        lines.push('');
    }
    // ── Token Safety ──
    if (!isExit) {
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push('<b>🪙 TOKEN SAFETY</b>');
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`Safety check: ${formatSafe(payload.isSafe)}`);
        lines.push(`Liquidity: ${formatLiquidity(payload.liquidity)}`);
        lines.push(`Top 10 holders: ${formatHolderConc(payload.top10HolderPct)}`);
        if (payload.warnings && payload.warnings.length > 0) {
            lines.push('');
            lines.push('⚠️ <b>WARNINGS:</b>');
            payload.warnings.forEach(w => lines.push(`  - ${w}`));
        }
        lines.push('');
    }
    // ── Suggested execution ──
    if (!isExit && payload.isSafe) {
        const baseSol = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push('<b>⚡ SUGGESTED EXECUTION</b>');
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`Size: ${baseSol} SOL`);
        lines.push(`Slippage: 15%`);
        lines.push(`TP1: 2x → sell 50%`);
        lines.push(`TP2: 3x → sell 25%`);
        lines.push(`SL: -25%`);
        lines.push('');
    }
    if (isExit) {
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`⚠️ Consider taking profit or tightening SL.`);
    }
    else if (!payload.isSafe) {
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push('🛑 <b>EXECUTION BLOCKED — Safety check failed</b>');
    }
    lines.push('');
    lines.push(`Signal ID: <code>${payload.signalId}</code>`);
    if (payload.tokenMint) {
        lines.push([
            `<a href="https://dexscreener.com/solana/${ca}">DexScreener</a>`,
            `<a href="https://solscan.io/token/${ca}">Solscan</a>`,
            `<a href="https://birdeye.so/token/${ca}">Birdeye</a>`
        ].join(' | '));
    }
    return lines.join('\n');
}
// ─── Worker ───────────────────────────────────────────────────────────────────
new Worker('swat-alerts', async (job) => {
    const payload = job.data;
    const message = await formatSignalAlert(payload);
    await sendTelegram(message);
    return { sent: true };
}, { connection: redis });
console.log('[alert-service] service running');
//# sourceMappingURL=index.js.map