/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
	/**
	 * Where the signed, content-addressed bundle is served from. Absolute in
	 * the Docker demo (the Caddy edge, e.g. http://localhost:8081) or
	 * app-relative for same-origin hosting (the GitHub Pages build sets
	 * "bundle"); resolved to an absolute URL at runtime by
	 * `api/bundleUrl.resolveBundleBaseUrl`.
	 */
	readonly VITE_BUNDLE_BASE_URL: string;
	/** Space-separated https origins a REMOTE-mode build may load product photos from. */
	readonly VITE_REMOTE_IMAGE_HOSTS?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
