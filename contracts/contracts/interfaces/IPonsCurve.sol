// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IPonsCurve
 * @notice The bonding-curve interface Pons launches trade on, established by
 * PROBING MAINNET rather than from documentation — Pons publishes no ABI.
 *
 * Every selector below was confirmed present in the runtime code of a live
 * 10,229-byte curve on Robinhood Chain 4663, and `buy` was additionally
 * confirmed by an `eth_call` simulation that returned a plausible token amount.
 * If Pons ever changes this shape, calls will revert rather than misbehave: a
 * missing selector hits the fallback and reverts, and a changed argument order
 * would move a value the adapter checks the result of.
 */
interface IPonsCurve {
    /// @notice The launched ERC-20 this curve sells. Selector 0xfc0c546a.
    function token() external view returns (address);

    /**
     * @notice What the curve is priced in. `address(0)` means NATIVE ETH.
     * Selector 0x3de35b79.
     *
     * Load-bearing rather than trivia: 53.6% of launches are native-quoted and
     * this adapter refuses every one of them, deliberately — see the header of
     * PonsSelfTrade.sol.
     */
    function pairToken() external view returns (address);

    /**
     * @notice Has this curve already graduated to a Uniswap pool? Selector
     * 0xe7c2b772.
     *
     * MUST be checked before trading. A graduated curve resets — token side
     * drained, quote side back to its virtual seed — so `getReserves()` reports
     * what looks like a live market with a healthy quote balance. Nothing in the
     * reserve words says the market has moved somewhere else.
     */
    function graduated() external view returns (bool);

    /**
     * @notice Reserves as (quote, token). Selector 0x0902f1ac.
     *
     * TWO words, not Uniswap V2's three — there is no `blockTimestampLast`. A
     * decoder written against the V2 shape reads the first two correctly and
     * then garbage.
     */
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);

    /**
     * @notice Buy the launched token with the quote asset. Selector 0x59a87bc1.
     *
     * PAYABLE, and for a native-quoted curve `msg.value` must equal `quoteIn`
     * EXACTLY — it reverts `NativeValueMismatch` otherwise, takes no change and
     * gives none. This adapter never sends value, so it only ever reaches the
     * ERC-20 branch, where the curve pulls `quoteIn` by `transferFrom`.
     */
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);

    /**
     * @notice Sell the launched token back for the quote asset. Selector
     * 0xd04c6983.
     *
     * Pulls `tokensIn` from the caller by `transferFrom`, so the caller must
     * have approved this curve. Pays `recipient` directly.
     */
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        returns (uint256 quoteOut);
}

/**
 * @title IERC20Trade
 * @notice The ERC-20 surface PonsSelfTrade needs.
 *
 * Separate from Uniswap's `IERC20Minimal` rather than widening it: that one is
 * a faithful copy of an upstream minimal interface and adding methods to it
 * would make it a copy of nothing. Return values are declared `bool` here but
 * every call site decodes defensively, because a memecoin's token contract is
 * whatever its creator wrote and plenty return nothing at all.
 */
interface IERC20Trade {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
