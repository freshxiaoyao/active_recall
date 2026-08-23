import { readdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pluginDir = dirname(root);
const sourceFiles = (await readdir(pluginDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name);

await Promise.all(sourceFiles.map(async (name) => {
  const sourcePath = join(pluginDir, name);
  const targetPath = sourcePath.replace(/\.ts$/, ".js");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, stripTypeScriptTypes(source, { mode: "strip", sourceUrl: sourcePath }), "utf8");
}));
