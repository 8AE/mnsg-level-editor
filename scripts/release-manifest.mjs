import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}
async function digestFiles(files) {
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(file.replaceAll(path.sep, "/")); digest.update("\0");
    digest.update(await readFile(file)); digest.update("\0");
  }
  return digest.digest("hex");
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const source = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", ".gitignore"];
for (const folder of ["app", "components", "core", "electron", "shared", "scripts", "tests", ".github"]) source.push(...await filesUnder(folder));
const artifacts = [];
for (const name of (await readdir("release")).sort()) {
  if (!/\.(dmg|zip|exe)$/.test(name)) continue;
  const file = path.join("release", name);
  artifacts.push({ file: name, bytes: (await stat(file)).size, sha256: hash(await readFile(file)) });
}
const manifest = {
  appVersion: pkg.version,
  generatedAt: new Date().toISOString(),
  sourceSha256: await digestFiles(source),
  lockfileSha256: hash(await readFile("package-lock.json")),
  rendererSha256: await digestFiles(await filesUnder("out")),
  desktopSha256: await digestFiles(await filesUnder("dist-electron")),
  artifacts,
  signing: "Unsigned development distributions; no release certificate configured.",
  privacy: "User-supplied ROMs and editor projects are excluded from distribution archives.",
};
await writeFile("release/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
