import { Sparkles } from "lucide-react";
import { DefinitionWorkbench, type DefinitionAdapter } from "../components/DefinitionWorkbench.tsx";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  queryKeys,
  updateSkill,
  validateSkill,
  type Skill,
  type SkillDetail,
} from "../lib/api.ts";

/**
 * Skills, on the same screen as Agents.
 *
 * Literally the same component: a skill is the same thing on disk as an agent — a Markdown file
 * with frontmatter, in `~/.claude/skills` or this project's `.claude/skills` — so it gets the
 * same list, the same editor, the same inline validation and the same confirmation. Two screens
 * that looked nearly alike would be two screens to keep in step.
 *
 * The one real difference is the third scope. A plugin owns its own skills, so those are listed
 * and readable but never writable, and the editor says so in the plugin's own words rather than
 * just greying the box out.
 */

const adapter: DefinitionAdapter<Skill, SkillDetail> = {
  kind: "skill",
  title: "Skills",
  pageDescription: "Skills discovered on disk, including the ones your plugins bring",
  noun: "skill",
  emptyIcon: Sparkles,
  emptyDescription:
    "A skill is a SKILL.md in its own folder under ~/.claude/skills, or under this project's .claude/skills. Create one here and Claude Code will find it.",
  // Deleting a skill is not deleting a file — ux-guidelines No. 35 means naming what actually goes.
  deleteWarning: "The whole folder goes, including any scripts, references or assets kept beside SKILL.md.",

  listKey: queryKeys.skills,
  detailKey: queryKeys.skill,
  list: listSkills,
  get: getSkill,
  create: createSkill,
  update: updateSkill,
  remove: deleteSkill,
  validate: validateSkill,
  template: (config) => config.templates.skill,

  // How the skill is actually referenced, which is not always its name: a plugin's skill is
  // reached as `<plugin>:<skill>`. Recognition over recall — the user should not have to
  // reconstruct that from the badge.
  meta: (skill) =>
    skill.ref !== skill.name ? (
      <span className="font-mono text-2xs text-fg-subtle" title="How this skill is referenced">
        {skill.ref}
      </span>
    ) : null,
};

export function SkillsPage() {
  return <DefinitionWorkbench adapter={adapter} />;
}
