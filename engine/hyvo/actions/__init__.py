"""On-chain market actions of the agents (spec section 6.3).

Import from the submodules (this package does not re-export them):

- ``models``    ``SwapBuy``, ``SwapSell``, ``Hold``, ``CheckMarket``, ``parse_market_action``,
                ``ActionLimits`` and ``ActionRecord`` (one run.json ``actions[]`` entry)
- ``validate``  ``validate``: bounds, balance, per-agent cap, minimum trade, holdings
- ``execute``   ``execute``: validate, swap through the world's market with a slippage limit, record
"""
