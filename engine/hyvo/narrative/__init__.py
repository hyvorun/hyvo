"""The Narrative Engine (SPEC §10): what happened on the chain and in the news becomes tomorrow's simulation.

- ``signals``   one thing that was seen, and collecting them so that one dead source stops nothing
- ``rss``, ``pools``, ``farcaster``   the sources: public news, Robinhood Chain pools, casts when there is a key
- ``graph``     the rolling knowledge graph, a local SQLite file
- ``seedpack``  the day's pack, which becomes a scenario file
- ``cast``      Swarm Cast: a short post thread from a report
- ``autopsy``   a scenario from the events before a tracked token's move
"""
