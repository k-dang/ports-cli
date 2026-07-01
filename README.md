# ports-cli

Interactive CLI for finding common open localhost dev ports and closing the processes that own them.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The CLI lists open localhost TCP ports, labels common dev tools, lets you select ports with the keyboard, confirms the affected processes, then tries a graceful close before offering a force kill.

For local binary-style usage:

```bash
bun link
ports
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
