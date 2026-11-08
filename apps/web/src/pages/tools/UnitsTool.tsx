import { useState } from "react";
import { formatAmount, fromBaseUnits, groupDigits, parseAmount, toBaseUnits } from "../../lib/calc";
import { NumberField, ToolPage, useDescription } from "./shared";
import styles from "./Tools.module.css";

const ETH_UNITS = [
  { id: "wei", label: "Wei", decimals: 0, rule: "Wei is the smallest unit: whole numbers only." },
  { id: "gwei", label: "Gwei", decimals: 9, rule: "Gwei goes to 9 decimal places at most." },
  { id: "ether", label: "ETH", decimals: 18, rule: "ETH goes to 18 decimal places at most." },
] as const;

type EthUnit = (typeof ETH_UNITS)[number]["id"];

/** Wei, gwei and ETH; a token amount and its base units; percent and basis points. All exact where it matters. */
export function UnitsTool() {
  useDescription("Free unit converter: wei, gwei and ETH, token amounts and their base units for any number of decimals, and basis points to percent.");
  return (
    <ToolPage
      to="/tools/units"
      title="Units"
      lede="Wei, gwei and ETH; a token amount and the whole number a contract stores for it; basis points and percent. Type in any box."
    >
      <EthUnits />
      <TokenUnits />
      <BasisPoints />
      <p className={styles.fine}>Wei and base units are converted exactly, digit by digit, with no rounding. It runs in your browser.</p>
    </ToolPage>
  );
}

function EthUnits() {
  const [source, setSource] = useState<{ unit: EthUnit; text: string }>({ unit: "ether", text: "1" });
  const from = ETH_UNITS.find((unit) => unit.id === source.unit)!;
  const wei = source.text.trim() === "" ? null : toBaseUnits(source.text, from.decimals);
  const invalid = source.text.trim() !== "" && wei === null;
  return (
    <section className={styles.card} aria-labelledby="units-eth">
      <div className={styles.panel}>
        <h2 id="units-eth">ETH units</h2>
        <div className={styles.fields}>
          {ETH_UNITS.map((unit) => {
            // A unit with n decimal places holds wei / 10^n of it: gwei 9, ETH 18.
            const shown = unit.id === source.unit ? source.text : wei === null ? "" : fromBaseUnits(wei, unit.decimals);
            return (
              <NumberField
                key={unit.id}
                label={unit.label}
                value={shown}
                onChange={(text) => setSource({ unit: unit.id, text })}
                error={invalid && unit.id === source.unit ? `${unit.rule} Use a plain number, such as 1.5.` : null}
                hint={shown.length > 12 && /^[0-9.]+$/.test(shown) ? groupDigits(shown) : undefined}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TokenUnits() {
  const [decimalsText, setDecimalsText] = useState("18");
  const [source, setSource] = useState<{ side: "amount" | "base"; text: string }>({ side: "amount", text: "1.5" });
  const decimals = /^[0-9]{1,2}$/.test(decimalsText.trim()) && Number(decimalsText) <= 36 ? Number(decimalsText) : null;
  const base =
    decimals === null || source.text.trim() === "" ? null : source.side === "amount" ? toBaseUnits(source.text, decimals) : toBaseUnits(source.text, 0);
  const invalid = decimals !== null && source.text.trim() !== "" && base === null;
  const amount = source.side === "amount" ? source.text : base === null || decimals === null ? "" : fromBaseUnits(base, decimals);
  const baseText = source.side === "base" ? source.text : base === null ? "" : base.toString();
  return (
    <section className={styles.card} aria-labelledby="units-token">
      <div className={styles.panel}>
        <h2 id="units-token">Token amounts</h2>
        <div className={styles.seg} role="radiogroup" aria-label="Common decimals">
          {["6", "8", "18"].map((choice) => (
            <button key={choice} type="button" role="radio" aria-checked={decimalsText.trim() === choice} onClick={() => setDecimalsText(choice)}>
              {choice} decimals
            </button>
          ))}
        </div>
        <div className={`${styles.fields} ${styles.two}`}>
          <NumberField
            label="Decimals"
            value={decimalsText}
            onChange={setDecimalsText}
            inputMode="numeric"
            error={decimals === null ? "Use a whole number from 0 to 36." : null}
            hint="A token's contract says how many. Most use 18."
          />
          <NumberField
            label="Amount"
            value={amount}
            onChange={(text) => setSource({ side: "amount", text })}
            error={invalid && source.side === "amount" ? `This token goes to ${decimals} decimal places at most.` : null}
          />
        </div>
        <NumberField
          label="Base units (what the contract stores)"
          value={baseText}
          onChange={(text) => setSource({ side: "base", text })}
          inputMode="numeric"
          error={invalid && source.side === "base" ? "Base units are whole numbers." : null}
          hint={baseText.length > 12 ? groupDigits(baseText) : "The amount times 10 to the power of the decimals."}
        />
      </div>
    </section>
  );
}

function BasisPoints() {
  const [source, setSource] = useState<{ side: "pct" | "bps"; text: string }>({ side: "pct", text: "0.3" });
  const value = parseAmount(source.text);
  const invalid = source.text.trim() !== "" && !Number.isFinite(value);
  const pct = source.side === "pct" ? source.text : invalid || source.text.trim() === "" ? "" : formatAmount(value / 100).replace(/,/g, "");
  const bps = source.side === "bps" ? source.text : invalid || source.text.trim() === "" ? "" : formatAmount(value * 100).replace(/,/g, "");
  return (
    <section className={styles.card} aria-labelledby="units-bps">
      <div className={styles.panel}>
        <h2 id="units-bps">Percent and basis points</h2>
        <div className={`${styles.fields} ${styles.two}`}>
          <NumberField
            label="Percent"
            value={pct}
            onChange={(text) => setSource({ side: "pct", text })}
            suffix="%"
            error={invalid && source.side === "pct" ? "Enter a number, such as 0.3." : null}
          />
          <NumberField
            label="Basis points"
            value={bps}
            onChange={(text) => setSource({ side: "bps", text })}
            suffix="bps"
            error={invalid && source.side === "bps" ? "Enter a number, such as 30." : null}
            hint="100 basis points are 1%."
          />
        </div>
      </div>
    </section>
  );
}
