import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ManagedSkill } from "./skills-model.js";

export interface SkillGroup {
  id: string;
  name: string;
  members: string[];
}

export type GroupStatus = "all-on" | "all-off" | "mixed";

export interface GroupView {
  group: SkillGroup;
  present: ManagedSkill[];
  status: GroupStatus;
  enabled: number;
  disabled: number;
}

export function skillGroupsFilePath(): string {
  return (
    process.env.OPENCODE_SKILLS_GROUPS_FILE ??
    path.join(os.homedir(), ".config", "opencode", "skills-groups.json")
  );
}

function normalizeMembers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeGroup(raw: unknown): SkillGroup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const members = normalizeMembers(record.members);
  return { id, name, members };
}

export async function loadSkillGroups(file: string = skillGroupsFilePath()): Promise<SkillGroup[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).groups)
      ? (parsed as { groups: unknown[] }).groups
      : null;
  if (!entries) return [];

  const byId = new Map<string, SkillGroup>();
  for (const entry of entries) {
    const group = normalizeGroup(entry);
    if (!group) continue;
    if (!byId.has(group.id)) byId.set(group.id, group);
  }
  return [...byId.values()];
}

export function groupStatus(
  present: readonly Pick<ManagedSkill, "id" | "disabled">[],
): { status: GroupStatus; enabled: number; disabled: number } {
  const disabled = present.filter((skill) => skill.disabled === true).length;
  const enabled = present.length - disabled;
  const status: GroupStatus = disabled === 0 ? "all-on" : enabled === 0 ? "all-off" : "mixed";
  return { status, enabled, disabled };
}

export function groupStatusGlyph(status: GroupStatus): string {
  return status === "all-on" ? "✓" : status === "all-off" ? "○" : "◑";
}

export function groupStatusLabel(status: GroupStatus, enabled: number, disabled: number): string {
  if (status === "all-on") return "All on";
  if (status === "all-off") return "All off";
  return `${enabled} on, ${disabled} off`;
}

export function groupToggleTarget(status: GroupStatus): boolean {
  return status === "all-on";
}

export function partitionSkills(
  skills: readonly ManagedSkill[],
  groups: readonly SkillGroup[],
): { groups: GroupView[]; ungrouped: ManagedSkill[] } {
  const allMembers = new Set<string>();
  for (const group of groups) for (const member of group.members) allMembers.add(member);

  const rendered: GroupView[] = [];
  for (const group of groups) {
    const memberSet = new Set(group.members);
    const present = skills.filter((skill) => memberSet.has(skill.id));
    if (present.length === 0) continue;
    rendered.push({ group, present, ...groupStatus(present) });
  }

  const ungrouped = skills.filter((skill) => !allMembers.has(skill.id));
  return { groups: rendered, ungrouped };
}
