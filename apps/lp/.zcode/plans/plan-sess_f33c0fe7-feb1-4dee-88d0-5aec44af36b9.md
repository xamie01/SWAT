## Robinhood non-wallet production slice

1. Add a configurable stable-quote price fallback to the Robinhood pool fetcher:
   - Recognize the configured USDG address from `ROBINHOOD_SANITY_TOKEN` or an explicit option.
   - When no external `priceSource` is supplied and the pool’s quote token is that stable token, use quote price `$1` and derive token0 USD price from the live pool `currentPrice`.
   - Keep explicit `priceSource` values authoritative; never overwrite them.
   - Refuse to derive prices for unknown token pairs, preserving `activeTvlExact: false` rather than inventing a price.
2. Wire the fallback in `apps/lp/src/index.ts` using `ROBINHOOD_SANITY_TOKEN` and the configured pool RPC path.
3. Add focused tests for:
   - explicit price source precedence;
   - USDG quote fallback deriving base price from current pool price;
   - unknown pairs remaining unpriced.
4. Run the full LP test suite and typecheck.
5. Run a live read-only scan against only `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca`, reporting exact active TVL and confirming no wallet/execution paths are touched.

Scope remains pool discovery, live tick bands, and active TVL only. Do not implement wallet ownership, position NFTs, swaps, signing, or execution in this slice.