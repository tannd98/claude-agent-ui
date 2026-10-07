import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { AgentInfo } from "../src/domain/agents.ts";
import { discoverSkills, findSkill, readSkill, resolveAgentSkills, toPublicSkill } from "../src/domain/skills.ts";
import { fixtureHome, fixtureProject, skillMd, tempHome } from "./helpers.ts";

const names = (skills: { ref: string }[]) => skills.map((s) => s.ref).sort();

test("discovers user skills and enabled user-scope plugin skills", async () => {
  const skills = await discoverSkills(await fixtureHome());
  // `notaskill/` has no SKILL.md and `loose.md` is not a directory; neither is a skill.
  // `off@mk` is disabled and `proj@mk` is project-scope, so neither contributes.
  assert.deepEqual(names(skills), ["broken-skill", "omc:ralph", "writing"]);
  const byRef = Object.fromEntries(skills.map((s) => [s.ref, s]));
  assert.equal(byRef.writing.scope, "user");
  assert.equal(byRef.writing.plugin, null);
  assert.equal(byRef.writing.editable, true);
  assert.equal(byRef.writing.readOnlyReason, null);
  assert.equal(byRef.writing.description, "Writes things");
  assert.equal(byRef.writing.dirName, "writing");
});

test("plugin skills are read-only and say why", async () => {
  const ralph = (await discoverSkills(await fixtureHome())).find((s) => s.ref === "omc:ralph")!;
  assert.equal(ralph.scope, "plugin");
  assert.equal(ralph.plugin, "omc");
  assert.equal(ralph.editable, false);
  assert.match(ralph.readOnlyReason!, /belongs to the omc plugin/);
  assert.match(ralph.readOnlyReason!, /Copy it/);
  assert.equal(ralph.name, "ralph");
});

test("project skills are listed with a project scope", async () => {
  const [home, project] = [await fixtureHome(), await fixtureProject()];
  const skills = await discoverSkills(home, project);
  assert.deepEqual(names(skills), ["broken-skill", "omc:ralph", "release", "writing"]);
  const release = skills.find((s) => s.ref === "release")!;
  assert.equal(release.scope, "project");
  assert.equal(release.filePath, path.join(project, ".claude", "skills", "release", "SKILL.md"));
});

test("a project that is the home directory does not double-list its skills", async () => {
  const home = await fixtureHome();
  assert.deepEqual(names(await discoverSkills(home, home)), ["broken-skill", "omc:ralph", "writing"]);
});

test("invalid frontmatter is listed with the reason, not thrown", async () => {
  const broken = (await discoverSkills(await fixtureHome())).find((s) => s.dirName === "broken-skill")!;
  assert.equal(broken.valid, false);
  assert.match(broken.error!, /invalid frontmatter/);
  // The directory name is the fallback, so the file is still findable in the list.
  assert.equal(broken.name, "broken-skill");
});

test("missing ~/.claude yields an empty list", async () => {
  assert.deepEqual(await discoverSkills(await tempHome()), []);
});

test("the public view hides the server-side paths; the detail view carries the body", async () => {
  const home = await fixtureHome();
  const writing = (await discoverSkills(home)).find((s) => s.ref === "writing")!;
  const published = toPublicSkill(writing);
  assert.equal("filePath" in published, false);
  assert.equal("dir" in published, false);

  const detail = await readSkill(writing);
  assert.equal(detail.content, skillMd("writing", "Writes things"));
  assert.equal(detail.body, "\n# writing\n\nBody of writing.\n");
  assert.equal("filePath" in detail, false);
});

test("an unparseable skill still opens, with an empty body", async () => {
  const home = await fixtureHome();
  const broken = (await findSkill(home, (await discoverSkills(home)).find((s) => !s.valid)!.id))!;
  const detail = await readSkill(broken);
  assert.equal(detail.body, "");
  assert.match(detail.content, /unclosed/);
});

/* --- which skills an agent can reach --------------------------------------------------- */

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a1",
  name: "alpha",
  runName: "alpha",
  description: "",
  model: null,
  scope: "user",
  plugin: null,
  editable: true,
  readOnlyReason: null,
  parses: true,
  valid: true,
  error: null,
  filePath: "/tmp/alpha.md",
  ...over,
});

test("an agent with no restrictions reaches every skill", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent(), skills, { name: "alpha", description: "d" });
  assert.equal(access.kind, "all");
  assert.deepEqual(names(access.skills), ["broken-skill", "omc:ralph", "writing"]);
  assert.deepEqual(access.unknown, []);
});

test("a `skills:` allowlist wins, and names that match nothing are reported", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent(), skills, { skills: ["writing", "omc:ralph", "ghost"] });
  assert.equal(access.kind, "allowlist");
  assert.deepEqual(names(access.skills), ["omc:ralph", "writing"]);
  assert.deepEqual(access.unknown, ["ghost"]);
});

test("a comma-separated `skills:` string is accepted too", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent(), skills, { skills: "writing, omc:ralph" });
  assert.deepEqual(names(access.skills), ["omc:ralph", "writing"]);
});

test("a narrow `tools:` list without Skill means the agent reaches nothing", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent(), skills, { tools: "Read, Write" });
  assert.equal(access.kind, "none");
  assert.deepEqual(access.skills, []);
  assert.match(access.reason, /`tools` list does not include `Skill`/);

  const withSkill = resolveAgentSkills(agent(), skills, { tools: ["Read", "Skill"] });
  assert.equal(withSkill.kind, "all");
  assert.equal(resolveAgentSkills(agent(), skills, { tools: "*" }).kind, "all");
});

test("an agent whose own frontmatter is broken resolves to nothing, with the reason", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent({ parses: false, valid: false }), skills, {});
  assert.equal(access.kind, "none");
  assert.match(access.reason, /does not parse/);
});

// An agent can be unrunnable (no `description`) and still declare perfectly readable `skills:`.
// Keying the resolver on `valid` would make it claim the file "does not parse", which is a lie.
test("an agent that parses but fails a field still resolves its allowlist", async () => {
  const skills = await discoverSkills(await fixtureHome());
  const access = resolveAgentSkills(agent({ parses: true, valid: false }), skills, { skills: ["writing"] });
  assert.equal(access.kind, "allowlist");
  assert.deepEqual(names(access.skills), ["writing"]);
});
