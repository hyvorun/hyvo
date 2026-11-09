/** Where a saved list is kept, in one line, and for a visitor who is signed out, a way to sign in. */
import { Link } from "react-router";
import { useWalletSession, Web3 } from "../../components/Web3";
import { shortHash } from "../../lib/format";
import type { HolderStatusValue } from "../../lib/holder-status";
import type { SyncState } from "../../lib/use-saved-list";
import launches from "./Launches.module.css";
import styles from "./Utility.module.css";

export function HolderSync({ holder, sync, syncError, what }: { holder: HolderStatusValue; sync: SyncState; syncError: string | null; what: string }) {
  const wallet = holder.wallet ? shortHash(holder.wallet, 6, 4) : null;
  return (
    <div className={styles.sync} role="status">
      {holder.status === "holder" && (
        <p>
          {sync === "syncing" && <>Saving {what} with your account ({wallet})…</>}
          {sync === "synced" && <>Kept with your account ({wallet}): {what} reaches your other browsers too.</>}
          {sync === "failed" && (
            <>
              Saved in this browser. {syncError ?? "It could not be saved with your account just now."}{" "}
              <button type="button" className={launches.again} onClick={holder.refresh}>
                Try again
              </button>
            </>
          )}
          {sync === "browser" && <>Saved in this browser.</>}
        </p>
      )}
      {holder.status === "not-holder" && (
        <p>
          Saved in this browser. HYVO holders also keep {what} with their account; {wallet} does not hold the minimum now and 24 hours earlier.{" "}
          <Link to="/token">Who counts as a holder</Link>
        </p>
      )}
      {holder.status === "unknown" && <p>Saved in this browser. Checking whether {wallet ?? "your wallet"} holds HYVO…</p>}
      {holder.status === "signed-out" && (
        <>
          <p>
            Saved in this browser. HYVO holders keep {what} with their account: sign in with the wallet that holds it. Signing in is a
            signature, not a transaction.
          </p>
          <Web3>
            <SignIn onDone={holder.refresh} />
          </Web3>
        </>
      )}
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const wallet = useWalletSession();
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={wallet.busy !== null}
        onClick={() => void wallet.ensureSession().then((session) => session && onDone())}
      >
        {wallet.busy === "connecting" ? "Connecting…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : "Sign in"}
      </button>
      {wallet.error && (
        <span className={styles.error} role="alert">
          {wallet.error}
        </span>
      )}
    </>
  );
}
