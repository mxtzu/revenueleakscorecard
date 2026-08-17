/**
 * Stand-in for Next's `server-only` package.
 *
 * That package exists to make a build fail if a server module is imported into
 * client code — it has no runtime behaviour and no resolution outside a Next
 * build, so vitest cannot load it. Aliasing to this empty module means the real
 * import stays in the source, where it does its job, without the tests having
 * to drop it.
 */
export {};
