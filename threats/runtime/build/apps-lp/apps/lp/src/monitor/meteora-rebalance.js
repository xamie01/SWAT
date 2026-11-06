export async function buildMeteoraRebalancePlan(port, input) {
    if (!input.position.onChainPositionAddress) {
        throw new Error('cannot rebalance a position that has no on-chain address yet');
    }
    const removeSteps = await port.buildRemoveSteps(input.position);
    const addSteps = await port.buildAddSteps(input.plan, input.position.poolAddress, input.userAddress);
    let sequence = 0;
    const steps = [...removeSteps, ...addSteps].map((step) => ({
        ...step,
        sequence: sequence++
    }));
    return { steps, signReady: input.signReady };
}
//# sourceMappingURL=meteora-rebalance.js.map