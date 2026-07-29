-- Live execution requires both an operator allowlist entry and an independently
-- reviewed certification record. This migration intentionally seeds no rows.

CREATE TABLE IF NOT EXISTS chain_certifications (
  chain TEXT PRIMARY KEY CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'certified', 'revoked')),
  evidence_path TEXT,
  evidence_sha256 TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chain_certifications_certified_evidence_check CHECK (
    status != 'certified'
    OR (
      evidence_path LIKE 'docs/certification/%'
      AND evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND LENGTH(BTRIM(reviewed_by)) > 0
      AND reviewed_at IS NOT NULL
    )
  ),
  CONSTRAINT chain_certifications_expiry_check CHECK (
    expires_at IS NULL OR reviewed_at IS NULL OR expires_at > reviewed_at
  )
);

CREATE INDEX IF NOT EXISTS idx_chain_certifications_active
  ON chain_certifications (status, expires_at);
