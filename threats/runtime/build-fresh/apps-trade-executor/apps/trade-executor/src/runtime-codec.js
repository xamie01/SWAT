const TYPE_KEY = '__swatRuntimeType';
export function encodeRuntimeValue(value) {
    return JSON.stringify(value, function (key, current) {
        const original = key === '' ? value : this[key];
        if (original instanceof Date) {
            return { [TYPE_KEY]: 'date', value: original.toISOString() };
        }
        if (typeof original === 'bigint') {
            return { [TYPE_KEY]: 'bigint', value: original.toString() };
        }
        return current;
    });
}
export function decodeRuntimeValue(encoded) {
    return JSON.parse(encoded, (_key, current) => {
        if (!current || typeof current !== 'object')
            return current;
        const tagged = current;
        if (tagged[TYPE_KEY] === 'date' && typeof tagged.value === 'string') {
            const date = new Date(tagged.value);
            if (!Number.isFinite(date.getTime()))
                throw new Error('Stored runtime state contains an invalid date');
            return date;
        }
        if (tagged[TYPE_KEY] === 'bigint' && typeof tagged.value === 'string' && /^-?\d+$/.test(tagged.value)) {
            return BigInt(tagged.value);
        }
        return current;
    });
}
//# sourceMappingURL=runtime-codec.js.map