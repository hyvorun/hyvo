import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  LOGS_PER_PAGE,
  addressTopic,
  creatorLaunchFromJson,
  creatorLaunchToJson,
  creatorLogsQuery,
  mergeCreatorPages,
  nextPageFrom,
  parseCreatorLogs,
} from "../src/creator";
import { FACTORY_ABI, NATIVE, PONS_V2_FACTORY, PONS_V2_FACTORY_BLOCK, TOPICS } from "../src/pons";
import { fakeAddress } from "../testing";

const CREATOR = fakeAddress("creator:history");
const OTHER = fakeAddress("creator:other");

/** One TokenLaunched log as Blockscout's getLogs sends it: hex quantities, a timeStamp. */
function blockscoutLog(index: number, options: { deployer?: string; block?: bigint; address?: string; topic0?: Hex } = {}) {
  const token = fakeAddress(`history:token:${index}`);
  const curve = fakeAddress(`history:curve:${index}`);
  const topics = encodeEventTopics({ abi: FACTORY_ABI, eventName: "TokenLaunched", args: { token, curve, deployer: (options.deployer ?? CREATOR) as Hex } }) as Hex[];
  if (options.topic0) topics[0] = options.topic0;
  return {
    address: (options.address ?? PONS_V2_FACTORY).toLowerCase(),
    topics,
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [NATIVE, 1n, 4_200_000_000_000_000_000n]),
    blockNumber: toHex(options.block ?? 110_000_000n + BigInt(index)),
    timeStamp: toHex(1_794_000_000 + index),
    logIndex: toHex(3),
    transactionHash: keccak256(toHex(`history-${index}`)),
    transactionIndex: "0x1",
    gasPrice: "0x0",
    gasUsed: "0x0",
  };
}

describe("creatorLogsQuery", () => {
  it("asks for the factory's TokenLaunched logs with the creator as topic 3, over all of its history", () => {
    const query = new URLSearchParams(creatorLogsQuery(CREATOR));
    expect(query.get("module")).toBe("logs");
    expect(query.get("action")).toBe("getLogs");
    expect(query.get("address")).toBe(PONS_V2_FACTORY);
    expect(query.get("topic0")).toBe(TOPICS.tokenLaunched);
    expect(query.get("topic3")).toBe(addressTopic(CREATOR));
    expect(query.get("topic0_3_opr")).toBe("and");
    expect(query.get("fromBlock")).toBe(PONS_V2_FACTORY_BLOCK.toString());
    expect(query.get("toBlock")).toBe("latest");
    expect(addressTopic(CREATOR)).toHaveLength(66);
    // Never earlier than the factory's own block.
    expect(new URLSearchParams(creatorLogsQuery(CREATOR, 5n)).get("fromBlock")).toBe(PONS_V2_FACTORY_BLOCK.toString());
  });
});

describe("parseCreatorLogs", () => {
  it("reads each launch and drops logs from elsewhere, of another event or of another deployer", () => {
    const answer = {
      status: "1",
      message: "OK",
      result: [
        blockscoutLog(1),
        blockscoutLog(2),
        blockscoutLog(3, { address: fakeAddress("not the factory") }),
        blockscoutLog(4, { topic0: TOPICS.poolGraduated }),
        blockscoutLog(5, { deployer: OTHER }),
        { nonsense: true },
      ],
    };
    const page = parseCreatorLogs(answer, CREATOR.toLowerCase());
    expect(page?.rows).toBe(6);
    expect(page?.launches.map((launch) => launch.token)).toEqual([fakeAddress("history:token:1"), fakeAddress("history:token:2")]);
    const first = page!.launches[0]!;
    expect(first.curve).toBe(fakeAddress("history:curve:1"));
    expect(first.pairToken).toBe(getAddress(NATIVE));
    expect(first.graduationThreshold).toBe(4_200_000_000_000_000_000n);
    expect(first.block).toBe(110_000_001n);
    expect(first.timestamp).toBe(1_794_000_001);
    expect(first.logIndex).toBe(3);
  });

  it("takes Blockscout's empty answer as no launches, and anything without a list as no answer", () => {
    expect(parseCreatorLogs({ status: "0", message: "No logs found", result: [] }, CREATOR)).toEqual({ launches: [], rows: 0 });
    expect(parseCreatorLogs({ status: "0", message: "NOTOK", result: "Error! Invalid address" }, CREATOR)).toBeNull();
    expect(parseCreatorLogs("<html>", CREATOR)).toBeNull();
    expect(parseCreatorLogs(null, CREATOR)).toBeNull();
  });
});

describe("paging", () => {
  it("asks again from the last block of a full page, and merges pages without doubles, newest first", () => {
    const full = Array.from({ length: LOGS_PER_PAGE }, (_, i) => blockscoutLog(i, { block: 100_000_000n + BigInt(i) }));
    const first = parseCreatorLogs({ result: full }, CREATOR)!;
    const next = nextPageFrom(first, PONS_V2_FACTORY_BLOCK);
    expect(next).toBe(100_000_000n + BigInt(LOGS_PER_PAGE - 1));
    // The next page starts in that block, so its log comes twice.
    const second = parseCreatorLogs({ result: [full[LOGS_PER_PAGE - 1], blockscoutLog(5_000, { block: 100_500_000n })] }, CREATOR)!;
    expect(nextPageFrom(second, next!)).toBeNull();
    const merged = mergeCreatorPages([first.launches, second.launches]);
    expect(merged).toHaveLength(LOGS_PER_PAGE + 1);
    expect(merged[0]!.block).toBe(100_500_000n);
    expect(merged.at(-1)!.block).toBe(100_000_000n);
  });

  it("stops when a full page cannot move past the block it started at", () => {
    const stuck = Array.from({ length: LOGS_PER_PAGE }, (_, i) => blockscoutLog(i, { block: 100_000_000n }));
    expect(nextPageFrom(parseCreatorLogs({ result: stuck }, CREATOR)!, 100_000_000n)).toBeNull();
  });
});

describe("JSON", () => {
  it("round-trips a launch through the API's JSON", () => {
    const launch = parseCreatorLogs({ result: [blockscoutLog(7)] }, CREATOR)!.launches[0]!;
    const json = creatorLaunchToJson(launch);
    expect(json.graduationThreshold).toBe("4200000000000000000");
    expect(json.block).toBe(110_000_007);
    expect(creatorLaunchFromJson(json)).toEqual(launch);
    expect(creatorLaunchFromJson({ ...json, token: "<b>not an address</b>" })).toBeNull();
  });
});
