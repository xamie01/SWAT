import { query } from './client.js';
const CERTIFICATION_CACHE_TTL_MS = 30_000;
let cachedCertifications = null;
/**
 * Return chains with a reviewed, non-expired certification record.
 * Operator enablement is evaluated separately so neither control is sufficient alone.
 */
export async function getActiveCertifiedChains() {
    const now = Date.now();
    if (cachedCertifications && now - cachedCertifications.timestamp < CERTIFICATION_CACHE_TTL_MS) {
        return cachedCertifications.chains;
    }
    const rows = await query(`SELECT chain
       FROM chain_certifications
      WHERE status = 'certified'
        AND reviewed_at IS NOT NULL
        AND reviewed_at <= NOW()
        AND evidence_path LIKE 'docs/certification/%'
        AND evidence_sha256 ~ '^[0-9a-f]{64}$'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY chain`);
    const chains = rows.map((row) => row.chain);
    cachedCertifications = { chains, timestamp: now };
    return chains;
}
export function clearChainCertificationCache() {
    cachedCertifications = null;
}
//# sourceMappingURL=chain-certifications.js.map