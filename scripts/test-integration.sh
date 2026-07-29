#!/bin/bash
set -e

echo "--- Starting Integration Test Suite ---"

# G7-T2: Start Docker fixtures
echo "Spinning up Docker integration fixtures..."
docker compose up -d postgres redis

echo "Waiting for services to be ready..."
sleep 5

# G7-T3: Database Migration
echo "Running database migrations..."
pnpm db:migrate

# G7-T4: Run Unit and Package-level Tests
echo "Running unit and package-level tests (execution config, risk math, parsing)..."
pnpm test

# G7-T1, G7-T5: Verify End-to-End Acceptance Goals
echo "Running End-to-End Acceptance Verification..."
pnpm tsx scripts/verify-acceptance.ts

echo "--- Integration Test Suite Completed Successfully ---"
