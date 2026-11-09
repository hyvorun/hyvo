import type { HealthResponse } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { Copied } from "../components/motion-data/Copied";
import { API_URL, fetchHealth } from "../lib/api";
import { useTitle } from "../lib/use-title";
import styles from "./DocsPage.module.css";

const SECTIONS = [
  ["read", "Read runs"],
  ["keys", "Keys and balance"],
  ["start", "Start a run"],
  ["mcp", "MCP"],
  ["verify", "Verify a hash"],
  ["webhooks", "Webhooks"],
  ["ask", "Ask an agent"],
  ["dryrun", "Dry Run a contract"],
  ["rewind", "Rewind"],
] as const;

function Code({ children, label }: { children: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Blocked clipboard: the text can be selected by hand.
    }
  };
  return (
    <figure className={styles.code}>
      <figcaption>
        <span>{label}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy: ${label}`}>
          {copied ? <Copied>Copied</Copied> : "Copy"}
        </button>
      </figcaption>
      {/* Scrolls on its own, so it needs to be reachable by keyboard. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre tabIndex={0}>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

/** API, MCP and hash verification (SPEC 9.1). The full reference is docs/API.md in the repository. */
export function DocsPage() {
  useTitle("Docs");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    fetchHealth().then(setHealth, () => setHealth(null));
  }, []);
  const closed = health?.features.payments === false;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Docs</h1>
        <p>
          Programs can read every published run, start runs from a prepaid balance, and prove a result from its file and the chain. The
          API lives at <code className="mono">{API_URL}</code>.
        </p>
      </header>
      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="On this page">
          {SECTIONS.map(([id, title]) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
        </nav>
        <div className={styles.body}>
          <section id="read" aria-labelledby="read-title">
            <h2 id="read-title">Read runs</h2>
            <p>Reading needs no key. A run's summary comes from the API, and its full record, every post and swap, from a signed link.</p>
            <Code label="List runs, then fetch one">{`curl ${API_URL}/v1/runs?limit=5
curl ${API_URL}/v1/runs/<runId>
curl ${API_URL}/v1/runs/<runId>/artifact   # a link to the exact run.json`}</Code>
          </section>

          <section id="keys" aria-labelledby="keys-title">
            <h2 id="keys-title">Keys and balance</h2>
            <p>
              <Link to="/account">Sign in with your wallet</Link> to make an API key. It is shown once, and it spends that wallet's balance, so
              keep it out of anything public. Send it as <code className="mono">Authorization: Bearer hyvo_…</code>.
            </p>
            <p>
              A balance is prepaid credit for runs. You top it up in USDG through the PaymentRouter contract, which sends the money to the
              treasury in the same transaction. It earns nothing. A run that fails goes back to the balance.
            </p>
            {closed && <p className={styles.note}>Top-ups are not open yet on this server, so nothing can be paid for at the moment.</p>}
            <Code label="Ask to top up, pay it, have it checked">{`curl -X POST ${API_URL}/v1/balance/topups \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{"amountUsd": 5}'

# Approve the amount to paymentRouter, call pay(orderId, token, amount) on it, then:
curl -X POST ${API_URL}/v1/balance/topups/<orderId>/payment \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{"txHash": "0x…"}'`}</Code>
          </section>

          <section id="start" aria-labelledby="start-title">
            <h2 id="start-title">Start a run</h2>
            <p>
              The price is taken from the balance in the same step that queues the run. Choose a <code className="mono">requestId</code>: if your
              request is lost and you send it again, you get the first run back and pay nothing more.
            </p>
            <Code label="Start a run from the balance">{`curl -X POST ${API_URL}/v1/runs \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{
    "balance": true,
    "requestId": "my-bot-0001",
    "agents": 50,
    "rounds": 10,
    "scenario": {
      "title": "A fictional token lists with a 5% creator tax",
      "seedText": "Liquidity is thin and the team is anonymous.",
      "events": [{ "round": 4, "text": "A large wallet posts that it entered early." }]
    }
  }'`}</Code>
            <p>A run takes minutes. Poll <code className="mono">GET /v1/runs/&lt;runId&gt;</code>, or subscribe to a <a href="#webhooks">webhook</a>.</p>
          </section>

          <section id="mcp" aria-labelledby="mcp-title">
            <h2 id="mcp-title">MCP</h2>
            <p>
              A remote MCP server, so an AI agent can use Hyvo directly: <code className="mono">{API_URL}/mcp</code>. It speaks Streamable HTTP
              without sessions. Reading is open, and what spends a balance takes an API key.
            </p>
            <Code label="Client configuration">{JSON.stringify({ mcpServers: { hyvo: { type: "http", url: `${API_URL}/mcp`, headers: { Authorization: "Bearer hyvo_…" } } } }, null, 2)}</Code>
            <dl className={styles.terms}>
              <div>
                <dt className="mono">create_run</dt>
                <dd>Start a run from the balance. If the balance is short, it answers with a quote and how to pay it.</dd>
              </div>
              <div>
                <dt className="mono">get_run</dt>
                <dd>A run's status and summary.</dd>
              </div>
              <div>
                <dt className="mono">ask_agent</dt>
                <dd>Ask one agent why it did what it did, or ask the report. A small fee per question.</dd>
              </div>
              <div>
                <dt className="mono">list_recent_runs</dt>
                <dd>Published runs, newest first, with a filter.</dd>
              </div>
              <div>
                <dt className="mono">verify_run</dt>
                <dd>The published hash next to the on-chain commit, and a link to the file so you can recompute it.</dd>
              </div>
            </dl>
          </section>

          <section id="verify" aria-labelledby="verify-title">
            <h2 id="verify-title">Verify a hash</h2>
            <p>
              Every published run is hashed, and the hash is committed to the HyvoOracle contract on Robinhood Chain. You do not have to trust
              this site about that. Remove the top-level <code className="mono">hash</code> field from <code className="mono">run.json</code>, canonicalize the
              rest with RFC 8785 (JCS), and take its keccak-256. The result must equal <code className="mono">hash</code>, and the{" "}
              <code className="mono">reportHash</code> that <code className="mono">getCommit(bytes32 runId)</code> returns. The{" "}
              <Link to="/oracle">oracle page</Link> does this in your browser.
            </p>
            <Code label="With the TypeScript SDK (packages/sdk)">{`import { Hyvo } from "@hyvo/sdk";

const hyvo = new Hyvo({ baseUrl: "${API_URL}" });
const proof = await hyvo.verifyRun(runId, { rpcUrl: "https://robinhood.drpc.org" });
// proof.fileMatches: the file hashes to its hash.
// proof.chainMatches: the chain holds that hash, read from the chain itself.`}</Code>
          </section>

          <section id="webhooks" aria-labelledby="webhooks-title">
            <h2 id="webhooks-title">Webhooks</h2>
            <p>
              <code className="mono">POST /v1/webhooks</code> with an https URL and the events you want. The answer holds a signing secret, shown once. A delivery that
              fails is tried again, for up to about 14 hours, so use the body's <code className="mono">id</code> to drop a repeat.
            </p>
            <dl className={styles.terms}>
              <div>
                <dt className="mono">run.completed</dt>
                <dd>A run you started finished and was published.</dd>
              </div>
              <div>
                <dt className="mono">run.failed</dt>
                <dd>A run you started failed for good. Its body says what happened to the money.</dd>
              </div>
              <div>
                <dt className="mono">run.published</dt>
                <dd>Any run reached the public gallery.</dd>
              </div>
              <div>
                <dt className="mono">oracle.committed</dt>
                <dd>A listed run's hash is on-chain.</dd>
              </div>
            </dl>
            <p>
              Each delivery carries <code className="mono">X-Hyvo-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where v1 is the HMAC-SHA256 of{" "}
              <code className="mono">&lt;t&gt;.&lt;raw body&gt;</code> under the secret.
            </p>
            <Code label="Check a delivery with the SDK">{`import { verifyWebhook } from "@hyvo/sdk";

const event = await verifyWebhook(secret, request.headers.get("X-Hyvo-Signature") ?? "", rawBody);
if (!event) return new Response("bad signature", { status: 400 });`}</Code>
          </section>

          <section id="ask" aria-labelledby="ask-title">
            <h2 id="ask-title">Ask an agent</h2>
            <p>
              A published run can be questioned afterwards: one agent about what it did, or <code className="mono">report</code> about the whole run. The answer comes
              only from the run's own record. An answer that breaks the copy rules is withheld, and you are not charged for it.
            </p>
            <Code label="A question, paid from the balance">{`curl -X POST ${API_URL}/v1/runs/<runId>/ask \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{"agentId": "a07", "question": "Why did you leave in round 6?"}'`}</Code>
          </section>

          <section id="dryrun" aria-labelledby="dryrun-title">
            <h2 id="dryrun-title">Dry Run a contract</h2>
            <p>
              A crowd of synthetic users tries your contract before mainnet: newcomers, power users, an adversary and a whale. Give a deployed address, which plays on a
              fork of the chain, or creation bytecode with its ABI, which plays on a plain one. Name the view functions that must stay true as invariants. You can also{" "}
              <Link to="/dryrun">start one from the site</Link>.
            </p>
            <Code label="Start one from the balance">{`curl -X POST ${API_URL}/v1/dryruns \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{
    "balance": true,
    "requestId": "my-vault-0001",
    "description": "A savings vault. People deposit ETH and withdraw it whenever they want.",
    "address": "0x…",
    "invariants": ["isSolvent"],
    "agents": 12,
    "rounds": 8
  }'`}</Code>
            <p>
              The report says what broke, with the calls that lead there. It belongs to the wallet that asked for it: it never reaches the gallery, and nothing about it goes
              on-chain. A Dry Run is not an audit. It finds what its synthetic users happened to run into.
            </p>
            <Code label="With the TypeScript SDK (packages/sdk)">{`const { dryRun } = await hyvo.createDryRun({ description, address, invariants: ["isSolvent"] });
await hyvo.waitForDryRun(dryRun.runId);
const report = await hyvo.fetchDryRunReport(dryRun.runId); // refused if it does not match its hash
for (const finding of report.findings) console.log(finding.severity, finding.title, finding.reproduce);`}</Code>
          </section>

          <section id="rewind" aria-labelledby="rewind-title">
            <h2 id="rewind-title">Rewind</h2>
            <p>
              Play a past moment of a real pool again with one thing changed. The pool's reserves at the block seed a private test market, and the file holds what the real pool did afterwards, read from the
              chain before the run starts. It stays out of the gallery, and it compares one run with one past: it does not forecast. You can also <Link to="/rewind">start one from the site</Link>.
            </p>
            <Code label="Go back to a block and change one event">{`curl -X POST ${API_URL}/v1/runs \\
  -H "Authorization: Bearer $HYVO_KEY" -H "Content-Type: application/json" \\
  -d '{
    "balance": true,
    "rewind": { "pool": "0x…", "block": 106913859, "hours": 6 },
    "scenario": {
      "title": "Rewind of a launch",
      "seedText": "",
      "events": [{ "round": 3, "text": "The rumor came two hours earlier." }]
    },
    "agents": 50,
    "rounds": 10
  }'`}</Code>
          </section>
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
