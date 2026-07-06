# ports-cli

Interactive CLI for finding common open localhost dev ports and closing the processes that own them.

## Install (npx / bunx, no install step)

```bash
bunx @k-dang/ports-cli
# or
npx --package=@k-dang/ports-cli ports
```

The published package is a plain Node-compatible bundle, so this works whether or not you have Bun installed. On Windows, bare `npx @k-dang/ports-cli` fails with `'ports' is not recognized` — this is a bug in npx's implicit bin-resolution path, not specific to this package; the `--package=` form above works around it (and works everywhere else too).

## Development

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The CLI lists open localhost TCP ports owned by dev runtimes (node, bun, deno, python, ruby, php, java, dotnet), labels common dev tools (falling back to the process command line, e.g. `server.js` or `next dev`, for unrecognized ports), lets you select ports with the keyboard, confirms the affected processes, then tries a graceful close before offering a force kill. Databases and other system services are not shown.

For local binary-style usage:

```bash
bun link
ports
```

## Releasing

Push a tag matching `v*` (e.g. `git tag v0.1.0 && git push --tags`) to trigger `.github/workflows/release.yml`, which creates a GitHub release and publishes the npm package (`bun publish`, bundling `index.ts` into `dist/cli.js` for Node via the `build:npm`/`prepublishOnly` scripts) so `npx`/`bunx` stay in sync with each tagged release. To build the npm bundle locally instead: `bun run build:npm` (outputs `dist/cli.js`).

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
