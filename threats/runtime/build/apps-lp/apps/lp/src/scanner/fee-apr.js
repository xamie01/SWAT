export function realizedFeeApr(input) {
    const tvl = input.tvl;
    if (!Number.isFinite(tvl) || tvl <= 0) {
        return { feeApr24h: null, feeApr7d: null };
    }
    if (!Number.isFinite(input.fees24h) || input.fees24h < 0) {
        return { feeApr24h: null, feeApr7d: null };
    }
    const feeApr7d = input.fees7d === null || !Number.isFinite(input.fees7d) || input.fees7d < 0
        ? null
        : input.fees7d / tvl;
    return {
        feeApr24h: input.fees24h / tvl,
        feeApr7d
    };
}
//# sourceMappingURL=fee-apr.js.map