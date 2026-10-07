import { Bot, CircleAlert, Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { DefinitionWorkbench, type DefinitionAdapter } from "../components/DefinitionWorkbench.tsx";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  queryKeys,
  updateAgent,
  validateAgent,
  type Agent,
  type AgentDetail,
  type AgentSkillAccess,
} from "../lib/api.ts";
import { cn, plural } from "../lib/utils.ts";

/**
 * Agents: the list on the left, the file on the right.
 *
 * Everything about the two-pane shape, the inline validation and the delete confirmation lives
 * in DefinitionWorkbench, which Skills uses as well. What is here is only what an agent has and
 * a skill does not: the model it pins, the Run now button, and the panel answering "which
 * skills can this one actually reach".
 */

const adapter: DefinitionAdapter<Agent, AgentDetail> = {
  kind: "agent",
  title: "Agents",
  pageDescription: "Agent definitions found on disk, and what each one can reach",
  noun: "agent",
  emptyIcon: Bot,
  emptyDescription:
    "Agent definitions are Markdown files in ~/.claude/agents, or in this project's .claude/agents. Create one here and it will appear in Claude Code too.",

  listKey: queryKeys.agents,
  detailKey: queryKeys.agent,
  list: listAgents,
  get: getAgent,
  create: createAgent,
  update: updateAgent,
  remove: deleteAgent,
  validate: validateAgent,
  template: (config) => config.templates.agent,

  meta: (agent) =>
    agent.model ? (
      <span className="font-mono text-2xs text-fg-subtle" title="The model this agent pins in its frontmatter">
        {agent.model}
      </span>
    ) : null,

  actions: (agent) => <RunNowAction agent={agent} />,
  aside: (agent) => <SkillAccessPanel access={agent.skillAccess} />,
};

export function AgentsPage() {
  return <DefinitionWorkbench adapter={adapter} />;
}

/**
 * "Run now" never enqueues on the click.
 *
 * It opens the task form, where the permission mode is chosen per task with `ask` preselected —
 * the CEO's decision, because a background task has nobody there to answer a permission prompt
 * and the answer to that is to ask once, here, not to move the default for everyone.
 */
function RunNowAction({ agent }: { agent: AgentDetail }) {
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);

  return (
    <>
      {queued && (
        <span role="status" className="truncate text-xs text-fg-muted">
          Queued “{queued}”
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!agent.valid}
        // A disabled button that does not say why is a dead end — the editor below is where
        // the user fixes exactly this. Quote the problem rather than naming a cause: `valid`
        // means "Claude Code would load this", so an agent whose frontmatter parses perfectly
        // is disabled here for a missing `description`, and a tooltip blaming the YAML would
        // send the user to read the one part of the file that is already correct.
        disabledReason={`Claude Code cannot load this agent: ${
          agent.error ?? "its frontmatter is invalid"
        }. Fix that above and it can run.`}
      >
        <Play aria-hidden="true" />
        Run now
      </Button>
      <RunAgentDialog agent={agent} open={open} onOpenChange={setOpen} onQueued={setQueued} />
    </>
  );
}

/* --- Which skills this agent can reach --------------------------------------------------- */

/** The headline for each case. `reason` from the server carries the detail underneath. */
const ACCESS_SUMMARY: Record<AgentSkillAccess["kind"], string> = {
  all: "Can reach every skill",
  allowlist: "Limited to the skills it names",
  none: "Cannot reach any skill",
};

function SkillAccessPanel({ access }: { access: AgentSkillAccess }) {
  return (
    <section
      aria-label="Skills this agent can reach"
      className="shrink-0 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <h3 className="text-xs font-medium text-fg">{ACCESS_SUMMARY[access.kind]}</h3>
        {access.kind === "allowlist" && (
          <span className="text-2xs text-fg-subtle">{plural(access.skills.length, "skill")}</span>
        )}
      </div>
      {/* The server writes this sentence to be read as-is; it is the only thing that explains
       *why* an agent cannot reach a skill it names. */}
      <p className="mt-1 text-xs leading-normal text-fg-muted">{access.reason}</p>

      {access.skills.length > 0 && (
        <ul className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
          {access.skills.map((skill) => (
            <li key={skill.id}>
              <span
                title={skill.description}
                className={cn(
                  "inline-flex items-center rounded-[var(--badge-radius)] bg-surface-raised",
                  "px-[var(--badge-pad-x)] py-[var(--badge-pad-y)] font-mono text-2xs text-fg-muted",
                )}
              >
                {skill.ref}
              </span>
            </li>
          ))}
        </ul>
      )}

      {access.unknown.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-normal text-[var(--notice-fg)]">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {access.unknown.length === 1 ? "This name matches no skill on disk" : "These names match no skill on disk"}
            {": "}
            <span className="font-mono">{access.unknown.join(", ")}</span>. Check the spelling, or the skill is not
            installed.
          </span>
        </p>
      )}
    </section>
  );
}
