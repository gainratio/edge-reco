// In-browser query embedder. Reproduces edge-reco's Python ProductEncoder, which
// delegates to EdgeProc's TextEncoder: sentence-transformers all-MiniLM-L6-v2 with
// `normalize_embeddings=True`, i.e. mean-pooling over token embeddings followed by
// L2-normalization. transformers.js feature-extraction with
// `{ pooling: "mean", normalize: true }` is the byte-for-byte equivalent of that
// recipe, so embed(text) here matches encode_query(text) on the server to ~1e-3.
//
// The model load is async and heavy (~25 MB of weights), so the real pipeline is
// created once and cached. The Worker wrapper (createEmbedderWorkerHandler) keeps
// the load + inference off the main thread; the pure Embedder below is what the
// parity test exercises directly in Node.

import { env, pipeline } from "@huggingface/transformers";

/** The transformers.js env knobs the self-hosting config owns. Structural,
 * so tests can drive the decision with a fake instead of the real module env. */
export interface TransformersEnvLike {
	useBrowserCache: boolean;
	allowLocalModels: boolean;
	allowRemoteModels: boolean;
	localModelPath: string;
}

/** The onnxruntime-web wasm env knob the self-hosting config owns
 * (transformers.js exposes it as `env.backends.onnx.wasm`). */
export interface OrtWasmEnvLike {
	wasmPaths?: string;
	numThreads?: number;
}

/**
 * Maximum WebAssembly memory pages (64 KiB each) requested upfront in browser
 * Workers. `ort-wasm-simd-threaded.asyncify.mjs` hardcodes `maximum: 65536`
 * (4.0 GiB) on a `shared: true` memory (`SharedArrayBuffer`), which forces
 * WebKit on iPhone Safari to reserve a 4.0 GiB virtual address cage upfront
 * and fails with `RangeError: Out of memory`. Peak memory for quantized
 * `all-MiniLM-L6-v2` is ~76.5 MiB (1,224 pages); stepping `[4096, 2048, 1536]`
 * pages (256 MiB -> 128 MiB -> 96 MiB) satisfies WebAssembly import-limits
 * matching (`actualMax <= 65536`) within iOS Safari's memory budget.
 */
export const MAX_BROWSER_WASM_MEMORY_PAGES = 4096;
const FALLBACK_WASM_MEMORY_PAGES: ReadonlyArray<number> = [4096, 2048, 1536];

/**
 * Wrap `WebAssembly.Memory` so browser Workers never request a 4 GiB
 * `SharedArrayBuffer` cage upfront. Returns a restore function for tests.
 */
export function installBoundedWasmMemory(
	wasmHost: { Memory: typeof WebAssembly.Memory } = WebAssembly,
): () => void {
	const OriginalMemory = wasmHost.Memory;
	const BoundedMemory = new Proxy(OriginalMemory, {
		construct(
			target,
			args: [WebAssembly.MemoryDescriptor?],
			newTarget,
		): WebAssembly.Memory {
			const desc = args[0];
			if (
				desc === undefined ||
				typeof desc.maximum !== "number" ||
				desc.maximum <= MAX_BROWSER_WASM_MEMORY_PAGES
			) {
				return Reflect.construct(target, args, newTarget) as WebAssembly.Memory;
			}
			const initial = desc.initial ?? 256;
			let lastError: unknown;
			for (const cap of FALLBACK_WASM_MEMORY_PAGES) {
				if (cap < initial) continue;
				const bounded = { ...desc, maximum: Math.min(desc.maximum, cap) };
				try {
					return Reflect.construct(
						target,
						[bounded],
						newTarget,
					) as WebAssembly.Memory;
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		},
	});
	wasmHost.Memory = BoundedMemory;
	return () => {
		wasmHost.Memory = OriginalMemory;
	};
}

/** True when running under Node (the parity tests) rather than a browser tab
 * or Worker — the two runtimes want different model sources (see below). */
export function isNodeRuntime(): boolean {
	return typeof process !== "undefined" && process.versions?.node !== undefined;
}

/**
 * Runtime model-source config (house standard §8.1b — aml-filter's ORT-web
 * hardening config, verbatim).
 *
 * BROWSER: weights are SELF-HOSTED, not pulled from huggingface.co at runtime.
 * The app's `prebuild` hook (app/scripts/download-model.mjs) mirrors this
 * model's files into app/public/models/, so `allowLocalModels = true` +
 * `localModelPath = "/models/"` resolve every file same-origin —
 * `/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx` — and the
 * cold-CDN-blocked e2e (app/tests/e2e-offline/cold-blocked.spec.ts) proves the
 * runtime has no CDN dependency. `allowRemoteModels = false`: transformers.js
 * defaults it to true, so a missing/renamed local weight would silently fall
 * back to an UNPINNED model on the HF CDN — off, a broken /models/ mirror
 * throws instead (fail closed; belt-and-suspenders on top of the cold-blocked
 * e2e). `useBrowserCache = true`: transformers.js owns
 * its offline copy in the `transformers-cache` CacheStorage cache (safe on the
 * minified build only with vite `build.target: "es2022"` — see
 * app/vite.config.ts for the downlevel-crash scar). `wasmPaths = "/ort/"`:
 * onnxruntime-web dynamically imports its wasm loader module at runtime, and
 * its default is the jsDelivr CDN — the cold-blocked e2e caught exactly that
 * (`Failed to fetch … cdn.jsdelivr.net/npm/onnxruntime-web/....asyncify.mjs`),
 * so the runtime pair is staged same-origin by app/scripts/stage-ort-wasm.mjs.
 * `numThreads = 1`: embedder inference already runs inside a dedicated Web
 * Worker (`embedderWorker.ts`), so keeping `numThreads = 1` prevents ONNX
 * Runtime Web from spawning nested pthread Workers on iOS Safari.
 *
 * NODE (the parity tests): everything stays at the library defaults — the HF
 * hub + filesystem cache serve the fp32 export that the Python-golden
 * embedding-parity fixture pins (and onnxruntime-node needs no wasm path).
 * Build/test-time downloads are fine; it is the *runtime* CDN dependency the
 * standard bans.
 */
export function configureTransformersEnv(
	target: TransformersEnvLike,
	ortWasm: OrtWasmEnvLike,
	nodeRuntime: boolean,
): void {
	if (nodeRuntime) {
		return;
	}
	target.useBrowserCache = true;
	target.allowLocalModels = true;
	target.allowRemoteModels = false;
	target.localModelPath = "/models/";
	ortWasm.wasmPaths = "/ort/";
	ortWasm.numThreads = 1;
}

/** The live onnxruntime-web wasm env, reached through transformers.js's loosely
 * typed `env.backends`; a missing node yields an inert target (the cold-blocked
 * e2e fails loudly if the real knob ever moves). */
function ortWasmEnv(): OrtWasmEnvLike {
	const backends = env.backends as { onnx?: { wasm?: OrtWasmEnvLike } };
	return backends.onnx?.wasm ?? {};
}

if (!isNodeRuntime() && typeof WebAssembly !== "undefined") {
	installBoundedWasmMemory();
}
configureTransformersEnv(env, ortWasmEnv(), isNodeRuntime());

/** The sentence-transformers model id, mirrored as its Xenova ONNX export. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** all-MiniLM-L6-v2 produces 384-dimensional embeddings. */
export const EMBEDDING_DIM = 384;

/**
 * The ONNX quantization the BROWSER pipeline loads — pinned EXPLICITLY to the
 * `model_quantized.onnx` export the download script self-hosts, instead of
 * relying on the wasm device's implicit q8 default (the pin is a contract, not
 * a coincidence). Node deliberately keeps the default (fp32) export: the
 * embedding-parity fixture pins the Python sentence-transformers fp32 recipe.
 */
export const EMBEDDING_DTYPE = "q8";

/** Embeds a query string into a normalized 384-d vector. */
export interface Embedder {
	embed(text: string): Promise<Float32Array>;
	/** Release any worker/model resources owned by this embedder. */
	dispose?(): void;
}

/** A feature-extraction call producing a flat numeric data buffer. */
type ExtractFn = (
	text: string,
	options: { readonly pooling: "mean"; readonly normalize: boolean },
) => Promise<{ readonly data: ArrayLike<number> }>;

/** Pipeline construction options this module passes through. */
export interface PipelineOptions {
	readonly dtype?: string;
}

/** A narrowed view of transformers.js `pipeline`: building the feature-extraction
 * task yields a callable ExtractFn. The library's own overload union over every
 * task is too large for the compiler to represent (TS2590), so it is collapsed to
 * the one signature this module uses. */
type LoadFeatureExtraction = (
	task: "feature-extraction",
	model: string,
	options?: PipelineOptions,
) => Promise<ExtractFn>;

/** Browser: pin the shared {@link EMBEDDING_DTYPE} (q8). Node: default (fp32) —
 * see the dtype rationale on {@link EMBEDDING_DTYPE}. */
export function pipelineOptions(nodeRuntime: boolean): PipelineOptions {
	return nodeRuntime ? {} : { dtype: EMBEDDING_DTYPE };
}

class PipelineEmbedder implements Embedder {
	readonly #load: () => Promise<ExtractFn>;
	#extract: ExtractFn | undefined;
	#extractPromise: Promise<ExtractFn> | undefined;

	public constructor(load: () => Promise<ExtractFn>) {
		this.#load = load;
	}

	public async embed(text: string): Promise<Float32Array> {
		const extract = await this.#loadExtract();
		const output = await extract(text, {
			pooling: "mean",
			normalize: true,
		});
		const vector = Float32Array.from(output.data);
		if (vector.length !== EMBEDDING_DIM) {
			throw new Error(
				`embedding has ${vector.length} dims; expected ${EMBEDDING_DIM}`,
			);
		}
		return vector;
	}

	async #loadExtract(): Promise<ExtractFn> {
		if (this.#extract !== undefined) {
			return this.#extract;
		}
		const pending = this.#extractPromise ?? this.#load();
		this.#extractPromise = pending;
		try {
			this.#extract = await pending;
			return this.#extract;
		} catch (error) {
			this.#extractPromise = undefined;
			throw error;
		}
	}
}

async function defaultExtractFn(): Promise<ExtractFn> {
	const load = pipeline as unknown as LoadFeatureExtraction;
	return load(
		"feature-extraction",
		EMBEDDING_MODEL,
		pipelineOptions(isNodeRuntime()),
	);
}

/**
 * The default embedder, backed by the transformers.js feature-extraction
 * pipeline. The model is fetched + compiled lazily on the first embed call and
 * cached for the lifetime of the embedder.
 */
export function createEmbedder(): Embedder {
	return new PipelineEmbedder(defaultExtractFn);
}

/**
 * An embedder over an injected extractor — the seam the parity test uses to run
 * the real transformers.js pipeline in Node without a Worker.
 */
export function createEmbedderWith(load: () => Promise<ExtractFn>): Embedder {
	return new PipelineEmbedder(load);
}

export type { ExtractFn };
