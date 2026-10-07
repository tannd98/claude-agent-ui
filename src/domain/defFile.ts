import { link, lstat, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { writeViaTemp } from "../store/jsonStore.ts";
import { ValidationError } from "./errors.ts";

/**
 * Shared filesystem moves for agent and skill definitions. Everything here is crash-safe in the
 * same way the state store is: write a temp file, flush it, then one atomic call to put it in place.
 */

/** Creates `file`, failing with `onExists` rather than overwriting. */
export async function createDefFile(file: string, content: string, onExists: string): Promise<void> {
  try {
    // link() fails with EEXIST instead of replacing, so creation is atomic and never overwrites.
    await writeViaTemp(file, content, (tmp) => link(tmp, file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ValidationError(onExists, 409);
    throw err;
  }
}

/** Replaces `file` in place, following a symlink so a linked definition keeps pointing at its real file. */
export async function replaceDefFile(file: string, content: string): Promise<string> {
  const real = await realpath(file);
  await writeViaTemp(real, content, (tmp) => rename(tmp, real));
  return real;
}

/**
 * Resolves `target` and refuses anything that is not inside one of `roots`.
 *
 * Symlinks are deliberately not followed: the link itself lives under the root and is what a
 * delete or an overwrite acts on. Following it here would reject every linked dotfiles setup.
 */
export function assertInsideRoots(roots: string[], target: string, label: string): string {
  const resolved = path.resolve(target);
  const ok = roots.some((root) => resolved.startsWith(path.resolve(root) + path.sep));
  if (!ok) throw new ValidationError(`path is outside ${label}`, 403);
  return resolved;
}

/** Removes a definition: a symlink is unlinked, a real directory is removed with its contents. */
export async function removeDefPath(target: string): Promise<void> {
  const st = await lstat(target);
  if (st.isSymbolicLink() || st.isFile()) {
    await unlink(target);
    return;
  }
  await rm(target, { recursive: true, force: true });
}
