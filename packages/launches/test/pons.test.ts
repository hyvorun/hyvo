import { keccak256, toBytes, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { CURVE_ABI, FACTORY_ABI, PONS_V2_FACTORY, TOPICS, phaseFromIndex } from "../src/pons";

describe("Pons V2 interfaces", () => {
  it("event topics are the hashes of the verified signatures, and match the logs read on chain", () => {
    expect(TOPICS.tokenLaunched).toBe(keccak256(toBytes("TokenLaunched(address,address,address,address,uint256,uint256)")));
    // Values seen in real logs of the factory and of curves on 2026-11-09.
    expect(TOPICS.tokenLaunched).toBe("0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607");
    expect(TOPICS.poolGraduated).toBe("0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259");
    expect(TOPICS.curveBuy).toBe("0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455");
    expect(TOPICS.curveSell).toBe("0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df");
  });

  it("reads only view functions", () => {
    for (const item of [...FACTORY_ABI, ...CURVE_ABI]) {
      if (item.type === "function") expect(item.stateMutability).toBe("view");
    }
    expect(toFunctionSelector("getLaunchedToken(address)")).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("names the factory by its checksummed address", () => {
    expect(PONS_V2_FACTORY).toBe("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  });

  it("maps the graduation phases of ILaunchpadV2.sol", () => {
    expect([0, 1, 2, 3, 4].map(phaseFromIndex)).toEqual(["curve", "swept", "graduated", "rescued", null]);
  });
});
