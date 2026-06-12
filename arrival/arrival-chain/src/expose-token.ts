/**
 * Frozen-token derivation for the exposed / overridable surface.
 *
 * The "superpowered define" family (`define/exposed`, `define/overridable`)
 * mints a PROJECT-GLOBAL frozen identity for each declaration. The token is
 * derived from the lexical name at registration time, then frozen — a later
 * rename of the binding must NOT change the external referent (deployments bind
 * to the token, not the name). Cross-declaration collisions get a deterministic
 * `-2`, `-3` … suffix.
 *
 * Salvaged from the reverted arrival-scheme `exposed.ts` (5b9171fba): the
 * name→token shape belongs in arrival-CHAIN (a domain concept — the expose
 * surface), never in the pure interpreter core.
 */

/** Namespace prefix for every minted token. */
export const TOKEN_PREFIX = "pub/";

/**
 * Derive the (un-suffixed) token candidate from a lexical name: kebab-case the
 * name under the `pub/` namespace. Pure name→shape; collision suffixing is the
 * job of a {@link TokenMinter} that sees the whole declaration set.
 */
export function deriveToken(name: string): string {
  const kebab = name
    // camelCase / PascalCase → kebab
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return TOKEN_PREFIX + kebab;
}

/**
 * A stateful minter that freezes derived tokens and collision-suffixes them in
 * the order names are presented. One minter per registration scope (a run / a
 * static scan) so the suffixing is deterministic and stable across a draft.
 */
export interface TokenMinter {
  /** Derive-then-freeze a token for `name`, suffixing on collision. */
  mint(name: string): string;
}

/** Build a fresh collision-suffixing minter. */
export function createTokenMinter(): TokenMinter {
  const taken = new Set<string>();
  const claim = (candidate: string): string => {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
    let n = 2;
    while (taken.has(`${candidate}-${n}`)) n++;
    const minted = `${candidate}-${n}`;
    taken.add(minted);
    return minted;
  };
  return { mint: (name: string) => claim(deriveToken(name)) };
}
