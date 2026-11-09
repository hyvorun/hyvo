import pkg from "../package.json" with { type: "json" };

/** The package's own version, from package.json, so the two never drift. */
export const VERSION: string = pkg.version;
