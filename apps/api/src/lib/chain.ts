/**
 * Robinhood Chain access for the Worker, behind a small interface so tests can swap it out.
 * Reads go through every URL in RPC_URLS (viem `fallback`); the only write is
 * `HyvoOracle.commit`, signed with ATTESTER_PRIVATE_KEY. Nothing here touches user funds.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  fallback,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { toAccount } from "viem/accounts";
import type { Config } from "./config";
import { addressOfKey, signHash } from "./secp256k1";

export const PAID_EVENT = parseAbiItem(
  "event Paid(bytes32 indexed orderId, address indexed payer, address indexed token, uint256 amount, uint256 timestamp)",
);

export const ORACLE_ABI = parseAbi([
  "function commit(bytes32 runId, bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt)",
  "function resolve(bytes32 runId, bytes32 outcomeHash, string outcomeURI)",
  "function getCommit(bytes32 runId) view returns ((bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))",
  "function attester() view returns (address)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export interface PaidLog {
  orderId: Hex;
  payer: Address;
  token: Address;
  amount: bigint;
  timestamp: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

export interface CommitOnChain {
  reportHash: Hex;
  scenarioHash: Hex;
  resolvesAt: bigint;
  committedAt: bigint;
  resolvedAt: bigint;
  outcomeHash: Hex;
}

export interface TxStatus {
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface ChainGateway {
  latestBlock(): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** `Paid` events of `router` in [fromBlock, toBlock]. */
  paidLogs(router: Address, fromBlock: bigint, toBlock: bigint): Promise<PaidLog[]>;
  /** The receipt of `txHash` with its `Paid` events from `router`; null while unknown. */
  paymentReceipt(router: Address, txHash: Hex): Promise<(TxStatus & { paid: PaidLog[] }) | null>;
  balanceOf(token: Address, owner: Address, blockNumber?: bigint): Promise<bigint>;
  /** null when the run was never committed. */
  getCommit(oracle: Address, runIdBytes32: Hex): Promise<CommitOnChain | null>;
  /** Send `commit` with the attester key; returns the transaction hash. */
  sendCommit(
    oracle: Address,
    args: { runIdBytes32: Hex; reportHash: Hex; scenarioHash: Hex; resolvesAt: bigint },
  ): Promise<Hex>;
  /** Send `resolve` with the attester key; returns the transaction hash. */
  sendResolve(oracle: Address, args: { runIdBytes32: Hex; outcomeHash: Hex; outcomeUri: string }): Promise<Hex>;
  txStatus(txHash: Hex): Promise<TxStatus | null>;
  /** Smart-wallet (ERC-1271/6492) signature check for SIWE; EOAs are checked without RPC. */
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
}

let factory: ((cfg: Config) => ChainGateway) | null = null;

/** Tests only: replace the chain; `null` restores the viem gateway. */
export function setChainFactory(next: ((cfg: Config) => ChainGateway) | null): void {
  factory = next;
}

export function chainFor(cfg: Config): ChainGateway {
  return factory ? factory(cfg) : new ViemGateway(cfg);
}

class ViemGateway implements ChainGateway {
  private readonly client: PublicClient;
  private readonly chain;

  constructor(private readonly cfg: Config) {
    this.chain = defineChain({
      id: cfg.chainId,
      name: cfg.chainId === 4663 ? "Robinhood Chain" : `Chain ${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: cfg.rpcUrls } },
    });
    this.client = createPublicClient({ chain: this.chain, transport: this.transport() }) as PublicClient;
  }

  private transport() {
    if (this.cfg.rpcUrls.length === 0) throw new Error("RPC_URLS is empty");
    return fallback(this.cfg.rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })));
  }

  latestBlock(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async blockTimestamp(blockNumber: bigint): Promise<bigint> {
    return (await this.client.getBlock({ blockNumber })).timestamp;
  }

  async paidLogs(router: Address, fromBlock: bigint, toBlock: bigint): Promise<PaidLog[]> {
    const logs = await this.client.getLogs({ address: router, event: PAID_EVENT, fromBlock, toBlock, strict: true });
    return logs.map((log) => ({
      orderId: log.args.orderId,
      payer: log.args.payer,
      token: log.args.token,
      amount: log.args.amount,
      timestamp: log.args.timestamp,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    }));
  }

  async paymentReceipt(router: Address, txHash: Hex) {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const paid: PaidLog[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== router.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: [PAID_EVENT], data: log.data, topics: log.topics, strict: true });
        paid.push({
          orderId: event.args.orderId,
          payer: event.args.payer,
          token: event.args.token,
          amount: event.args.amount,
          timestamp: event.args.timestamp,
          blockNumber: receipt.blockNumber,
          txHash: receipt.transactionHash,
          logIndex: log.logIndex,
        });
      } catch {
        // another event of the router
      }
    }
    return { status: receipt.status, blockNumber: receipt.blockNumber, paid };
  }

  balanceOf(token: Address, owner: Address, blockNumber?: bigint): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  }

  async getCommit(oracle: Address, runIdBytes32: Hex): Promise<CommitOnChain | null> {
    const commit = await this.client.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "getCommit",
      args: [runIdBytes32],
    });
    return commit.committedAt === 0n ? null : { ...commit };
  }

  async sendCommit(
    oracle: Address,
    args: { runIdBytes32: Hex; reportHash: Hex; scenarioHash: Hex; resolvesAt: bigint },
  ): Promise<Hex> {
    if (!this.cfg.attesterKey) throw new Error("ATTESTER_PRIVATE_KEY is not set");
    const account = attesterAccount(this.cfg.attesterKey);
    const wallet = createWalletClient({ account, chain: this.chain, transport: this.transport() });
    return wallet.writeContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "commit",
      args: [args.runIdBytes32, args.reportHash, args.scenarioHash, args.resolvesAt],
    });
  }

  async sendResolve(oracle: Address, args: { runIdBytes32: Hex; outcomeHash: Hex; outcomeUri: string }): Promise<Hex> {
    if (!this.cfg.attesterKey) throw new Error("ATTESTER_PRIVATE_KEY is not set");
    const account = attesterAccount(this.cfg.attesterKey);
    const wallet = createWalletClient({ account, chain: this.chain, transport: this.transport() });
    return wallet.writeContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "resolve",
      args: [args.runIdBytes32, args.outcomeHash, args.outcomeUri],
    });
  }

  async txStatus(txHash: Hex): Promise<TxStatus | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash });
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean> {
    return this.client.verifyMessage({ address, message, signature });
  }
}

/** The attester as a viem account that signs in WebAssembly (./secp256k1.ts) and only signs transactions. */
function attesterAccount(key: Hex) {
  const refuse = async (): Promise<never> => {
    throw new Error("the attester signs transactions only");
  };
  return toAccount({
    address: addressOfKey(key),
    signMessage: refuse,
    signTypedData: refuse,
    async signTransaction(transaction, options) {
      const serialize = options?.serializer ?? serializeTransaction;
      const hash = keccak256(await serialize(transaction));
      return serialize(transaction, signHash(hash, key));
    },
  });
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  return name === "TransactionReceiptNotFoundError" || name === "TransactionNotFoundError";
}
