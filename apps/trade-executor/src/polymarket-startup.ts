import { production } from '@polymarket/client';
import { ethers } from 'ethers';
import { resolveChainMode } from '@swat/db';
import {
  getPolymarketAvailableBalance,
  initializePolymarketClient,
  polygonProvider,
  polymarketSigner,
  POLYMARKET_CLOB_HOST,
  POLYGON_CHAIN_ID,
  POLYMARKET_SDK_VERSION,
  setPolymarketLiveReadiness,
  type PolymarketClientInitialization
} from './polymarket.js';
import {
  EthersPolymarketCollateralGateway,
  ensurePolymarketCollateralReadiness,
  POLYMARKET_CONTRACTS,
  type PolymarketCollateralGateway
} from './polymarket-collateral.js';

const CORE_ATTESTED_CONTRACTS = [
  ['CTF Exchange V2', POLYMARKET_CONTRACTS.ctfExchange],
  ['Neg Risk CTF Exchange V2', POLYMARKET_CONTRACTS.negRiskCtfExchange],
  ['pUSD', POLYMARKET_CONTRACTS.pUsd],
  ['pUSD implementation', POLYMARKET_CONTRACTS.pUsdImplementation],
  ['CollateralOnramp', POLYMARKET_CONTRACTS.collateralOnramp],
  ['Conditional Tokens', POLYMARKET_CONTRACTS.conditionalTokens],
  ['USDC.e', POLYMARKET_CONTRACTS.usdcE]
] as const;

interface SdkProductionRuntime {
  name: string;
  chainId: number;
  clob: { rest: string };
  contracts: {
    collateralToken: string;
    conditionalTokens: string;
    standardExchange: string;
    negRiskExchange: string;
  };
  walletDerivation: {
    depositWalletFactory: string;
    depositWalletBeacon: string;
    depositWalletImplementation: string;
    proxyFactory: string;
    proxyImplementation: string;
    safeFactory: string;
  };
}

interface PolymarketStartupDependencies {
  resolveMode: () => Promise<{ effectiveMode: string; reason?: string | null }>;
  getNetwork: () => Promise<{ chainId: number }>;
  getCode: (address: string) => Promise<string>;
  initializeClient: () => Promise<PolymarketClientInitialization>;
  createCollateralGateway: (directWalletWritesAllowed: boolean) => PolymarketCollateralGateway;
  getAuthenticatedCollateralBalance: () => Promise<number>;
  setLiveReadiness: (ready: boolean, reason?: string) => void;
  sdkProduction: unknown;
  clobHost: string;
  env: NodeJS.ProcessEnv;
}

export function parseBooleanEnvironment(
  value: string | undefined,
  name: string,
  fallback = false
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

export function parseUsdUnits(value: string | undefined, name: string, fallback: string): bigint {
  const raw = value?.trim() || fallback;
  let units: ethers.BigNumber;
  try {
    units = ethers.utils.parseUnits(raw, 6);
  } catch {
    throw new Error(`${name} must be a non-negative decimal with at most 6 places`);
  }
  if (units.lt(0)) throw new Error(`${name} cannot be negative`);
  return BigInt(units.toString());
}

export function parseFeeBufferBps(value: string | undefined): bigint {
  const parsed = Number(value?.trim() || '300');
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5000) {
    throw new Error('POLYMARKET_FEE_BUFFER_BPS must be an integer between 0 and 5000');
  }
  return BigInt(parsed);
}

function parseOfficialOrigin(value: unknown, label: string): URL {
  if (typeof value !== 'string') {
    throw new Error(`${label} is missing from the pinned Polymarket SDK production environment`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'clob.polymarket.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`${label} is not the official production CLOB origin`);
  }
  return url;
}

function assertMatchingAddress(name: string, sdkAddress: unknown, expectedAddress: string): void {
  let actual: string;
  let expected: string;
  try {
    if (typeof sdkAddress !== 'string') throw new Error('missing');
    actual = ethers.utils.getAddress(sdkAddress);
    expected = ethers.utils.getAddress(expectedAddress);
  } catch {
    throw new Error(`${name} has an invalid or missing address in the SDK production inventory`);
  }
  if (actual !== expected) {
    throw new Error(`${name} does not match the pinned SDK production address`);
  }
}

export function assertOfficialPolymarketContractConfig(
  sdkEnvironment: unknown = production,
  clobHost = POLYMARKET_CLOB_HOST
): void {
  if (typeof sdkEnvironment !== 'object' || sdkEnvironment === null) {
    throw new Error('Pinned Polymarket SDK production environment is unavailable');
  }
  const sdk = sdkEnvironment as Partial<SdkProductionRuntime>;
  if (sdk.name !== 'production' || sdk.chainId !== POLYGON_CHAIN_ID) {
    throw new Error('Pinned Polymarket SDK production environment is not Polygon 137');
  }

  parseOfficialOrigin(sdk.clob?.rest, 'SDK production CLOB endpoint');
  parseOfficialOrigin(clobHost, 'Executor CLOB endpoint');

  assertMatchingAddress(
    'CTF Exchange V2',
    sdk.contracts?.standardExchange,
    POLYMARKET_CONTRACTS.ctfExchange
  );
  assertMatchingAddress(
    'Neg Risk CTF Exchange V2',
    sdk.contracts?.negRiskExchange,
    POLYMARKET_CONTRACTS.negRiskCtfExchange
  );
  assertMatchingAddress('pUSD', sdk.contracts?.collateralToken, POLYMARKET_CONTRACTS.pUsd);
  assertMatchingAddress(
    'Conditional Tokens',
    sdk.contracts?.conditionalTokens,
    POLYMARKET_CONTRACTS.conditionalTokens
  );
  assertMatchingAddress(
    'Polymarket Proxy Factory',
    sdk.walletDerivation?.proxyFactory,
    POLYMARKET_CONTRACTS.proxyFactory
  );
  assertMatchingAddress(
    'Polymarket Proxy implementation',
    sdk.walletDerivation?.proxyImplementation,
    POLYMARKET_CONTRACTS.proxyImplementation
  );
  assertMatchingAddress(
    'Gnosis Safe Factory',
    sdk.walletDerivation?.safeFactory,
    POLYMARKET_CONTRACTS.safeFactory
  );
  assertMatchingAddress(
    'Deposit Wallet Factory',
    sdk.walletDerivation?.depositWalletFactory,
    POLYMARKET_CONTRACTS.depositWalletFactory
  );
  assertMatchingAddress(
    'Deposit Wallet Beacon',
    sdk.walletDerivation?.depositWalletBeacon,
    POLYMARKET_CONTRACTS.depositWalletBeacon
  );
  assertMatchingAddress(
    'Deposit Wallet implementation',
    sdk.walletDerivation?.depositWalletImplementation,
    POLYMARKET_CONTRACTS.depositWalletImplementation
  );

  const normalizedAddresses = new Set<string>();
  for (const [name, address] of Object.entries(POLYMARKET_CONTRACTS)) {
    let normalized: string;
    try {
      normalized = ethers.utils.getAddress(address).toLowerCase();
    } catch {
      throw new Error(`${name} has an invalid address in the official contract inventory`);
    }
    if (normalizedAddresses.has(normalized)) {
      throw new Error(`${name} duplicates another address in the official contract inventory`);
    }
    normalizedAddresses.add(normalized);
  }
}

export function assertPolymarketContractBytecode(
  name: string,
  address: string,
  code: string
): void {
  const validHex = /^0x(?:[0-9a-fA-F]{2})+$/.test(code);
  const hasExecutableBytes = validHex && !/^0x(?:00)+$/i.test(code);
  if (!hasExecutableBytes) {
    throw new Error(`${name} has no deployed bytecode at ${address}`);
  }
}

async function attestDeployedContract(
  getCode: (address: string) => Promise<string>,
  name: string,
  address: string
): Promise<void> {
  const code = await getCode(address);
  assertPolymarketContractBytecode(name, address, code);
}

function accountWalletPathContracts(
  signatureTypeName: PolymarketClientInitialization['signatureTypeName']
): ReadonlyArray<readonly [string, string]> {
  switch (signatureTypeName) {
    case 'EOA':
      return [];
    case 'POLY_PROXY':
      return [
        ['Polymarket Proxy Factory', POLYMARKET_CONTRACTS.proxyFactory],
        ['Polymarket Proxy implementation', POLYMARKET_CONTRACTS.proxyImplementation]
      ];
    case 'POLY_GNOSIS_SAFE':
      return [['Gnosis Safe Factory', POLYMARKET_CONTRACTS.safeFactory]];
    case 'POLY_1271':
      return [
        ['Deposit Wallet Factory', POLYMARKET_CONTRACTS.depositWalletFactory],
        ['Deposit Wallet Beacon', POLYMARKET_CONTRACTS.depositWalletBeacon],
        ['Deposit Wallet implementation', POLYMARKET_CONTRACTS.depositWalletImplementation]
      ];
  }
}

async function attestAccountWalletPath(
  getCode: (address: string) => Promise<string>,
  identity: PolymarketClientInitialization
): Promise<void> {
  const signer = ethers.utils.getAddress(identity.signerAddress);
  const funder = ethers.utils.getAddress(identity.funderAddress);
  const funderCode = await getCode(funder);
  const funderHasCode = /^0x(?:[0-9a-fA-F]{2})+$/.test(funderCode) && !/^0x(?:00)+$/i.test(funderCode);

  if (identity.signatureTypeName === 'EOA') {
    if (!identity.directWalletWritesAllowed || signer !== funder) {
      throw new Error('EOA account wallet path does not resolve directly to the authenticated signer');
    }
    if (funderHasCode) {
      throw new Error('EOA signature mode resolved to a contract account wallet');
    }
    return;
  }

  if (identity.directWalletWritesAllowed) {
    throw new Error(`${identity.signatureTypeName} account wallet path cannot permit signer EOA writes`);
  }
  assertPolymarketContractBytecode('authenticated account wallet', funder, funderCode);
  await Promise.all(
    accountWalletPathContracts(identity.signatureTypeName).map(([name, address]) =>
      attestDeployedContract(getCode, name, address)
    )
  );
}

export function assertAuthenticatedCollateralBalance(
  authenticatedBalanceUsd: number,
  pUsdBalanceUnits: bigint,
  minimumPusdUnits: bigint
): void {
  if (!Number.isFinite(authenticatedBalanceUsd) || authenticatedBalanceUsd < 0) {
    throw new Error('Authenticated CLOB returned an invalid collateral balance');
  }
  const onchainBalanceUsd = Number(ethers.utils.formatUnits(pUsdBalanceUnits.toString(), 6));
  const minimumBalanceUsd = Number(ethers.utils.formatUnits(minimumPusdUnits.toString(), 6));
  if (!Number.isFinite(onchainBalanceUsd) || !Number.isFinite(minimumBalanceUsd)) {
    throw new Error('pUSD balance exceeds the supported startup attestation range');
  }
  if (authenticatedBalanceUsd + 0.0000001 < minimumBalanceUsd) {
    throw new Error('Authenticated CLOB collateral balance is below the configured live minimum');
  }
  if (authenticatedBalanceUsd > onchainBalanceUsd + 0.0000001) {
    throw new Error('Authenticated CLOB collateral balance exceeds the attested onchain pUSD balance');
  }
}

function defaultStartupDependencies(): PolymarketStartupDependencies {
  return {
    resolveMode: () => resolveChainMode('polygon'),
    getNetwork: () => polygonProvider.getNetwork(),
    getCode: (address) => polygonProvider.getCode(address),
    initializeClient: () => initializePolymarketClient(),
    createCollateralGateway: (directWalletWritesAllowed) =>
      new EthersPolymarketCollateralGateway(
        polygonProvider,
        directWalletWritesAllowed ? polymarketSigner : null
      ),
    getAuthenticatedCollateralBalance: () => getPolymarketAvailableBalance('', 'buy'),
    setLiveReadiness: setPolymarketLiveReadiness,
    sdkProduction: production,
    clobHost: POLYMARKET_CLOB_HOST,
    env: process.env
  };
}

export async function verifyPolymarketEnvironment(
  overrides: Partial<PolymarketStartupDependencies> = {}
): Promise<boolean> {
  const dependencies = { ...defaultStartupDependencies(), ...overrides };
  dependencies.setLiveReadiness(false, 'Polymarket startup verification is in progress');
  console.log('[trade-executor] Verifying Polymarket CLOB V2 environment...');

  try {
    const mode = await dependencies.resolveMode();
    if (mode.effectiveMode !== 'live' && mode.effectiveMode !== 'live+shadow') {
      dependencies.setLiveReadiness(
        false,
        mode.reason ?? 'Polygon is not configured for live execution'
      );
      return false;
    }

    const network = await dependencies.getNetwork();
    if (network.chainId !== POLYGON_CHAIN_ID) {
      throw new Error(`Expected Polygon chain ID ${POLYGON_CHAIN_ID}, got ${network.chainId}`);
    }
    assertOfficialPolymarketContractConfig(dependencies.sdkProduction, dependencies.clobHost);
    await Promise.all(
      CORE_ATTESTED_CONTRACTS.map(([name, address]) =>
        attestDeployedContract(dependencies.getCode, name, address)
      )
    );

    const identity = await dependencies.initializeClient();
    await attestAccountWalletPath(dependencies.getCode, identity);

    const minimumPusdUnits = parseUsdUnits(
      dependencies.env.POLYMARKET_MIN_PUSD_BALANCE_USD,
      'POLYMARKET_MIN_PUSD_BALANCE_USD',
      '1'
    );
    const baseAllowanceUnits = parseUsdUnits(
      dependencies.env.POLYMARKET_ALLOWANCE_CAP_USD ?? dependencies.env.MAX_POSITION_USDC,
      'POLYMARKET_ALLOWANCE_CAP_USD',
      '500'
    );
    const feeBufferBps = parseFeeBufferBps(dependencies.env.POLYMARKET_FEE_BUFFER_BPS);
    const allowanceCapUnits =
      (baseAllowanceUnits * (10_000n + feeBufferBps) + 9_999n) / 10_000n;

    const gateway = dependencies.createCollateralGateway(identity.directWalletWritesAllowed);
    const collateral = await ensurePolymarketCollateralReadiness(gateway, {
      funderAddress: identity.funderAddress,
      signerAddress: identity.signerAddress,
      accountWalletType: identity.signatureTypeName,
      directWalletWritesAllowed: identity.directWalletWritesAllowed,
      minimumPusdUnits,
      allowanceCapUnits,
      autoOnramp: parseBooleanEnvironment(
        dependencies.env.POLYMARKET_AUTO_ONRAMP,
        'POLYMARKET_AUTO_ONRAMP'
      ),
      autoApprove: parseBooleanEnvironment(
        dependencies.env.POLYMARKET_AUTO_APPROVE,
        'POLYMARKET_AUTO_APPROVE'
      )
    });

    const authenticatedBalanceUsd = await dependencies.getAuthenticatedCollateralBalance();
    assertAuthenticatedCollateralBalance(
      authenticatedBalanceUsd,
      collateral.pUsdBalanceUnits,
      minimumPusdUnits
    );

    for (const action of collateral.actions) {
      console.log(
        `[trade-executor] Polymarket collateral action confirmed: ${action.type} | ${action.transactionHash}`
      );
    }

    dependencies.setLiveReadiness(true);
    console.log(
      `[trade-executor] Polymarket CLOB V2 verified | chain=137 | sdk=${POLYMARKET_SDK_VERSION} | ` +
      `signer=${identity.signerAddress} | funder=${identity.funderAddress} | ` +
      `signatureType=${identity.signatureTypeName} | credentials=${identity.credentialSource} | ` +
      `builderAuth=${identity.builderAuthentication} | ` +
      `builderFees=${identity.builderMakerFeeBps}/${identity.builderTakerFeeBps}bps | ` +
      `builderAttribution=enabled`
    );
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.setLiveReadiness(false, message);
    console.error(
      `[trade-executor] CRITICAL: Polymarket verification failed: ${message}. Polygon is clamped to paper.`
    );
    throw new Error(`Polymarket verification failed: ${message}`);
  }
}
