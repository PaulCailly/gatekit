import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const USAGE = `repo-harness <command>

  init                 create repo-harness.json
  add <feature...>     vendor a gate into this repo
  update [feature...]  update managed engine files
  diff [feature...]    show what update would change
  list                 show installed features + drift
  remove <feature>     remove a feature's managed files
`;

const COMMANDS = new Set(["init", "add", "update", "diff", "list", "remove"]);

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version") {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    console.log(pkg.version);
    return 0;
  }
  if (!cmd || !COMMANDS.has(cmd)) {
    console.log(USAGE);
    return 0;
  }
  switch (cmd) {
    case "init":
      return (await import("./commands/init.js")).default(rest);
    case "add":
      return (await import("./commands/add.js")).default(rest);
    case "update":
      return (await import("./commands/update.js")).default(rest);
    case "diff":
      return (await import("./commands/diff.js")).default(rest);
    case "list":
      return (await import("./commands/list.js")).default(rest);
    case "remove":
      return (await import("./commands/remove.js")).default(rest);
    default:
      console.log(USAGE);
      return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
