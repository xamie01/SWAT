export function buildEvmRebalancePlan(port, input) {
    if (!input.position.onChainPositionAddress) {
        throw new Error('cannot rebalance a position that has no on-chain address yet');
    }
    return (async () => {
        const closeSteps = await port.buildCloseSteps({ onChainPositionAddress: input.position.onChainPositionAddress });
        const remintSteps = await port.buildRemintSteps(input.plan, input.recipient);
        const swapStep = {
            sequence: 0,
            kind: 'swap',
            description: 're-center inventory for the new range (executor computes leg ratio)',
            payload: { poolAddress: input.position.poolAddress }
        };
        // Sequence is position-in-bundle, assigned here so port-returned steps
        // cannot carry stale ordering.
        const steps = [...closeSteps, swapStep, ...remintSteps].map((step, index) => ({ ...step, sequence: index }));
        return { steps, signReady: input.signReady };
    })();
}
//# sourceMappingURL=evm-rebalance.js.map