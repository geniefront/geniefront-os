/** Restore the pinned paid artifacts through hpsetup; credentials never enter Vite. */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "apps/booking/package.json"));
const manifest = require.resolve("@heroui-pro/react/package.json");
const destination = dirname(manifest);
const wanted = JSON.parse(
  readFileSync(join(root, "apps/booking/package.json"), "utf8"),
).dependencies["@heroui-pro/react"];
if (JSON.parse(readFileSync(manifest, "utf8")).version !== wanted)
  throw new Error("HeroUI Pro version does not match the pinned dependency.");
const ready = () =>
  existsSync(join(destination, "dist/components/sheet/sheet.js")) &&
  existsSync(join(destination, "dist/components/stepper/stepper.js"));
if (!ready()) {
  const installer = dirname(require.resolve("hpsetup/package.json"));
  const { restoreFromCache } = await import(
    pathToFileURL(join(installer, "src/cache.js")).href
  );
  if (!restoreFromCache("react", wanted, destination) || !ready()) {
    let key = process.env.HEROUI_KEY;
    if (!key)
      try {
        key = JSON.parse(
          readFileSync(
            join(homedir(), ".config/geniefront/heroui/credentials.json"),
            "utf8",
          ),
        ).HEROUI_KEY;
      } catch {}
    if (!key)
      throw new Error(
        "Set HEROUI_KEY in private configuration or CI secrets to install HeroUI Pro.",
      );
    const { downloadFromProxy } = await import(
      pathToFileURL(join(installer, "src/download.js")).href
    );
    const { PRODUCTS } = await import(
      pathToFileURL(join(installer, "src/constants.js")).href
    );
    try {
      await downloadFromProxy(
        PRODUCTS.react,
        wanted,
        destination,
        key,
        false,
        Boolean(process.env.CI),
      );
    } catch (error) {
      throw new Error(String(error).replaceAll(key, "[REDACTED]"));
    }
  }
}
if (!ready())
  throw new Error("HeroUI Pro artifacts are missing after installation.");
console.log(`HeroUI Pro ${wanted}: ready`);
