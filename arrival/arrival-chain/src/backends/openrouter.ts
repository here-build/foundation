// Back-compat shim (Stage A): the backend source moved to @here.build/arrival-inference.
// This re-export keeps the @here.build/arrival-chain/backends/openrouter subpath resolving
// for existing external consumers (saas build-router, sift). Remove in Stage B.
export * from "@here.build/arrival-inference/backends/openrouter";
