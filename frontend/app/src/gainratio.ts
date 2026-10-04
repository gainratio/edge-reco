// The ONE file in the Nimbus app that imports @gainratio/browser.
//
// The app needs only two things from the shared substrate: the engine's error
// codes (to map them to shopper-facing copy) and the network sentinel's channel
// (to count backend calls). Routing them through here means a library upgrade
// or swap touches one app file. gainratioBoundary.test.ts (in the engine
// package) fails on any other production importer.

export type { EngineErrorCode } from "@gainratio/browser";
export {
	isNetworkSentinelReport,
	NETWORK_SENTINEL_CHANNEL,
} from "@gainratio/browser";
