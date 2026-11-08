"""Market actions an agent can choose, the run's action limits, and the run.json action record.

``parse_market_action`` turns raw model output (a mapping or a JSON string) into a ``MarketAction``
and never raises: input it cannot read becomes ``Hold`` plus a note, which the engine records with
status ``invalid``. Unknown extra keys (such as a model's "reason") are ignored.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from hyvo.runfile.models import Action
from hyvo.world.amm import BPS
from hyvo.world.units import ETH_DECIMALS, to_base_units

ACTION_KINDS = ("swap_buy", "swap_sell", "hold", "check_market")
_PREVIEW_CHARS = 60
# A market action is a flat object, so deeper JSON is refused before decoding: the C decoder
# recurses per level and can overflow the stack instead of raising RecursionError (seen on Windows
# with 100,000 levels under pytest, which killed the process).
_MAX_JSON_DEPTH = 16


class _ActionBase(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")


class SwapBuy(_ActionBase):
    """Spend ``amount_eth`` ETH (whole units) on the token."""

    kind: Literal["swap_buy"] = "swap_buy"
    amount_eth: Decimal = Field(gt=0)


class SwapSell(_ActionBase):
    """Sell ``fraction`` of the agent's token holdings (0 < fraction <= 1)."""

    kind: Literal["swap_sell"] = "swap_sell"
    fraction: Decimal = Field(gt=0, le=1)


class Hold(_ActionBase):
    """No transaction."""

    kind: Literal["hold"] = "hold"


class CheckMarket(_ActionBase):
    """No transaction; the engine puts the current ``MarketState`` into the agent's context."""

    kind: Literal["check_market"] = "check_market"


MarketAction = Annotated[SwapBuy | SwapSell | Hold | CheckMarket, Field(discriminator="kind")]
_MARKET_ACTION: TypeAdapter[MarketAction] = TypeAdapter(MarketAction)


def parse_market_action(raw: object) -> tuple[MarketAction, str | None]:
    """``(action, None)`` for a valid action, else ``(Hold(), note)``. Never raises.

    ``raw`` is a mapping such as ``{"kind": "swap_buy", "amount_eth": "0.05"}``, its JSON text,
    or an action model. ``kind`` is matched case-insensitively; JSON numbers are read as exact
    decimals.
    """
    if isinstance(raw, (SwapBuy, SwapSell, Hold, CheckMarket)):
        return raw, None
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return Hold(), "market action is not valid UTF-8"
    if isinstance(raw, str):
        if _json_depth(raw) > _MAX_JSON_DEPTH:
            return Hold(), "market action JSON is nested too deeply"
        try:
            raw = json.loads(raw, parse_float=Decimal)
        except ValueError:
            return Hold(), f"market action is not valid JSON: {_preview(raw)}"
    if not isinstance(raw, Mapping):
        return Hold(), f"market action must be an object, got {type(raw).__name__}"
    data = dict(raw)
    kind = data.get("kind")
    if isinstance(kind, str):
        data["kind"] = kind = kind.strip().lower()
    if kind not in ACTION_KINDS:
        return Hold(), f"unknown market action kind {_preview(kind)}"
    try:
        return _MARKET_ACTION.validate_python(data), None
    except ValidationError as error:
        first = error.errors()[0]
        field = ".".join(str(part) for part in first["loc"][1:]) or "action"  # loc[0] is the kind
        return Hold(), f"invalid {kind}: {field}: {first['msg']}"


def _json_depth(text: str) -> int:
    """The deepest ``[``/``{`` nesting in JSON text, not counting brackets inside strings."""
    depth = deepest = 0
    in_string = escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif char in "]}":
            depth -= 1
    return deepest


def _preview(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _PREVIEW_CHARS else text[: _PREVIEW_CHARS - 3] + "..."


@dataclass(frozen=True)
class ActionLimits:
    """The bounds every market action is validated against. ETH amounts are whole units.

    ``per_agent_cap_eth`` is the most ETH one ``swap_buy`` may spend; ``min_trade_eth`` the
    least; ``keep_eth`` the ETH an agent must still hold after a buy; ``max_slippage_bps`` how far
    below the output expected at decision time a swap may fill before it reverts. ETH amounts may
    also be given as ``str`` or ``int``; they are stored as ``Decimal`` and must be whole numbers
    of wei.
    """

    per_agent_cap_eth: Decimal
    min_trade_eth: Decimal = Decimal("0.0001")
    max_slippage_bps: int = 500
    keep_eth: Decimal = Decimal(0)

    def __post_init__(self) -> None:
        for name in ("per_agent_cap_eth", "min_trade_eth", "keep_eth"):
            object.__setattr__(self, name, _eth_amount(getattr(self, name), name))
        if self.cap_wei <= 0:
            raise ValueError("per_agent_cap_eth must be > 0")
        if self.min_trade_wei > self.cap_wei:
            raise ValueError("min_trade_eth must not exceed per_agent_cap_eth")
        bps = self.max_slippage_bps
        if isinstance(bps, bool) or not isinstance(bps, int) or not 0 <= bps <= BPS:
            raise ValueError(f"max_slippage_bps must be an int in 0..{BPS}, got {bps!r}")

    @property
    def cap_wei(self) -> int:
        return to_base_units(self.per_agent_cap_eth, ETH_DECIMALS)

    @property
    def min_trade_wei(self) -> int:
        return to_base_units(self.min_trade_eth, ETH_DECIMALS)

    @property
    def keep_wei(self) -> int:
        return to_base_units(self.keep_eth, ETH_DECIMALS)


def _eth_amount(value: object, name: str) -> Decimal:
    """``value`` as a Decimal ETH amount that is a whole number of wei and not negative."""
    if isinstance(value, bool) or not isinstance(value, (Decimal, str, int)):
        raise TypeError(f"{name} must be a Decimal, str or int, got {type(value).__name__}")
    try:
        amount = value if isinstance(value, Decimal) else Decimal(value)
        to_base_units(amount, ETH_DECIMALS)
    except (ValueError, ArithmeticError) as error:  # decimal.InvalidOperation is an ArithmeticError
        raise ValueError(f"{name} is not a valid ETH amount: {value!r} ({error})") from None
    return amount


class ActionRecord(Action):
    """One entry of a round's ``actions[]`` in run.json (docs/RUN_FORMAT.md).

    It is the runfile ``Action`` model, so the fields and the kind/status rules are the ones
    run.json is validated with; this subclass is frozen, builds by field name and adds ``to_dict``.
    """

    model_config = ConfigDict(frozen=True, validate_by_name=True)

    @classmethod
    def invalid(cls, agent_id: str, note: str) -> ActionRecord:
        """A rejected action: recorded as ``hold`` with status ``invalid`` and the reason."""
        return cls(
            agent_id=agent_id,
            kind="hold",
            amount_in=None,
            amount_out=None,
            tx_hash=None,
            status="invalid",
            note=note,
        )

    @classmethod
    def no_tx(cls, agent_id: str, kind: Literal["hold", "check_market"]) -> ActionRecord:
        """A ``hold`` or ``check_market``: status ``ok`` and no transaction."""
        return cls(
            agent_id=agent_id,
            kind=kind,
            amount_in=None,
            amount_out=None,
            tx_hash=None,
            status="ok",
            note=None,
        )

    def to_dict(self) -> dict[str, Any]:
        """The run.json form: ``agentId, kind, amountIn, amountOut, txHash, status, note``."""
        return self.model_dump(by_alias=True)
