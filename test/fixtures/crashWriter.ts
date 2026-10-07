/**
 * Child process for the crash tests: it writes a large value through the atomic store and is
 * SIGKILLed by the parent partway through. Not a test file — spawned by test/jsonStore.test.ts.
 *
 * Modes:
 *   staged — stage the temp file, announce it, then hang before the rename.
 *   race   — announce, then run a full write the parent interrupts at an arbitrary moment.
 */
import { writeFileAtomic, writeViaTemp } from "../../src/store/jsonStore.ts";

const [file, mode] = process.argv.slice(2);
// Big enough that the write cannot finish between the announcement and the parent's kill.
const payload = JSON.stringify({ v: "new", pad: "x".repeat(32 * 1024 * 1024) });

if (mode === "staged") {
  await writeViaTemp(file, payload, async () => {
    process.stdout.write("staged\n");
    await new Promise(() => {});
  });
} else {
  process.stdout.write("writing\n");
  await writeFileAtomic(file, payload);
  process.stdout.write("done\n");
}
