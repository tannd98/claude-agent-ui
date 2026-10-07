import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { discoverAgents, toPublic } from "../src/domain/agents.ts";
import { fixtureHome, fixtureProject, put, tempHome } from "./helpers.ts";

test("lists user agents (recursive) and enabled user-scope plugin agents", async () => {
  const agents = await discoverAgents(await fixtureHome());
  const byRun = Object.fromEntries(agents.map((a) => [a.runName, a]));
  assert.deepEqual(Object.keys(byRun).sort(), ["alpha", "beta", "broken", "omc:executor"]);
  assert.equal(byRun.alpha.scope, "user");
  assert.equal(byRun.alpha.plugin, null);
  assert.equal(byRun.alpha.editable, true);
  assert.equal(byRun.alpha.readOnlyReason, null);
  assert.equal(byRun.alpha.model, "sonnet");
  assert.equal(byRun.alpha.description, "Alpha agent");
  assert.equal(byRun["omc:executor"].scope, "plugin");
  assert.equal(byRun["omc:executor"].plugin, "omc");
  assert.equal(byRun["omc:executor"].editable, false);
  assert.match(byRun["omc:executor"].readOnlyReason!, /omc plugin/);
  assert.equal(byRun["omc:executor"].name, "executor");
});

test("project agents are listed alongside user ones, with a project scope", async () => {
  const [home, project] = [await fixtureHome(), await fixtureProject()];
  const agents = await discoverAgents(home, project);
  const deployer = agents.find((a) => a.name === "deployer")!;
  assert.equal(deployer.scope, "project");
  assert.equal(deployer.editable, true);
  assert.equal(deployer.filePath, path.join(project, ".claude", "agents", "deployer.md"));
  // The user ones are still there, and nothing was dropped.
  assert.deepEqual(agents.map((a) => a.runName).sort(), ["alpha", "beta", "broken", "deployer", "omc:executor"]);
});

// Regression: defaultCwd is `~` out of the box, so without the dedupe every agent is listed twice.
test("a project that is the home directory does not double-list its agents", async () => {
  const home = await fixtureHome();
  const agents = await discoverAgents(home, home);
  assert.deepEqual(agents.map((a) => a.runName).sort(), ["alpha", "beta", "broken", "omc:executor"]);
  assert.equal(
    agents.every((a) => a.scope !== "project"),
    true,
  );
});

test("invalid frontmatter is listed, not thrown", async () => {
  const broken = (await discoverAgents(await fixtureHome())).find((a) => a.runName === "broken")!;
  assert.equal(broken.parses, false);
  assert.equal(broken.valid, false);
  assert.match(broken.error!, /invalid frontmatter/);
});

// `parses` and `valid` answer different questions: the first is "can its `skills:` list be read",
// the second is "would Claude Code load it at all". A missing `description` separates them.
test("a file that parses but fails a required field is listed as unusable, with the key named", async () => {
  const home = await fixtureHome();
  await put(path.join(home, ".claude", "agents", "nodesc.md"), "---\nname: nodesc\n---\n\nBody.\n");
  const nodesc = (await discoverAgents(home)).find((a) => a.name === "nodesc")!;
  assert.equal(nodesc.parses, true);
  assert.equal(nodesc.valid, false);
  assert.equal(nodesc.error, "`description` is required");
});

// T-12: the rule has to guard the name we would actually run. `runName` is the trimmed one, so
// a leading space used to carry `-dash` past the leading-`-` rule and into `claude --agent`.
test("a name whose leading `-` hides behind a space is listed as unloadable", async () => {
  const home = await fixtureHome();
  await put(path.join(home, ".claude", "agents", "spacey.md"), '---\nname: " -dash"\ndescription: Dashes\n---\n');
  const spacey = (await discoverAgents(home)).find((a) => a.name === "-dash")!;
  assert.equal(spacey.runName, "-dash");
  assert.equal(spacey.valid, false);
  assert.equal(spacey.error, "`name` cannot start with `-`");
});

test("missing ~/.claude yields an empty list", async () => {
  assert.deepEqual(await discoverAgents(await tempHome()), []);
});

test("public view hides the file path", async () => {
  const [agent] = await discoverAgents(await fixtureHome());
  assert.equal("filePath" in toPublic(agent), false);
});
