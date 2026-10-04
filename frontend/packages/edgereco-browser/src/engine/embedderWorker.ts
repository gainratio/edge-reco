// Worker entry that owns the transformers.js model: the ~25 MB weight download
// and the ONNX inference run off the main thread. One concern only — embed a
// query string and reply with the normalized vector over postMessage. The model
// is loaded once on the first request and cached by createEmbedder().

/// <reference lib="webworker" />

import { installNetworkSentinel } from "../gainratio";
import { createEmbedder, type Embedder } from "./embedder";

// The embedder Worker outlives boot and owns the model transport, so it is the
// live context a "no network after sync" counter must be able to see into.
installNetworkSentinel("embedder-worker");

/** A request to embed one query string, correlated by id. */
export interface EmbedRequest {
	readonly id: number;
	readonly text: string;
}

/** The reply: the embedding vector, or an error message, for a request id. */
export type EmbedResponse =
	| { readonly ok: true; readonly id: number; readonly vector: Float32Array }
	| { readonly ok: false; readonly id: number; readonly error: string };

let embedder: Embedder | undefined;

function getEmbedder(): Embedder {
	if (embedder === undefined) {
		embedder = createEmbedder();
	}
	return embedder;
}

self.addEventListener("message", (event: MessageEvent<EmbedRequest>) => {
	const req = event.data;
	getEmbedder()
		.embed(req.text)
		.then((vector) => {
			const response: EmbedResponse = { ok: true, id: req.id, vector };
			// Transfer the underlying buffer to avoid a copy across the boundary.
			self.postMessage(response, [vector.buffer]);
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const response: EmbedResponse = { ok: false, id: req.id, error: message };
			self.postMessage(response);
		});
});
