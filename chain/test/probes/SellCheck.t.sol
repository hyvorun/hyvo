// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {SellCheck} from "../../src/probes/SellCheck.sol";
import {HyvoV2Pair} from "../../src/test-assets/HyvoV2Pair.sol";
import {TestToken} from "../../src/test-assets/TestToken.sol";
import {TestWETH} from "../../src/test-assets/TestWETH.sol";
import {MockPonsCurve, MockV2Router02, SellBlockedToken, TaxedToken} from "./ProbeMocks.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @dev The probe is used the way Hyvo Check uses it: its runtime code is placed at the same throwaway
///      address the driver overrides (vm.etch stands in for the eth_call state override), with made-up ETH.
contract SellCheckTest is Test {
    address internal constant PROBE = 0x00000000000000000000000000000000005E11C4;
    address internal constant SINK = address(uint160(uint256(keccak256("hyvo.sellcheck.sink"))));
    uint256 internal constant ETH_IN = 0.001 ether;
    uint16 internal constant V2_FEE_BPS = 30;

    TestWETH internal weth;
    MockV2Router02 internal router;
    SellCheck internal probe;

    function setUp() public {
        weth = new TestWETH();
        router = new MockV2Router02(address(weth));
        SellCheck deployed = new SellCheck();
        vm.etch(PROBE, address(deployed).code);
        vm.deal(PROBE, 1 ether);
        probe = SellCheck(payable(PROBE));
    }

    function _plainToken() internal returns (address) {
        return address(new TestToken("Plain", "PLN", address(this)));
    }

    /// @dev A token/WETH pair holding 50 WETH and 1,000,000 tokens.
    function _listOnV2(address token) internal returns (HyvoV2Pair pair) {
        pair = new HyvoV2Pair(token, address(weth), V2_FEE_BPS);
        router.register(pair);
        IMintable(token).mint(address(pair), 1_000_000 ether);
        vm.deal(address(this), 50 ether);
        weth.deposit{value: 50 ether}();
        require(weth.transfer(address(pair), 50 ether), "seed WETH");
        pair.mint(address(this));
    }

    /// @dev The ETH the sold part of the buy cost, at the average price of the buy.
    function _spentOnSoldPart(SellCheck.Result memory r) internal pure returns (uint256) {
        return ETH_IN * r.sellIn / r.gotBuy;
    }

    // ---------- Uniswap-V2-style router ----------

    function test_v2_plainToken_everyStepArrivesAsPromised() public {
        address token = _plainToken();
        _listOnV2(token);

        SellCheck.Result memory r = probe.checkV2(address(router), address(weth), token, ETH_IN);

        assertTrue(r.buyOk, "buy");
        assertGt(r.gotBuy, 0, "bought nothing");
        assertEq(r.gotBuy, r.expectedBuy, "buy arrived as quoted");
        assertEq(r.buyErr.length, 0);
        assertGt(r.buyGas, 0);

        assertTrue(r.transferOk, "transfer");
        assertEq(r.transferSent, r.gotBuy / 10);
        assertEq(r.transferArrived, r.transferSent, "transfer arrived in full");
        assertEq(IERC20(token).balanceOf(SINK), r.transferSent);

        assertTrue(r.approveOk, "approve");
        assertEq(r.sellIn, r.gotBuy - r.transferSent);
        assertTrue(r.sellOk, "sell");
        assertEq(r.sellErr.length, 0);
        assertGt(r.gotSell, 0);
        assertEq(r.gotSell, r.expectedSell, "sell arrived as quoted");
        assertGt(r.sellGas, 0);

        // Two 0.30% fees and a sliver of price impact, nothing else.
        uint256 spent = _spentOnSoldPart(r);
        assertLt(r.gotSell, spent);
        assertGt(r.gotSell, spent * 9_930 / 10_000);
    }

    function test_v2_taxedToken_showsTheTaxOnEveryStep() public {
        TaxedToken taxed = new TaxedToken();
        address token = address(taxed);
        _listOnV2(token);

        SellCheck.Result memory r = probe.checkV2(address(router), address(weth), token, ETH_IN);

        assertTrue(r.buyOk, "buy");
        assertEq(r.gotBuy, r.expectedBuy - r.expectedBuy * 500 / 10_000, "5% of the buy went to the tax wallet");
        assertTrue(r.transferOk, "transfer");
        assertEq(r.transferArrived, r.transferSent - r.transferSent * 500 / 10_000, "5% of the transfer taxed");
        assertTrue(r.sellOk, "the sell still goes through");
        assertLt(r.gotSell, r.expectedSell);
        // The pair received 95% of what the router quoted for, so about 5% less ETH came back.
        assertApproxEqRel(r.gotSell, r.expectedSell * 9_500 / 10_000, 0.001e18);
    }

    function test_v2_sellBlockedToken_buysAndSendsButCannotSell() public {
        SellBlockedToken blocked = new SellBlockedToken();
        address token = address(blocked);
        HyvoV2Pair pair = _listOnV2(token);
        blocked.setPair(address(pair), true);

        SellCheck.Result memory r = probe.checkV2(address(router), address(weth), token, ETH_IN);

        assertTrue(r.buyOk, "buy");
        assertEq(r.gotBuy, r.expectedBuy);
        assertTrue(r.transferOk, "transfer to a wallet still works");
        assertEq(r.transferArrived, r.transferSent);
        assertTrue(r.approveOk);
        assertFalse(r.sellOk, "sell");
        assertEq(r.gotSell, 0);
        assertGt(r.expectedSell, 0, "the router still quoted the sell");
        assertEq(r.sellErr, abi.encodeWithSignature("Error(string)", "TransferHelper: TRANSFER_FROM_FAILED"));
    }

    function test_v2_noPair_theBuyFailsAndNothingElseRuns() public {
        address token = _plainToken();

        SellCheck.Result memory r = probe.checkV2(address(router), address(weth), token, ETH_IN);

        assertFalse(r.buyOk);
        assertEq(r.expectedBuy, 0, "no quote");
        assertEq(r.gotBuy, 0);
        assertEq(r.buyErr, abi.encodeWithSignature("Error(string)", "no pair"));
        assertFalse(r.transferOk);
        assertEq(r.transferSent, 0);
        assertFalse(r.sellOk);
        assertEq(r.sellIn, 0);
    }

    function test_v2_theProbeKeepsNoTokensAndOnlySpendsWhatItWasGiven() public {
        address token = _plainToken();
        _listOnV2(token);
        uint256 ethBefore = PROBE.balance;

        SellCheck.Result memory r = probe.checkV2(address(router), address(weth), token, ETH_IN);

        assertEq(IERC20(token).balanceOf(PROBE), 0, "everything left was sold");
        assertEq(PROBE.balance, ethBefore - ETH_IN + r.gotSell);
    }

    // ---------- Pons-v2-style bonding curve ----------

    function _curve(uint256 feeBps, uint256 taxBps) internal returns (MockPonsCurve curve, address token) {
        token = _plainToken();
        curve = new MockPonsCurve(IERC20(token), feeBps, taxBps, 1.5 ether, 800_000_000 ether);
        IMintable(token).mint(address(curve), 800_000_000 ether);
        vm.deal(address(curve), 10 ether); // pays sells out of more than the probe paid in
    }

    function test_ponsCurve_thePromiseIncludesTheCurveFeeAndCreatorTax() public {
        (MockPonsCurve curve, address token) = _curve(100, 289);

        SellCheck.Result memory r = probe.checkPonsCurve(address(curve), token, ETH_IN);

        assertTrue(r.buyOk, "buy");
        assertGt(r.gotBuy, 0);
        assertEq(r.gotBuy, r.expectedBuy, "buy arrived as the curve's math after fee and tax");
        assertEq(r.transferArrived, r.transferSent);
        assertTrue(r.sellOk, "sell");
        assertEq(r.gotSell, r.expectedSell, "sell arrived as the curve's math after fee and tax");
        // The fee and the tax are paid twice, so about 7.6% of the sold part's cost does not come back.
        uint256 spent = _spentOnSoldPart(r);
        assertApproxEqRel(r.gotSell, spent * (10_000 - 2 * 389) / 10_000, 0.002e18);
    }

    function test_ponsCurve_theSnipeTaxIsInThePromise() public {
        (MockPonsCurve curve, address token) = _curve(100, 100);
        SellCheck.Result memory plain = probe.checkPonsCurve(address(curve), token, ETH_IN);

        (MockPonsCurve sniped, address token2) = _curve(100, 100);
        sniped.setSnipeTax(5_000);
        SellCheck.Result memory r = probe.checkPonsCurve(address(sniped), token2, ETH_IN);

        assertTrue(r.buyOk);
        assertEq(r.gotBuy, r.expectedBuy);
        assertLt(r.gotBuy, plain.gotBuy * 52 / 100, "half the ETH went to the snipe tax");
        assertEq(r.gotSell, r.expectedSell);
    }

    function test_ponsCurve_capsTheSnipeTaxLikeTheCurve() public {
        (MockPonsCurve curve, address token) = _curve(100, 100);
        curve.setSnipeTax(9_900); // above 10000 - 100 - 100 - 100, so both cap it at 9700

        SellCheck.Result memory r = probe.checkPonsCurve(address(curve), token, ETH_IN);

        assertTrue(r.buyOk);
        assertEq(r.gotBuy, r.expectedBuy);
    }

    // ---------- the probe itself ----------

    function test_probe_acceptsEth() public {
        (bool ok,) = PROBE.call{value: 1}("");
        assertTrue(ok);
    }
}
