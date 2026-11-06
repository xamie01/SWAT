import { ethers } from 'ethers';
export const POLYMARKET_CONTRACTS = Object.freeze({
    ctfExchange: '0xE111180000d2663C0091e4f400237545B87B996B',
    negRiskCtfExchange: '0xe2222d279d744050d28e00520010520000310F59',
    conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    pUsd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    pUsdImplementation: '0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f',
    collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
    usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    proxyFactory: '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052',
    proxyImplementation: '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f',
    safeFactory: '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b',
    depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
    depositWalletBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
    depositWalletImplementation: '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB'
});
const ERC20_ABI = [
    'function decimals() view returns (uint8)',
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];
const ONRAMP_ABI = [
    'function wrap(address asset, address to, uint256 amount)'
];
const CONDITIONAL_TOKENS_ABI = [
    'function isApprovedForAll(address account, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)'
];
function assertNonNegative(value, name) {
    if (value < 0n)
        throw new Error(`${name} cannot be negative`);
}
async function approveExact(current, required, read, approve, actionType, actions) {
    if (current === required)
        return;
    if (current > 0n) {
        actions.push({ type: `${actionType}-reset`, transactionHash: await approve(0n) });
        const resetAllowance = await read();
        if (resetAllowance !== 0n) {
            throw new Error(`${actionType} allowance did not reset to zero`);
        }
    }
    actions.push({ type: actionType, transactionHash: await approve(required) });
    const confirmedAllowance = await read();
    if (confirmedAllowance !== required) {
        throw new Error(`${actionType} allowance did not confirm at the configured exact cap`);
    }
}
function normalizeAddress(address, label) {
    try {
        return ethers.utils.getAddress(address);
    }
    catch {
        throw new Error(`${label} must be a valid EVM address`);
    }
}
function manualWalletInstruction(options, action) {
    return (`${options.accountWalletType} account wallet ${options.funderAddress} requires ${action}; ` +
        `complete it through that account wallet rather than signer ${options.signerAddress}`);
}
function assertWalletWritePath(options) {
    const signer = normalizeAddress(options.signerAddress, 'signerAddress');
    const funder = normalizeAddress(options.funderAddress, 'funderAddress');
    const isEoa = options.accountWalletType === 'EOA';
    if (options.directWalletWritesAllowed !== isEoa) {
        throw new Error('direct wallet writes are permitted only for an EOA account wallet');
    }
    if (isEoa && signer !== funder) {
        throw new Error('EOA collateral setup requires signerAddress and funderAddress to match');
    }
    if (!isEoa && (options.autoOnramp || options.autoApprove)) {
        throw new Error(manualWalletInstruction(options, 'manual collateral and approval setup because automatic setup is EOA-only'));
    }
}
function assertSixDecimalCollateral(pUsdDecimals, usdcEDecimals) {
    if (pUsdDecimals !== 6) {
        throw new Error(`pUSD decimals mismatch: expected 6, got ${pUsdDecimals}`);
    }
    if (usdcEDecimals !== 6) {
        throw new Error(`USDC.e decimals mismatch: expected 6, got ${usdcEDecimals}`);
    }
}
export async function ensurePolymarketCollateralReadiness(gateway, options) {
    assertWalletWritePath(options);
    assertNonNegative(options.minimumPusdUnits, 'minimumPusdUnits');
    assertNonNegative(options.allowanceCapUnits, 'allowanceCapUnits');
    if (options.minimumPusdUnits === 0n) {
        throw new Error('minimumPusdUnits must be greater than zero for live execution');
    }
    if (options.allowanceCapUnits === 0n) {
        throw new Error('allowanceCapUnits must be greater than zero for live execution');
    }
    if (options.minimumPusdUnits > options.allowanceCapUnits) {
        throw new Error('minimumPusdUnits cannot exceed the bounded allowanceCapUnits');
    }
    const [pUsdDecimals, usdcEDecimals] = await Promise.all([
        gateway.getPusdDecimals(),
        gateway.getUsdcEDecimals()
    ]);
    assertSixDecimalCollateral(pUsdDecimals, usdcEDecimals);
    const actions = [];
    let pUsdBalance = await gateway.getPusdBalance(options.funderAddress);
    assertNonNegative(pUsdBalance, 'pUSD balance');
    if (pUsdBalance < options.minimumPusdUnits) {
        if (!options.autoOnramp) {
            if (!options.directWalletWritesAllowed) {
                throw new Error(manualWalletInstruction(options, 'manual pUSD funding to reach the configured live minimum'));
            }
            throw new Error('pUSD balance is below the configured live minimum; fund it manually or explicitly enable POLYMARKET_AUTO_ONRAMP=true');
        }
        const amount = options.minimumPusdUnits - pUsdBalance;
        const usdcEBalance = await gateway.getUsdcEBalance(options.signerAddress);
        assertNonNegative(usdcEBalance, 'USDC.e balance');
        if (usdcEBalance < amount) {
            throw new Error('USDC.e balance cannot cover the exact pUSD onramp amount');
        }
        const usdcEAllowance = await gateway.getUsdcEAllowance(options.signerAddress, POLYMARKET_CONTRACTS.collateralOnramp);
        await approveExact(usdcEAllowance, amount, () => gateway.getUsdcEAllowance(options.signerAddress, POLYMARKET_CONTRACTS.collateralOnramp), (value) => gateway.approveUsdcE(POLYMARKET_CONTRACTS.collateralOnramp, value), 'approve-usdce-onramp', actions);
        actions.push({
            type: 'wrap-usdce-to-pusd',
            transactionHash: await gateway.wrapUsdcE(options.funderAddress, amount)
        });
        pUsdBalance = await gateway.getPusdBalance(options.funderAddress);
        assertNonNegative(pUsdBalance, 'pUSD balance');
        if (pUsdBalance < options.minimumPusdUnits) {
            throw new Error('pUSD balance remained below the live minimum after onramp confirmation');
        }
    }
    for (const exchange of [POLYMARKET_CONTRACTS.ctfExchange, POLYMARKET_CONTRACTS.negRiskCtfExchange]) {
        const allowance = await gateway.getPusdAllowance(options.funderAddress, exchange);
        assertNonNegative(allowance, `pUSD allowance for ${exchange}`);
        if (allowance !== options.allowanceCapUnits) {
            if (!options.autoApprove) {
                const relation = allowance < options.allowanceCapUnits ? 'below' : 'above';
                if (!options.directWalletWritesAllowed) {
                    throw new Error(manualWalletInstruction(options, `an exact pUSD allowance of ${options.allowanceCapUnits} units for exchange ${exchange}; current allowance is ${relation} the cap`));
                }
                throw new Error(`pUSD allowance is ${relation} the configured exact cap for exchange ${exchange}; ` +
                    'set it manually or explicitly enable POLYMARKET_AUTO_APPROVE=true');
            }
            await approveExact(allowance, options.allowanceCapUnits, () => gateway.getPusdAllowance(options.funderAddress, exchange), (value) => gateway.approvePusd(exchange, value), 'approve-pusd-exchange', actions);
        }
        const conditionalApproved = await gateway.isConditionalTokenApproved(options.funderAddress, exchange);
        if (!conditionalApproved) {
            if (!options.autoApprove) {
                if (!options.directWalletWritesAllowed) {
                    throw new Error(manualWalletInstruction(options, `manual Conditional Tokens operator approval for exchange ${exchange}`));
                }
                throw new Error(`conditional-token sell approval is missing for exchange ${exchange}; ` +
                    'set it manually or explicitly enable POLYMARKET_AUTO_APPROVE=true');
            }
            actions.push({
                type: 'approve-conditional-token-exchange',
                transactionHash: await gateway.approveConditionalTokenOperator(exchange)
            });
            if (!await gateway.isConditionalTokenApproved(options.funderAddress, exchange)) {
                throw new Error(`conditional-token approval did not confirm for exchange ${exchange}`);
            }
        }
    }
    return {
        pUsdBalanceUnits: pUsdBalance,
        allowanceCapUnits: options.allowanceCapUnits,
        actions
    };
}
function asBigInt(value) {
    return BigInt(value.toString());
}
async function waitForSuccess(transaction) {
    const receipt = await transaction.wait(1);
    if (receipt.status !== 1) {
        throw new Error(`Polymarket collateral transaction failed: ${transaction.hash}`);
    }
    return transaction.hash;
}
export class EthersPolymarketCollateralGateway {
    pUsdRead;
    usdcERead;
    conditionalTokensRead;
    pUsdWrite;
    usdcEWrite;
    conditionalTokensWrite;
    onrampWrite;
    constructor(provider, signer) {
        this.pUsdRead = new ethers.Contract(POLYMARKET_CONTRACTS.pUsd, ERC20_ABI, provider);
        this.usdcERead = new ethers.Contract(POLYMARKET_CONTRACTS.usdcE, ERC20_ABI, provider);
        this.conditionalTokensRead = new ethers.Contract(POLYMARKET_CONTRACTS.conditionalTokens, CONDITIONAL_TOKENS_ABI, provider);
        this.pUsdWrite = signer ? this.pUsdRead.connect(signer) : null;
        this.usdcEWrite = signer ? this.usdcERead.connect(signer) : null;
        this.conditionalTokensWrite = signer ? this.conditionalTokensRead.connect(signer) : null;
        this.onrampWrite = signer
            ? new ethers.Contract(POLYMARKET_CONTRACTS.collateralOnramp, ONRAMP_ABI, signer)
            : null;
    }
    async getPusdDecimals() {
        return Number(await this.pUsdRead.decimals());
    }
    async getUsdcEDecimals() {
        return Number(await this.usdcERead.decimals());
    }
    async getPusdBalance(account) {
        return asBigInt(await this.pUsdRead.balanceOf(account));
    }
    async getUsdcEBalance(account) {
        return asBigInt(await this.usdcERead.balanceOf(account));
    }
    async getUsdcEAllowance(account, spender) {
        return asBigInt(await this.usdcERead.allowance(account, spender));
    }
    async approveUsdcE(spender, amount) {
        if (!this.usdcEWrite)
            throw new Error('No signer is configured for USDC.e approval');
        return waitForSuccess(await this.usdcEWrite.approve(spender, amount.toString()));
    }
    async wrapUsdcE(to, amount) {
        if (!this.onrampWrite)
            throw new Error('No signer is configured for the USDC.e onramp');
        return waitForSuccess(await this.onrampWrite.wrap(POLYMARKET_CONTRACTS.usdcE, to, amount.toString()));
    }
    async getPusdAllowance(account, spender) {
        return asBigInt(await this.pUsdRead.allowance(account, spender));
    }
    async approvePusd(spender, amount) {
        if (!this.pUsdWrite)
            throw new Error('No signer is configured for pUSD approval');
        return waitForSuccess(await this.pUsdWrite.approve(spender, amount.toString()));
    }
    async isConditionalTokenApproved(account, operator) {
        return this.conditionalTokensRead.isApprovedForAll(account, operator);
    }
    async approveConditionalTokenOperator(operator) {
        if (!this.conditionalTokensWrite) {
            throw new Error('No signer is configured for conditional-token approval');
        }
        return waitForSuccess(await this.conditionalTokensWrite.setApprovalForAll(operator, true));
    }
}
//# sourceMappingURL=polymarket-collateral.js.map