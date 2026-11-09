// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

/// @title SellCheck
/// @notice A read-only probe for Hyvo Check. It is never deployed: a single `eth_call` places its runtime
///         code at a throwaway address through a state override, with a made-up ETH balance, and nothing is
///         signed or broadcast. One call buys a token with ETH through one venue, sends a tenth of what
///         arrived to a fresh address, sells the rest back, and reports what every step promised and what
///         actually arrived.
/// @dev "Promised" is the venue's own math before each step: the router's or quoter's quote, the
///      constant-product curve after its published fee and taxes, or the swap delta the V4 pool reported.
///      A token that takes a tax, or blocks a transfer, shows up as a shortfall or a revert reason.
///      Exported with its ABI to packages/check/src/probe/sellcheck.json by chain/scripts/export-probe.mjs.

interface IV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata, address, uint256)
        external
        payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256, uint256, address[] calldata, address, uint256)
        external;
}

/// @dev The parts of a Pons v2 bonding curve (PonsV2BondingCurve, verified on Sourcify) that the probe uses.
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function currentSnipeTaxBps(address recipient) external view returns (uint256);
}

interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IV3Quoter {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function sync(address currency) external;
    function take(address currency, address to, uint256 amount) external;
}

interface IWETH {
    function deposit() external payable;
}

contract SellCheck {
    /// @notice What one round trip did. Amounts are raw integers in the token's or the quote's smallest unit.
    struct Result {
        bool buyOk;
        uint256 expectedBuy; // tokens the venue's own math promised for the buy (0 when unknown)
        uint256 gotBuy; // tokens that arrived
        uint256 buyGas;
        bytes buyErr;
        bool transferOk;
        uint256 transferSent; // a tenth of the tokens, sent to a fresh address
        uint256 transferArrived;
        bytes transferErr;
        bool approveOk;
        uint256 sellIn;
        uint256 expectedSell; // quote the venue's own math promised for sellIn (0 when unknown)
        bool sellOk;
        uint256 gotSell; // quote that arrived (ETH, or WETH on V3 and on V4 pools quoted in WETH)
        uint256 sellGas;
        bytes sellErr;
    }

    uint256 private constant BPS = 10_000;
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    receive() external payable {}

    // ---------- Uniswap V2 (and any V2 clone router) ----------

    /// @notice Buys `token` with `ethIn` through a Uniswap-V2-style Router02 and the token/WETH pair, then
    ///         sends a tenth away and sells the rest back for ETH.
    function checkV2(address router, address weth, address token, uint256 ethIn) external returns (Result memory r) {
        address[] memory buyPath = new address[](2);
        buyPath[0] = weth;
        buyPath[1] = token;
        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = weth;

        try IV2Router(router).getAmountsOut(ethIn, buyPath) returns (uint256[] memory a) {
            r.expectedBuy = a[1];
        } catch {}
        uint256 before = _bal(token, address(this));
        uint256 g = gasleft();
        (r.buyOk, r.buyErr) = router.call{value: ethIn}(
            abi.encodeCall(
                IV2Router.swapExactETHForTokensSupportingFeeOnTransferTokens,
                (0, buyPath, address(this), block.timestamp + 600)
            )
        );
        r.buyGas = g - gasleft();
        r.gotBuy = _gain(_bal(token, address(this)), before);
        if (!r.buyOk || r.gotBuy == 0) return r;
        delete r.buyErr;

        _transferTest(r, token);
        r.approveOk = _approve(token, router);
        r.sellIn = _bal(token, address(this));
        try IV2Router(router).getAmountsOut(r.sellIn, sellPath) returns (uint256[] memory a) {
            r.expectedSell = a[1];
        } catch {}
        uint256 ethBefore = address(this).balance;
        g = gasleft();
        (r.sellOk, r.sellErr) = router.call(
            abi.encodeCall(
                IV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens,
                (r.sellIn, 0, sellPath, address(this), block.timestamp + 600)
            )
        );
        r.sellGas = g - gasleft();
        if (r.sellOk) delete r.sellErr;
        r.gotSell = _gain(address(this).balance, ethBefore);
    }

    // ---------- Pons v2 bonding curve (native ETH quote) ----------

    /// @notice Buys `token` with `ethIn` on a Pons v2 bonding curve quoted in native ETH, then sends a tenth
    ///         away and sells the rest back to the curve.
    /// @dev The promise is the curve's own constant-product math after its fee, creator tax and current snipe
    ///      tax, which PonsV2BondingCurve takes from the quote leg (on the way in for a buy, on the way out for
    ///      a sell). When those rates cannot be read, the promises stay 0 (unknown).
    function checkPonsCurve(address curve, address token, uint256 ethIn) external returns (Result memory r) {
        (uint256 feeBps, uint256 taxBps, uint256 snipeBps, bool known) = _ponsRates(curve);
        (uint256 q0, uint256 t0) = IPonsCurve(curve).getReserves();
        if (known) {
            uint256 net = ethIn - (ethIn * feeBps) / BPS - (ethIn * taxBps) / BPS - (ethIn * snipeBps) / BPS;
            r.expectedBuy = (net * t0) / (q0 + net);
        }
        uint256 before = _bal(token, address(this));
        uint256 g = gasleft();
        (r.buyOk, r.buyErr) = curve.call{value: ethIn}(abi.encodeCall(IPonsCurve.buy, (ethIn, 1, address(this))));
        r.buyGas = g - gasleft();
        r.gotBuy = _gain(_bal(token, address(this)), before);
        if (!r.buyOk || r.gotBuy == 0) return r;
        delete r.buyErr;

        _transferTest(r, token);
        r.approveOk = _approve(token, curve);
        r.sellIn = _bal(token, address(this));
        (uint256 q1, uint256 t1) = IPonsCurve(curve).getReserves();
        if (known) {
            uint256 gross = (r.sellIn * q1) / (t1 + r.sellIn);
            r.expectedSell = gross - (gross * feeBps) / BPS - (gross * taxBps) / BPS;
        }
        uint256 ethBefore = address(this).balance;
        g = gasleft();
        (r.sellOk, r.sellErr) = curve.call(abi.encodeCall(IPonsCurve.sell, (r.sellIn, 1, address(this))));
        r.sellGas = g - gasleft();
        if (r.sellOk) delete r.sellErr;
        r.gotSell = _gain(address(this).balance, ethBefore);
    }

    // ---------- Uniswap V3 through SwapRouter02, quotes from QuoterV2 ----------

    /// @notice Buys `token` with `ethIn` through SwapRouter02 in the token/WETH pool of fee tier `fee`, then sends
    ///         a tenth away and sells the rest back for WETH. Quotes come from QuoterV2.
    function checkV3(address router, address quoter, address weth, address token, uint24 fee, uint256 ethIn)
        external
        returns (Result memory r)
    {
        try IV3Quoter(quoter).quoteExactInputSingle(IV3Quoter.QuoteExactInputSingleParams(weth, token, ethIn, fee, 0))
        returns (uint256 out, uint160, uint32, uint256) {
            r.expectedBuy = out;
        } catch {}
        uint256 before = _bal(token, address(this));
        uint256 g = gasleft();
        (r.buyOk, r.buyErr) = router.call{value: ethIn}(
            abi.encodeCall(
                IV3Router.exactInputSingle, (IV3Router.ExactInputSingleParams(weth, token, fee, address(this), ethIn, 0, 0))
            )
        );
        r.buyGas = g - gasleft();
        r.gotBuy = _gain(_bal(token, address(this)), before);
        if (!r.buyOk || r.gotBuy == 0) return r;
        delete r.buyErr;

        _transferTest(r, token);
        r.approveOk = _approve(token, router);
        r.sellIn = _bal(token, address(this));
        try IV3Quoter(quoter).quoteExactInputSingle(IV3Quoter.QuoteExactInputSingleParams(token, weth, r.sellIn, fee, 0))
        returns (uint256 out, uint160, uint32, uint256) {
            r.expectedSell = out;
        } catch {}
        uint256 wethBefore = _bal(weth, address(this));
        g = gasleft();
        (r.sellOk, r.sellErr) = router.call(
            abi.encodeCall(
                IV3Router.exactInputSingle,
                (IV3Router.ExactInputSingleParams(token, weth, fee, address(this), r.sellIn, 0, 0))
            )
        );
        r.sellGas = g - gasleft();
        if (r.sellOk) delete r.sellErr;
        r.gotSell = _gain(_bal(weth, address(this)), wethBefore);
    }

    // ---------- Uniswap V4 straight through the PoolManager (any hook) ----------

    /// @notice Buys the pool's token with `ethIn` straight through the V4 PoolManager `pm` (no router), then sends
    ///         a tenth away and sells the rest back.
    /// @param quoteIsCurrency0 Whether the quote (native ETH as address(0), or WETH) is `key.currency0`; the token
    ///        is the other side. A WETH quote is wrapped from the probe's ETH first.
    function checkV4(address pm, PoolKey calldata key, bool quoteIsCurrency0, address weth, uint256 ethIn)
        external
        returns (Result memory r)
    {
        address quote = quoteIsCurrency0 ? key.currency0 : key.currency1;
        address token = quoteIsCurrency0 ? key.currency1 : key.currency0;
        if (quote != address(0)) IWETH(weth).deposit{value: ethIn}();

        uint256 before = _bal(token, address(this));
        uint256 g = gasleft();
        bytes memory ret;
        (r.buyOk, ret) = pm.call(abi.encodeCall(IPoolManager.unlock, (abi.encode(key, quoteIsCurrency0, ethIn))));
        r.buyGas = g - gasleft();
        if (r.buyOk) {
            (int128 a0, int128 a1) = abi.decode(abi.decode(ret, (bytes)), (int128, int128));
            r.expectedBuy = uint256(uint128(quoteIsCurrency0 ? a1 : a0)); // what the pool said the probe gets
        } else {
            r.buyErr = ret;
        }
        r.gotBuy = _gain(_bal(token, address(this)), before);
        if (!r.buyOk || r.gotBuy == 0) return r;

        _transferTest(r, token);
        r.approveOk = true; // V4 settles by transfer, no approval
        r.sellIn = _bal(token, address(this));
        uint256 qBefore = quote == address(0) ? address(this).balance : _bal(quote, address(this));
        g = gasleft();
        (r.sellOk, ret) = pm.call(abi.encodeCall(IPoolManager.unlock, (abi.encode(key, !quoteIsCurrency0, r.sellIn))));
        r.sellGas = g - gasleft();
        if (r.sellOk) {
            (int128 a0, int128 a1) = abi.decode(abi.decode(ret, (bytes)), (int128, int128));
            r.expectedSell = uint256(uint128(quoteIsCurrency0 ? a0 : a1));
        } else {
            r.sellErr = ret;
        }
        uint256 qAfter = quote == address(0) ? address(this).balance : _bal(quote, address(this));
        r.gotSell = _gain(qAfter, qBefore);
    }

    /// @notice The PoolManager calls this back inside `unlock`: one exact-input swap, then settle and take.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        IPoolManager pm = IPoolManager(msg.sender);
        int256 delta = pm.swap(
            key,
            // amountIn is ETH the probe holds or a token balance, far below 2**255.
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
            ""
        );
        // A V4 BalanceDelta packs amount0 in the upper and amount1 in the lower 128 bits; the casts unpack it.
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 a0 = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 a1 = int128(delta);
        _settleOrTake(pm, key.currency0, a0);
        _settleOrTake(pm, key.currency1, a1);
        return abi.encode(a0, a1);
    }

    function _settleOrTake(IPoolManager pm, address currency, int128 amount) private {
        if (amount < 0) {
            // amount is negative here, so -amount fits in uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(uint128(-amount));
            if (currency == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(currency);
                (bool ok, bytes memory ret) =
                    currency.call(abi.encodeWithSignature("transfer(address,uint256)", address(pm), owed));
                require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "pay failed");
                pm.settle();
            }
        } else if (amount > 0) {
            // amount is positive here, so it fits in uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.take(currency, address(this), uint256(uint128(amount)));
        }
    }

    // ---------- helpers ----------

    /// @dev The fee, creator tax and current snipe tax of a Pons v2 curve, the snipe tax capped the way
    ///      PonsV2BondingCurve caps it (the combined take leaves the buyer at least 1%).
    function _ponsRates(address curve) private view returns (uint256 feeBps, uint256 taxBps, uint256 snipeBps, bool known) {
        try IPonsCurve(curve).feeBps() returns (uint256 f) {
            feeBps = f;
        } catch {
            return (0, 0, 0, false);
        }
        try IPonsCurve(curve).creatorTaxBps() returns (uint256 t) {
            taxBps = t;
        } catch {
            return (0, 0, 0, false);
        }
        try IPonsCurve(curve).currentSnipeTaxBps(address(this)) returns (uint256 s) {
            snipeBps = s;
        } catch {
            return (0, 0, 0, false);
        }
        if (feeBps + taxBps + 100 > BPS) return (0, 0, 0, false);
        if (snipeBps != 0) {
            uint256 maxSnipe = BPS - feeBps - taxBps - 100;
            if (snipeBps > maxSnipe) snipeBps = maxSnipe;
        }
        known = true;
    }

    function _transferTest(Result memory r, address token) private {
        address sink = address(uint160(uint256(keccak256("hyvo.sellcheck.sink"))));
        r.transferSent = r.gotBuy / 10;
        uint256 before = _bal(token, sink);
        bytes memory ret;
        (r.transferOk, ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", sink, r.transferSent));
        if (r.transferOk && !_returnedTrue(ret)) r.transferOk = false;
        if (!r.transferOk) r.transferErr = ret;
        r.transferArrived = _gain(_bal(token, sink), before);
    }

    function _approve(address token, address spender) private returns (bool) {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        return ok && _returnedTrue(ret);
    }

    /// @dev An ERC-20 call succeeded when it returned nothing or a word equal to 1. Anything else, including a
    ///      short or malformed answer from a hostile token, counts as false instead of reverting the probe.
    function _returnedTrue(bytes memory ret) private pure returns (bool) {
        if (ret.length == 0) return true;
        return ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
    }

    /// @dev How much a balance grew; zero when it shrank, so a hostile token cannot revert the probe.
    function _gain(uint256 afterBalance, uint256 beforeBalance) private pure returns (uint256) {
        return afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
    }

    function _bal(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }
}
