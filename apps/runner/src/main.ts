// Thin executable entrypoint (#268): the CLI implementation lives in
// `./cli.ts` so tests can import `main` without spawning a process. There is
// deliberately no self-execution guard here: npm/npx `.bin` symlinks must
// execute this file reliably on all platforms.
import { main } from "./cli.ts";

await main();
