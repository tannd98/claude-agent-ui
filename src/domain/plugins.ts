import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PluginInstall {
  /** The plugin's short name, i.e. `omc` from `omc@marketplace`. */
  plugin: string;
  installPath: string;
}

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Enabled, user-scope plugins from installed_plugins.json + settings.json enabledPlugins. */
export async function enabledUserPlugins(home: string): Promise<PluginInstall[]> {
  const installed = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const settings = await readJson(path.join(home, ".claude", "settings.json"));
  const enabled: Record<string, boolean> = settings?.enabledPlugins ?? {};
  const result: PluginInstall[] = [];
  for (const [key, installs] of Object.entries<any>(installed?.plugins ?? {})) {
    if (enabled[key] !== true || !Array.isArray(installs)) continue;
    const userInstall = installs.find((i) => i?.scope === "user" && typeof i.installPath === "string");
    if (userInstall) result.push({ plugin: key.split("@")[0], installPath: userInstall.installPath });
  }
  return result;
}
