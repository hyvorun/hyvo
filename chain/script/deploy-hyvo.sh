#!/bin/sh
# Deploys HyvoOracle and PaymentRouter with the wallet in chain/.env as owner and treasury, checks what the
# chain says afterwards, and gives the attester gas (docs/RUNBOOK.md, "Contracts and payments").
#
#   sh script/deploy-hyvo.sh <rpc url> [deployment file] [attester gas in ETH]
#
# chain/.env (gitignored) holds DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY and ATTESTER_ADDRESS. The attester's key is
# only in the Worker's secrets. Keys are never printed.
set -eu
RPC="$1"
FILE="${2:-deployments/4663.json}"
ATTESTER_GAS="${3:-0.0008}"
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

cd "$(dirname "$0")/.."
set -a
. ./.env
set +a

[ "$(cast chain-id --rpc-url "$RPC")" = "4663" ] || { echo "this RPC is not Robinhood Chain (4663)"; exit 1; }
[ -e "$FILE" ] && { echo "$FILE exists: these contracts are deployed already"; exit 1; }
echo "deployer $DEPLOYER_ADDRESS holds $(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC" --ether) ETH; attester $ATTESTER_ADDRESS"

HYVO_DEPLOYMENTS_FILE="$FILE" HYVO_OWNER="$DEPLOYER_ADDRESS" HYVO_ATTESTER="$ATTESTER_ADDRESS" HYVO_TREASURY="$DEPLOYER_ADDRESS" USDG_ADDRESS="$USDG" \
  forge script script/DeployHyvo.s.sol --rpc-url "$RPC" --broadcast --slow --private-key "$DEPLOYER_PRIVATE_KEY" 2>&1 \
  | grep -E "ONCHAIN EXECUTION COMPLETE|Paid:|Error|error|revert|fail" | cut -c1-150

read_json() { python -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$FILE" "$1"; }
ORACLE=$(read_json oracle)
ROUTER=$(read_json paymentRouter)
echo "oracle $ORACLE, router $ROUTER, block $(read_json block)"

same() { [ "$(echo "$1" | tr 'A-F' 'a-f')" = "$(echo "$2" | tr 'A-F' 'a-f')" ] && echo ok || { echo "MISMATCH: $1 vs $2"; exit 1; }; }
echo "oracle owner:       $(same "$(cast call "$ORACLE" 'owner()(address)' --rpc-url "$RPC")" "$DEPLOYER_ADDRESS")"
echo "oracle attester:    $(same "$(cast call "$ORACLE" 'attester()(address)' --rpc-url "$RPC")" "$ATTESTER_ADDRESS")"
echo "router owner:       $(same "$(cast call "$ROUTER" 'owner()(address)' --rpc-url "$RPC")" "$DEPLOYER_ADDRESS")"
echo "router treasury:    $(same "$(cast call "$ROUTER" 'treasury()(address)' --rpc-url "$RPC")" "$DEPLOYER_ADDRESS")"
echo "router allows USDG: $(cast call "$ROUTER" 'allowedToken(address)(bool)' "$USDG" --rpc-url "$RPC")"

cast send "$ATTESTER_ADDRESS" --value "${ATTESTER_GAS}ether" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --json \
  | python -c "import json,sys; r=json.load(sys.stdin); print('attester funded, tx', r['transactionHash'], 'status', r['status'])"
echo "deployer left with $(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC" --ether) ETH, attester holds $(cast balance "$ATTESTER_ADDRESS" --rpc-url "$RPC" --ether) ETH"
