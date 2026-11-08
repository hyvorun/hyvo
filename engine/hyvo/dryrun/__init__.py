"""dApp Dry Run (SPEC §11.1): a crowd of synthetic users tries a contract before mainnet.

Untrusted bytecode only ever runs inside the job's own anvil. The agents have no keys (anvil impersonates them), and the engine
has none to anything real. A Dry Run is not an audit: it finds what its users happened to run into.

- ``spec``      what a developer submits, checked
- ``abi``       the action space from an ABI: state-changing functions, without the admin ones
- ``crowd``     the user personas
- ``prompt``    what the agents read, and the offline rules model
- ``play``      the sandbox and the rounds
- ``findings``  from what was recorded to what a developer should look at
- ``document``  ``dryrun.json``, hashed
"""
