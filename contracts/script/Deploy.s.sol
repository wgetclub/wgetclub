// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {WgetClubRegistry} from "../src/WgetClubRegistry.sol";

/// @notice Deploy the registry.
///
///   Sepolia:  forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
///   Mainnet:  forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
///
/// After deploying, the address must be pasted into:
///   - apps/resolver/wrangler.toml  [vars] CONTRACT_ADDRESS
///   - apps/api/wrangler.toml       [vars] CONTRACT_ADDRESS
///   - apps/web/src/contract.ts
/// Nothing resolves until all three match. See docs/ROADMAP.md M1.
contract Deploy is Script {
    function run() external returns (WgetClubRegistry reg) {
        address owner = vm.envAddress("REGISTRY_OWNER");
        address treasury = vm.envAddress("ROYALTY_RECEIVER");

        vm.startBroadcast();
        reg = new WgetClubRegistry(owner, treasury);
        vm.stopBroadcast();

        console2.log("WgetClubRegistry:", address(reg));
        // START_BLOCK comes from here. Without it the indexer scans the chain from
        // block 0 — 44 million empty blocks on Base — and never reaches this contract.
        console2.log("START_BLOCK:     ", block.number);
        console2.log("owner:           ", owner);
        console2.log("royaltyReceiver: ", treasury);
        console2.log("");
        console2.log("Paste in FOUR places (not three):");
        console2.log("  apps/resolver/wrangler.toml   CONTRACT_ADDRESS");
        console2.log("  apps/api/wrangler.toml        CONTRACT_ADDRESS");
        console2.log("  apps/api/wrangler.toml        START_BLOCK   <- the forgotten one");
        console2.log("  apps/web/src/contract.ts      REGISTRY_ADDRESSES");
    }
}
