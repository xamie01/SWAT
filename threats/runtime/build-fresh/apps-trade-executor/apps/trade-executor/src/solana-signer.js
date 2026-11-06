import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getActiveRpcUrl } from '@swat/shared';
function loadKeypair(privateKeyBase58) {
    let decoded;
    try {
        decoded = bs58.decode(privateKeyBase58);
    }
    catch {
        // Never echo the key material, even partially, in the error.
        throw new Error('SOLANA_PRIVATE_KEY is not valid base58');
    }
    if (decoded.length !== 64) {
        throw new Error(`SOLANA_PRIVATE_KEY must decode to 64 bytes, got ${decoded.length}`);
    }
    return Keypair.fromSecretKey(decoded);
}
export function createSolanaSigner(options) {
    const keypair = loadKeypair(options.privateKeyBase58);
    const connection = new Connection(options.rpcUrl, 'confirmed');
    const publicKey = keypair.publicKey.toBase58();
    return {
        publicKey,
        async sign(transactionBase64) {
            const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
            // `sign` appends to the existing signature array rather than replacing it,
            // so a partially-signed transaction from Jupiter keeps its other signers.
            transaction.sign([keypair]);
            return Buffer.from(transaction.serialize()).toString('base64');
        },
        async buildTip({ tipAccount, lamports }) {
            if (!Number.isInteger(lamports) || lamports <= 0) {
                // A zero tip never lands, and a fractional one throws deep inside
                // web3.js with a far less legible message.
                throw new Error(`Tip must be a positive integer lamport amount, got ${lamports}`);
            }
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const message = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: blockhash,
                instructions: [
                    SystemProgram.transfer({
                        fromPubkey: keypair.publicKey,
                        toPubkey: new PublicKey(tipAccount),
                        lamports
                    })
                ]
            }).compileToV0Message();
            const transaction = new VersionedTransaction(message);
            transaction.sign([keypair]);
            return Buffer.from(transaction.serialize()).toString('base64');
        },
        async getBlockHeight() {
            return connection.getBlockHeight('confirmed');
        }
    };
}
/**
 * Builds the signer from the environment, or returns null when unconfigured.
 *
 * Null rather than throwing: paper mode must run on a box with no Solana key,
 * and that is the default posture. The absence is only an error at the point
 * something actually tries to execute live, where `resolveChainMode` already
 * clamps to paper with a stated reason.
 */
export function createSolanaSignerFromEnvironment() {
    const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyBase58)
        return null;
    const rpcUrl = process.env.SOLANA_RPC_URL
        ?? (process.env.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
            : getActiveRpcUrl('solana'));
    return createSolanaSigner({ privateKeyBase58, rpcUrl });
}
//# sourceMappingURL=solana-signer.js.map