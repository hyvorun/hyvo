"""The per-job world: one anvil node, the Stage 1 test market and the agents' wallets.

Import from the submodules (this package does not re-export them, so the pure modules stay light and
do not pull in web3):

- ``units``      exact base-unit conversions and the run.json amount and price strings
- ``amm``        ``Reserves`` and the constant-product swap formula of ``HyvoV2Router``
- ``artifacts``  loader for ``chain/artifacts/<Name>.json`` (ABI + creation bytecode)
- ``anvil``      ``AnvilInstance``: free port, own data dir, optional fork, guaranteed teardown
- ``state``      ``MarketState``, ``SwapRecord``, ``AgentBalances``
- ``market``     ``MarketConfig`` and ``Market``: deploy, quotes, swaps, ``run.json`` world objects
- ``wallets``    deterministic agent addresses, funding, token seeding, approvals, PnL
- ``verify``     replay of recorded swaps against the recorded markets of a run
"""
