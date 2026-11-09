import type { Finding } from "../types.js";
import type { CheckContext } from "./context.js";
import { type FunctionCategory, powerFinding } from "./detect.js";

export const PAUSE: FunctionCategory = {
  signatures: [
    "pause()",
    "setPause(bool)",
    "setPaused(bool)",
    "setTradingEnabled(bool)",
    "enableTrading()",
    "setTrading(bool)",
    "setTradingStatus(bool)",
  ],
  // paused() and unpause() alone are not switches: the switch is the ability to STOP transfers or trading, so
  // the setters and enablers are matched, not the read or the unpause.
  abiName: /^(pause|setpause|setpaused|settradingenabled|enabletrading|settrading|settradingstatus)$/i,
  describe: "pause, setPause(d), setTradingEnabled, enableTrading, setTrading or setTradingStatus",
};

/** A pause or trading switch lets its holder stop transfers or trading for everyone. */
export function pausableCheck(ctx: CheckContext): Finding {
  return powerFinding("pause", ctx, PAUSE);
}
