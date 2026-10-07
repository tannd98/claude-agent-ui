import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ClaudeCli } from "../src/claude/claudeCli.ts";
import { AGENT_EVENTS, EventBus, SKILL_EVENTS, type BusEvent } from "../src/events.ts";
import { createApp } from "../src/server.ts";
import { agentMd, fixtureHome, fixtureProject, put, skillMd } from "./helpers.ts";

interface Api {
  (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }>;
}

interface Ctx {
  api: Api;
  home: string;
  project: string;
  /** Every event the server emitted during the test, in order. */
  events: BusEvent[];
}

/** Boots the real app over loopback with a fixture home and a separate project directory. */
async function withApi(fn: (ctx: Ctx) => Promise<void>) {
  const [home, project] = [await fixtureHome(), await fixtureProject()];
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cli = new ClaudeCli(async () => ({ stdout: "[]", stderr: "" }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    createApp({ home, cli, port, starterPrompt: "go", defaultCwd: project, dataDir: `${home}/.ui`, bus }),
  );
  const api: Api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ api, home, project, events });
  } finally {
    server.close();
  }
}

const types = (events: BusEvent[]) => events.map((e) => e.type);

test("GET /api/agents lists user, project and plugin agents with a scope each", async () => {
  await withApi(async ({ api }) => {
    const { status, body } = await api("GET", "/api/agents");
    assert.equal(status, 200);
    const byName = Object.fromEntries(body.map((a: any) => [a.runName, a]));
    assert.deepEqual(Object.keys(byName).sort(), ["alpha", "beta", "broken", "deployer", "omc:executor"]);
    assert.equal(byName.alpha.scope, "user");
    assert.equal(byName.deployer.scope, "project");
    assert.equal(byName["omc:executor"].scope, "plugin");
    for (const agent of body) assert.equal("filePath" in agent, false);
  });
});

test("GET /api/agents/:id returns the file and the skills the agent can reach", async () => {
  await withApi(async ({ api }) => {
    const alpha = (await api("GET", "/api/agents")).body.find((a: any) => a.runName === "alpha");
    const { status, body } = await api("GET", `/api/agents/${alpha.id}`);
    assert.equal(status, 200);
    assert.match(body.content, /name: alpha/);
    assert.equal(body.skillAccess.kind, "all");
    assert.deepEqual(body.skillAccess.skills.map((s: any) => s.ref).sort(), [
      "broken-skill",
      "omc:ralph",
      "release",
      "writing",
    ]);
    assert.equal((await api("GET", "/api/agents/nope")).status, 404);
  });
});

test("an agent's `skills:` allowlist narrows the detail view and flags a typo", async () => {
  await withApi(async ({ api }) => {
    const content = agentMd("picky", "Picky agent", "skills:\n  - writing\n  - ghost\n");
    const { body: created } = await api("POST", "/api/agents", { content });
    const { body } = await api("GET", `/api/agents/${created.id}`);
    assert.equal(body.skillAccess.kind, "allowlist");
    assert.deepEqual(
      body.skillAccess.skills.map((s: any) => s.ref),
      ["writing"],
    );
    assert.deepEqual(body.skillAccess.unknown, ["ghost"]);
  });
});

test("agents: create, edit and delete round-trip over HTTP and emit events", async () => {
  await withApi(async ({ api, home, events }) => {
    const created = await api("POST", "/api/agents", { content: agentMd("fresh", "Fresh agent") });
    assert.equal(created.status, 201);
    assert.equal(created.body.scope, "user");
    const file = path.join(home, ".claude", "agents", "fresh.md");
    assert.equal(await readFile(file, "utf8"), agentMd("fresh", "Fresh agent"));

    const listed = (await api("GET", "/api/agents")).body.find((a: any) => a.id === created.body.id);
    assert.equal(listed.description, "Fresh agent");

    const edited = agentMd("fresh", "Edited agent");
    assert.equal((await api("PUT", `/api/agents/${created.body.id}`, { content: edited })).status, 200);
    assert.equal(await readFile(file, "utf8"), edited);

    assert.equal((await api("DELETE", `/api/agents/${created.body.id}`)).status, 200);
    assert.equal(
      (await api("GET", "/api/agents")).body.some((a: any) => a.id === created.body.id),
      false,
    );
    assert.deepEqual(types(events), [AGENT_EVENTS.created, AGENT_EVENTS.updated, AGENT_EVENTS.removed]);
    assert.deepEqual(events[0].data, { id: created.body.id });
  });
});

test("agents can be created in the project scope", async () => {
  await withApi(async ({ api, project }) => {
    const { status, body } = await api("POST", "/api/agents", { content: agentMd("shipper"), scope: "project" });
    assert.equal(status, 201);
    assert.equal(body.scope, "project");
    assert.ok(await readFile(path.join(project, ".claude", "agents", "shipper.md"), "utf8"));
    const listed = (await api("GET", "/api/agents")).body.find((a: any) => a.id === body.id);
    assert.equal(listed.scope, "project");
  });
});

test("bad frontmatter is a 400 naming the field, not an opaque one", async () => {
  await withApi(async ({ api }) => {
    const { status, body } = await api("POST", "/api/agents", { content: "---\nname: Bad_Name\n---\n" });
    assert.equal(status, 400);
    assert.deepEqual(body.fields.map((f: any) => f.field).sort(), ["description", "name"]);
    assert.match(body.fields.find((f: any) => f.field === "name").message, /\^\[a-z0-9\]/);
    assert.ok(body.error, "there is still a plain message for anything that ignores `fields`");

    const noFrontmatter = await api("POST", "/api/skills", { content: "just a body" });
    assert.equal(noFrontmatter.status, 400);
    assert.deepEqual(
      noFrontmatter.body.fields.map((f: any) => f.field),
      ["frontmatter"],
    );
  });
});

/*
 * T-11: `valid` used to mean only "the YAML parsed", so a definition the editor refuses to save
 * could still be queued. The list, the editor and the run gates now answer the same question.
 */
test("a definition the editor would refuse to save is not runnable either", async () => {
  await withApi(async ({ api, home }) => {
    await put(path.join(home, ".claude", "agents", "nodesc.md"), "---\nname: nodesc\n---\n\nBody.\n");

    const listed = (await api("GET", "/api/agents")).body.find((a: any) => a.name === "nodesc");
    assert.equal(listed.valid, false);
    assert.equal(listed.parses, true, "the frontmatter is fine; it is the missing key that is not");
    assert.match(listed.error, /`description` is required/);

    for (const route of ["/api/runs", "/api/tasks"]) {
      const { status, body } = await api("POST", route, { agentId: listed.id, cwd: home, prompt: "go" });
      assert.equal(status, 400, route);
      assert.match(body.error, /`description` is required/, `${route} names the key, not "invalid frontmatter"`);
    }

    // And the inverse: a name this app would not have generated is still perfectly runnable.
    await put(path.join(home, ".claude", "agents", "Code-Reviewer.md"), agentMd("Code-Reviewer", "Reviews"));
    const fine = (await api("GET", "/api/agents")).body.find((a: any) => a.name === "Code-Reviewer");
    assert.equal(fine.valid, true);
    assert.equal((await api("POST", "/api/tasks", { agentId: fine.id, cwd: home, prompt: "go" })).status, 201);
  });
});

test("the validate routes check a draft without writing it", async () => {
  await withApi(async ({ api, home }) => {
    const bad = await api("POST", "/api/agents/validate", { content: "---\nname: Nope!\n---\n" });
    assert.equal(bad.status, 200, "an invalid draft mid-edit is not a failed request");
    assert.equal(bad.body.valid, false);
    assert.deepEqual(
      bad.body.fields.map((f: any) => f.field),
      ["description"],
    );

    const good = await api("POST", "/api/skills/validate", { content: skillMd("fine") });
    assert.deepEqual(good.body, { valid: true, fields: [] });

    // T-12: a leading space must not carry a leading `-` past the rule that exists to stop it.
    const spacey = await api("POST", "/api/agents/validate", { content: '---\nname: " -dash"\ndescription: D\n---\n' });
    assert.deepEqual(spacey.body, {
      valid: false,
      fields: [{ field: "name", message: "`name` cannot start with `-`" }],
    });

    // T-12: the two kinds differ on exactly one rule. Claude Code loads a SKILL.md with no
    // `name` and calls it by its directory; `claude --agent` has no directory to fall back on.
    const noName = { content: "---\ndescription: No name here\n---\n" };
    assert.deepEqual(await api("POST", "/api/skills/validate", noName).then((r) => r.body), {
      valid: true,
      fields: [],
    });
    assert.deepEqual(await api("POST", "/api/agents/validate", noName).then((r) => r.body), {
      valid: false,
      fields: [{ field: "name", message: "`name` is required" }],
    });

    // T-15: they differ on two more. A skill's `name` is a display label, never a command-line
    // argument and never a plugin-scoped id, so neither rule is real for one.
    const dashed = { content: '---\nname: "-weird"\ndescription: Odd but loadable\n---\n' };
    assert.deepEqual(await api("POST", "/api/skills/validate", dashed).then((r) => r.body), {
      valid: true,
      fields: [],
    });
    assert.deepEqual(await api("POST", "/api/agents/validate", dashed).then((r) => r.body), {
      valid: false,
      fields: [{ field: "name", message: "`name` cannot start with `-`" }],
    });

    // The editor opens files it did not create. A name this app would not generate is not an
    // error to show while someone edits that file — only the create route builds a path from it.
    const existing = await api("POST", "/api/agents/validate", { content: agentMd("Code-Reviewer") });
    assert.deepEqual(existing.body, { valid: true, fields: [] });

    // Nothing reached disk, and "validate" was not read as an id.
    assert.deepEqual((await api("GET", "/api/agents")).body.map((a: any) => a.name).sort(), [
      "alpha",
      "beta",
      "broken",
      "deployer",
      "executor",
    ]);
    await assert.rejects(readFile(path.join(home, ".claude", "agents", "Nope!.md"), "utf8"));
  });
});

test("GET /api/skills lists user, project and plugin skills; plugin ones say why they are locked", async () => {
  await withApi(async ({ api }) => {
    const { status, body } = await api("GET", "/api/skills");
    assert.equal(status, 200);
    assert.deepEqual(body.map((s: any) => s.ref).sort(), ["broken-skill", "omc:ralph", "release", "writing"]);
    const ralph = body.find((s: any) => s.ref === "omc:ralph");
    assert.equal(ralph.scope, "plugin");
    assert.equal(ralph.editable, false);
    assert.match(ralph.readOnlyReason, /belongs to the omc plugin/);
    for (const skill of body) {
      assert.equal("filePath" in skill, false);
      assert.equal("dir" in skill, false);
      assert.equal("body" in skill, false, "the list carries no bodies");
    }
  });
});

test("GET /api/skills/:id returns the file and the parsed body", async () => {
  await withApi(async ({ api }) => {
    const writing = (await api("GET", "/api/skills")).body.find((s: any) => s.ref === "writing");
    const { status, body } = await api("GET", `/api/skills/${writing.id}`);
    assert.equal(status, 200);
    assert.equal(body.content, skillMd("writing", "Writes things"));
    assert.equal(body.body, "\n# writing\n\nBody of writing.\n");
    assert.equal((await api("GET", "/api/skills/nope")).status, 404);
  });
});

test("skills: create, edit and delete round-trip over HTTP and emit events", async () => {
  await withApi(async ({ api, home, events }) => {
    const created = await api("POST", "/api/skills", { content: skillMd("summarise", "Summarises") });
    assert.equal(created.status, 201);
    const file = path.join(home, ".claude", "skills", "summarise", "SKILL.md");
    assert.equal(await readFile(file, "utf8"), skillMd("summarise", "Summarises"));

    const fetched = await api("GET", `/api/skills/${created.body.id}`);
    assert.equal(fetched.body.description, "Summarises");

    const edited = skillMd("summarise", "Summarises better");
    assert.equal((await api("PUT", `/api/skills/${created.body.id}`, { content: edited })).status, 200);
    assert.equal((await api("GET", `/api/skills/${created.body.id}`)).body.description, "Summarises better");

    assert.equal((await api("DELETE", `/api/skills/${created.body.id}`)).status, 200);
    assert.equal((await api("GET", `/api/skills/${created.body.id}`)).status, 404);
    assert.deepEqual(types(events), [SKILL_EVENTS.created, SKILL_EVENTS.updated, SKILL_EVENTS.removed]);
  });
});

test("a plugin skill cannot be edited or deleted, and the 403 explains why", async () => {
  await withApi(async ({ api, events }) => {
    const ralph = (await api("GET", "/api/skills")).body.find((s: any) => s.ref === "omc:ralph");
    const put = await api("PUT", `/api/skills/${ralph.id}`, { content: skillMd("ralph") });
    assert.equal(put.status, 403);
    assert.match(put.body.error, /belongs to the omc plugin/);
    const del = await api("DELETE", `/api/skills/${ralph.id}`);
    assert.equal(del.status, 403);
    assert.match(del.body.error, /belongs to the omc plugin/);
    // A refused write must not look like a change to anyone listening.
    assert.deepEqual(types(events), []);
  });
});

test("a plugin agent cannot be edited or deleted either", async () => {
  await withApi(async ({ api }) => {
    const executor = (await api("GET", "/api/agents")).body.find((a: any) => a.scope === "plugin");
    assert.equal((await api("PUT", `/api/agents/${executor.id}`, { content: agentMd("executor") })).status, 403);
    assert.equal((await api("DELETE", `/api/agents/${executor.id}`)).status, 403);
  });
});

test("/api/config carries both editor templates", async () => {
  await withApi(async ({ api }) => {
    const { body } = await api("GET", "/api/config");
    assert.match(body.templates.agent, /^---\nname: my-agent/);
    assert.match(body.templates.skill, /^---\nname: my-skill/);
  });
});
