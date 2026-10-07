import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validateAgentContent } from "../src/domain/agentStore.ts";
import { discoverSkills } from "../src/domain/skills.ts";
import {
  assertInsideSkillsDir,
  createSkill,
  deleteSkill,
  updateSkill,
  validateSkillContent,
} from "../src/domain/skillStore.ts";
import { fixtureHome, fixtureProject, skillMd, tempHome } from "./helpers.ts";

const rejects = (p: Promise<unknown>, re: RegExp, status: number) =>
  assert.rejects(p, (err: any) => re.test(err.message) && err.status === status);

const missing = (file: string) =>
  access(file).then(
    () => false,
    () => true,
  );

test("create writes ~/.claude/skills/<name>/SKILL.md, creating the folders", async () => {
  const home = await tempHome();
  const { file, dir, scope } = await createSkill(home, skillMd("summarise"));
  assert.equal(dir, path.join(home, ".claude", "skills", "summarise"));
  assert.equal(file, path.join(dir, "SKILL.md"));
  assert.equal(scope, "user");
  assert.equal(await readFile(file, "utf8"), skillMd("summarise"));
});

test("create round-trips: the new skill is discoverable under the id it returned", async () => {
  const home = await fixtureHome();
  const { id } = await createSkill(home, skillMd("summarise", "Summarises"));
  const found = (await discoverSkills(home)).find((s) => s.id === id)!;
  assert.ok(found, "the created skill is listed");
  assert.equal(found.name, "summarise");
  assert.equal(found.description, "Summarises");
  assert.equal(found.scope, "user");
  assert.equal(found.editable, true);
});

test("create writes to the project directory when asked", async () => {
  const [home, project] = [await fixtureHome(), await fixtureProject()];
  const { id, file } = await createSkill(home, skillMd("smoke"), { projectDir: project, scope: "project" });
  assert.equal(file, path.join(project, ".claude", "skills", "smoke", "SKILL.md"));
  assert.equal((await discoverSkills(home, project)).find((s) => s.id === id)!.scope, "project");
});

test("create refuses to overwrite an existing skill, and cleans up after itself", async () => {
  const home = await fixtureHome();
  await rejects(createSkill(home, skillMd("writing")), /already exists/, 409);
  // The existing file is untouched and no temp file is left in its directory.
  const dir = path.join(home, ".claude", "skills", "writing");
  assert.equal(await readFile(path.join(dir, "SKILL.md"), "utf8"), skillMd("writing", "Writes things"));
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

// A directory holding only assets must not permanently reserve the name.
test("create fills in a SKILL.md for a directory that has none", async () => {
  const home = await fixtureHome();
  const { file } = await createSkill(home, skillMd("notaskill"));
  assert.equal(file, path.join(home, ".claude", "skills", "notaskill", "SKILL.md"));
  assert.ok(await readFile(path.join(home, ".claude", "skills", "notaskill", "README.md"), "utf8"));
});

test("a failed create leaves no empty directory behind", async () => {
  const home = await tempHome();
  const skillsRoot = path.join(home, ".claude", "skills");
  await mkdir(path.join(skillsRoot, "taken"), { recursive: true });
  await writeFile(path.join(skillsRoot, "taken", "SKILL.md"), skillMd("taken"));
  await rejects(createSkill(home, skillMd("taken")), /already exists/, 409);
  // And a fresh name that fails validation never creates a directory at all.
  await rejects(createSkill(home, "---\nname: nope\n---\n"), /`description` is required/, 400);
  assert.deepEqual((await readdir(skillsRoot)).sort(), ["taken"]);
});

test("validation: yaml, required fields, name pattern, with the field named", () => {
  const err = (content: unknown, opts?: { forNewPath: boolean }) => {
    try {
      validateSkillContent(content, opts);
    } catch (e: any) {
      return e;
    }
    throw new Error("expected a rejection");
  };
  assert.deepEqual(err("").fields, [{ field: "content", message: "the file is empty" }]);
  assert.deepEqual(
    err("---\nname: [x\n---\n").fields.map((f: any) => f.field),
    ["frontmatter"],
  );
  assert.deepEqual(
    err("---\nname: ok\n---\n").fields.map((f: any) => f.field),
    ["description"],
  );
  // The path-safe rule guards the directory `createSkill` is about to make, and only that.
  assert.deepEqual(
    err(skillMd("Bad_Name"), { forNewPath: true }).fields.map((f: any) => f.field),
    ["name"],
  );
  assert.deepEqual(validateSkillContent(skillMd("Bad_Name")), { name: "Bad_Name" });
  assert.deepEqual(validateSkillContent(skillMd("ok-1")), { name: "ok-1" });
});

// T-12: measured against claude 2.1.288 — a SKILL.md carrying only a `description` loads, and the
// CLI reads it under its directory name. `valid` means "Claude Code will load this", so it does.
test("a skill may leave `name` out: Claude Code reads it as the directory name", () => {
  assert.deepEqual(validateSkillContent("---\ndescription: No name here\n---\n"), { name: undefined });
  // A bare `name:` is YAML null, which is the same as not writing the key at all.
  assert.deepEqual(validateSkillContent("---\nname:\ndescription: No name here\n---\n"), { name: undefined });
  // An empty or blank `name` is a written one, and a written one still has to be usable.
  for (const written of ['""', '" "', "[]"]) {
    assert.throws(
      () => validateSkillContent(`---\nname: ${written}\ndescription: Present but unusable\n---\n`),
      /`name` is required/,
    );
  }
  // `createSkill` builds the directory from `name`, so there it stays required.
  assert.throws(
    () => validateSkillContent("---\ndescription: No name here\n---\n", { forNewPath: true }),
    /`name` is required/,
  );
});

// T-15: measured by reading the loader in claude 2.1.288. A filesystem skill's id is its
// *directory* name; the frontmatter `name` is read into `displayName` and nothing else, with no
// rule of any kind applied to it. The leading-`-` rule exists because `claude --agent <name>`
// parses a leading `-` as a flag, and the `:` rule because an agent id may be plugin-scoped —
// neither is ever true of a skill, so neither rule is ours to enforce on one.
test("the `-` and `:` rules are agent rules: a skill's `name` is only a display label", () => {
  // Quoted, because a leading `-` is a block-sequence indicator to YAML before any rule of ours
  // gets a say. `:` only needs quoting to keep the two cases written the same way.
  const md = (name: string) => `---\nname: "${name}"\ndescription: Odd but loadable\n---\n`;
  for (const written of ["-weird", "-", "a:b", "plugin:thing"]) {
    assert.deepEqual(validateSkillContent(md(written)), { name: written }, `skill \`name: "${written}"\``);
    // The same name on an agent, where it really is the id it runs under, is still refused.
    assert.throws(() => validateAgentContent(md(written)), /cannot (start with `-`|contain `:`)/);
  }
  // `createSkill` builds a directory from `name`, so the path-safe rule still catches both there.
  for (const written of ["-weird", "a:b"]) {
    assert.throws(() => validateSkillContent(md(written), { forNewPath: true }), /must match/);
  }
});

// T-15: the inconsistency this closes — the directory-name fallback never went through the rules a
// written `name` had to pass, so one skill was judged two ways. Now there is no rule left to skip.
test("a skill in an odd directory reads the same whether or not it writes `name`", async () => {
  const home = await tempHome();
  const dir = path.join(home, ".claude", "skills", "-weird");
  await mkdir(dir, { recursive: true });

  const fallback = "---\ndescription: Takes its name from the directory\n---\n";
  await writeFile(path.join(dir, "SKILL.md"), fallback);
  const viaDir = (await discoverSkills(home)).find((s) => s.dirName === "-weird")!;
  assert.equal(viaDir.valid, true);
  assert.equal(viaDir.error, null);
  assert.equal(viaDir.name, "-weird");

  // Writing the name the fallback already produced is the same skill, judged the same way.
  await updateSkill(home, viaDir.id, '---\nname: "-weird"\ndescription: Says the name out loud\n---\n');
  const viaName = (await discoverSkills(home)).find((s) => s.dirName === "-weird")!;
  assert.equal(viaName.valid, true);
  assert.equal(viaName.error, null);
  assert.deepEqual(
    { name: viaName.name, ref: viaName.ref },
    { name: viaDir.name, ref: viaDir.ref },
    "the written name and the fallback agree",
  );
});

test("a name-less skill lists cleanly and stays saveable", async () => {
  const home = await tempHome();
  const dir = path.join(home, ".claude", "skills", "noname");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), "---\ndescription: No name here\n---\n\n# No name\n");

  const skill = (await discoverSkills(home)).find((s) => s.dirName === "noname")!;
  assert.equal(skill.valid, true);
  assert.equal(skill.error, null);
  assert.equal(skill.name, "noname");
  assert.equal(skill.ref, "noname");

  // The `name === dirName` pin has nothing to pin: an absent name already reads as the directory.
  const next = "---\ndescription: Still no name\n---\n\n# No name\n";
  await updateSkill(home, skill.id, next);
  assert.equal(await readFile(skill.filePath, "utf8"), next);
  // A name that drifts is still refused, name-less file or not.
  await rejects(updateSkill(home, skill.id, skillMd("renamed")), /must stay "noname"/, 400);
});

test("update rewrites SKILL.md in place", async () => {
  const home = await fixtureHome();
  const writing = (await discoverSkills(home)).find((s) => s.ref === "writing")!;
  const next = skillMd("writing", "Changed");
  await updateSkill(home, writing.id, next);
  assert.equal(await readFile(writing.filePath, "utf8"), next);
  assert.equal((await discoverSkills(home)).find((s) => s.id === writing.id)!.description, "Changed");
});

test("update refuses a `name` that no longer matches the skill's directory", async () => {
  const home = await fixtureHome();
  const writing = (await discoverSkills(home)).find((s) => s.ref === "writing")!;
  await assert.rejects(updateSkill(home, writing.id, skillMd("renamed")), (err: any) => {
    assert.equal(err.status, 400);
    assert.deepEqual(
      err.fields.map((f: any) => f.field),
      ["name"],
    );
    assert.match(err.message, /must stay "writing"/);
    return true;
  });
  // The file on disk is unchanged.
  assert.equal(await readFile(writing.filePath, "utf8"), skillMd("writing", "Writes things"));
});

test("update and delete refuse plugin skills, with the reason, and unknown ids", async () => {
  const home = await fixtureHome();
  const ralph = (await discoverSkills(home)).find((s) => s.scope === "plugin")!;
  await rejects(updateSkill(home, ralph.id, skillMd("ralph")), /belongs to the omc plugin/, 403);
  await rejects(deleteSkill(home, ralph.id), /belongs to the omc plugin/, 403);
  await rejects(updateSkill(home, "nope", skillMd("x")), /not found/, 404);
  await rejects(deleteSkill(home, "nope"), /not found/, 404);
  // Nothing was touched.
  assert.equal(await readFile(ralph.filePath, "utf8"), skillMd("ralph", "Loops"));
});

test("delete removes the whole skill directory, assets included", async () => {
  const home = await fixtureHome();
  const dir = path.join(home, ".claude", "skills", "writing");
  await writeFile(path.join(dir, "notes.md"), "an asset\n");
  const writing = (await discoverSkills(home)).find((s) => s.ref === "writing")!;
  await deleteSkill(home, writing.id);
  assert.ok(await missing(dir));
  assert.equal(
    (await discoverSkills(home)).some((s) => s.id === writing.id),
    false,
  );
  // Its siblings are untouched.
  assert.ok(await readFile(path.join(home, ".claude", "skills", "broken-skill", "SKILL.md"), "utf8"));
});

test("deleting a symlinked skill removes the link, not the target", async () => {
  const home = await fixtureHome();
  const real = path.join(home, "dotfiles", "shared");
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, "SKILL.md"), skillMd("shared"));
  const link = path.join(home, ".claude", "skills", "shared");
  await symlink(real, link);
  const shared = (await discoverSkills(home)).find((s) => s.dirName === "shared")!;
  assert.ok(shared, "symlinked skill is listed");
  await deleteSkill(home, shared.id);
  assert.ok(await missing(link));
  assert.ok(await readFile(path.join(real, "SKILL.md"), "utf8"));
});

test("path containment rejects escapes", async () => {
  const home = await tempHome();
  const root = path.join(home, ".claude", "skills");
  assert.throws(() => assertInsideSkillsDir(home, path.join(root, "..", "settings.json")), /outside/);
  assert.throws(() => assertInsideSkillsDir(home, root), /outside/);
  assert.equal(assertInsideSkillsDir(home, path.join(root, "a", "SKILL.md")), path.join(root, "a", "SKILL.md"));
});
