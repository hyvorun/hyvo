// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HyvoV2Pair
/// @notice Uniswap-V2-style constant-product pair with a fixed per-pair fee, used as the market of a
///         per-job anvil world. Liquidity shares are the ERC-20 "Hyvo V2 LP" (HYVO-V2-LP).
/// @dev As in Uniswap V2, callers send tokens to the pair first and then call `mint` or `swap` (or send
///      LP shares and call `burn`). Differences from Uniswap V2: the fee is set per pair in basis points,
///      the first `MINIMUM_LIQUIDITY` shares are locked at 0x...dEaD (OpenZeppelin's ERC20 cannot mint to
///      the zero address), and there is no factory, flash-swap callback, price accumulator, protocol fee
///      or `skim`.
contract HyvoV2Pair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice LP shares locked forever by the first mint.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 private constant MAX_FEE_BPS = 1000;
    uint256 private constant BPS = 10_000;

    /// @notice The token with the lower address.
    address public immutable token0;
    /// @notice The token with the higher address.
    address public immutable token1;
    /// @notice Swap fee taken from the input amount, in basis points (30 = 0.30%).
    uint16 public immutable feeBps;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    /// @notice Both constructor tokens are the same address.
    error IdenticalTokens();
    /// @notice A constructor token is the zero address.
    error ZeroAddress();
    /// @notice The fee is above 1000 bps (10%).
    error FeeTooHigh(uint16 feeBps);
    /// @notice The deposit is too small to mint any LP shares.
    error InsufficientLiquidityMinted();
    /// @notice The LP shares sent to the pair are worth zero of at least one token.
    error InsufficientLiquidityBurned();
    /// @notice Both requested output amounts are zero.
    error InsufficientOutputAmount();
    /// @notice No input tokens were sent to the pair before the swap.
    error InsufficientInputAmount();
    /// @notice A requested output is not below its reserve.
    error InsufficientLiquidity();
    /// @notice The swap recipient is one of the pair's tokens.
    error InvalidTo();
    /// @notice The swap would lower the fee-adjusted constant product.
    error KInvariant();
    /// @notice A token balance does not fit in 112 bits.
    error Overflow();

    constructor(address tokenA, address tokenB, uint16 feeBps_) ERC20("Hyvo V2 LP", "HYVO-V2-LP") {
        if (tokenA == tokenB) revert IdenticalTokens();
        (address sorted0, address sorted1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (sorted0 == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        token0 = sorted0;
        token1 = sorted1;
        feeBps = feeBps_;
    }

    /// @notice Reserves as of the last mint, burn, swap or sync, and the block timestamp of that update
    ///         truncated to 32 bits.
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    /// @notice Mints LP shares to `to` for the tokens sent to the pair since the last reserve update.
    /// @dev First mint: `sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY`, with `MINIMUM_LIQUIDITY` locked at
    ///      0x...dEaD. Later mints: the smaller of the two pro-rata amounts; any excess stays in the pool.
    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint112 reserve0, uint112 reserve1) = (_reserve0, _reserve1);
        (uint256 balance0, uint256 balance1) = _balances();
        uint256 amount0 = balance0 - reserve0;
        uint256 amount1 = balance1 - reserve1;

        uint256 supply = totalSupply();
        if (supply == 0) {
            uint256 rootK = Math.sqrt(amount0 * amount1);
            if (rootK <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = rootK - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min(amount0 * supply / reserve0, amount1 * supply / reserve1);
            if (liquidity == 0) revert InsufficientLiquidityMinted();
        }
        _mint(to, liquidity);

        _update(balance0, balance1);
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burns the LP shares held by the pair and sends their share of both token balances to `to`.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (uint256 balance0, uint256 balance1) = _balances();
        uint256 liquidity = balanceOf(address(this));
        if (liquidity == 0) revert InsufficientLiquidityBurned();

        uint256 supply = totalSupply();
        amount0 = liquidity * balance0 / supply;
        amount1 = liquidity * balance1 / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);

        (balance0, balance1) = _balances();
        _update(balance0, balance1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Sends the requested outputs to `to`, then requires that the tokens sent to the pair
    ///         beforehand keep the fee-adjusted constant product:
    ///         `(balance0 * 10000 - amount0In * feeBps) * (balance1 * 10000 - amount1In * feeBps)
    ///          >= reserve0 * reserve1 * 10000 ** 2`.
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external nonReentrant {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 reserve0, uint112 reserve1) = (_reserve0, _reserve1);
        if (amount0Out >= reserve0 || amount1Out >= reserve1) revert InsufficientLiquidity();
        if (to == token0 || to == token1) revert InvalidTo();

        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);
        (uint256 balance0, uint256 balance1) = _balances();

        uint256 amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        uint256 balance0Adjusted = balance0 * BPS - amount0In * feeBps;
        uint256 balance1Adjusted = balance1 * BPS - amount1In * feeBps;
        if (balance0Adjusted * balance1Adjusted < uint256(reserve0) * reserve1 * BPS ** 2) revert KInvariant();

        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Sets the reserves to the pair's current token balances.
    function sync() external nonReentrant {
        (uint256 balance0, uint256 balance1) = _balances();
        _update(balance0, balance1);
    }

    function _balances() private view returns (uint256 balance0, uint256 balance1) {
        balance0 = IERC20(token0).balanceOf(address(this));
        balance1 = IERC20(token1).balanceOf(address(this));
    }

    function _update(uint256 balance0, uint256 balance1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        // Both casts are safe: the balances were checked against type(uint112).max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        (uint112 reserve0, uint112 reserve1) = (uint112(balance0), uint112(balance1));
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
}
