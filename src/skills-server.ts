import type { Context } from "@opencode/plugin/promise/plugin";
import { managedSkills, normalizeDisabledSkillIDs, type SkillDescriptor } from "./skills-model.js";
import { SkillsRpc } from "./skills-rpc.js";

const DISABLED_SKILLS_KEY_PREFIX = "skills.disabled";

export function disabledSkillsStorageKey(projectID: string) {
  return `${DISABLED_SKILLS_KEY_PREFIX}:${projectID}`;
}

function sameLocation(
  left: { directory: string; workspaceID?: string } | undefined,
  right: { directory: string; workspaceID?: string },
) {
  if (!left) return true;
  return left.directory === right.directory && left.workspaceID === right.workspaceID;
}

export async function installSkillsServer(context: Context) {
  const storageKey = disabledSkillsStorageKey(context.location.project.id);
  const disabled = new Set(normalizeDisabledSkillIDs(await context.storage.get(storageKey)));
  // Descriptors of every Skill the plugin has seen, from either the live
  // catalog (read on every list) or the transform callback (which records the
  // source before hiding disabled Skills). The live catalog excludes disabled
  // Skills, so their descriptors must persist; otherwise toggling a Skill off
  // would make it vanish from the sidebar. Rebuilding on every read (instead of
  // one snapshot) is what makes Skills that load late — e.g. OpenCode's
  // built-in Skills, which load after plugin setup — appear once they exist.
  const seen = new Map<string, SkillDescriptor>();
  let filter: Awaited<ReturnType<Context["skill"]["transform"]>> | undefined;
  let installing: Promise<void> | undefined;

  const toDescriptor = (skill: {
    id: unknown;
    name: unknown;
    description?: string;
    autoinvoke?: boolean;
    path: unknown;
  }): SkillDescriptor => ({
    id: String(skill.id),
    name: String(skill.name),
    description: skill.description,
    autoinvoke: skill.autoinvoke,
    path: String(skill.path),
  });

  const ensureFilter = async () => {
    if (filter) return;
    if (installing) return installing;
    installing = (async () => {
      // The transform hides disabled Skills from the live catalog (so the model
      // and auto-invoke cannot use them). It also records every descriptor present
      // BEFORE hiding, so Skills disabled before this plugin started keep their
      // metadata in the sidebar even though they are absent from the live
      // catalog. The callback re-runs on every reload (e.g. after a toggle),
      // keeping the records current.
      const registration = await context.skill.transform((editor) => {
        for (const skill of editor.list()) {
          const descriptor = toDescriptor(skill);
          seen.set(descriptor.id, descriptor);
        }
        for (const id of disabled) editor.remove(id);
      });
      filter = registration;
      await context.skill.list();
    })();
    try {
      await installing;
    } finally {
      installing = undefined;
    }
  };

  const list = async () => {
    await ensureFilter();
    const live = (await context.skill.list()).data.map(toDescriptor);
    for (const descriptor of live) seen.set(descriptor.id, descriptor);
    const liveIDs = new Set(live.map((descriptor) => descriptor.id));
    for (const id of [...seen.keys()]) {
      if (!liveIDs.has(id) && !disabled.has(id)) seen.delete(id);
    }
    return { skills: managedSkills([...seen.values()], disabled) };
  };

  const rpc = await context.rpc.register(SkillsRpc, {
    list: async () => list(),
    setDisabled: async (input) => {
      const value = input as { id: string; disabled: boolean };
      if (value.disabled) disabled.add(value.id);
      else disabled.delete(value.id);
      await context.storage.set(storageKey, [...disabled].sort((left, right) => left.localeCompare(right)));
      await ensureFilter();
      await context.skill.reload();
      return list();
    },
    setGroupDisabled: async (input) => {
      const value = input as { ids: string[]; disabled: boolean };
      // Materialize the catalog first (list() reads the live catalog and
      // rebuilds it), then ignore ids not installed in this project.
      const { skills: catalogSkills } = await list();
      const known = new Set(catalogSkills.map((skill) => skill.id));
      const ids = Array.isArray(value.ids)
        ? [...new Set(value.ids.filter((id) => typeof id === "string" && id.trim() !== "").map((id) => id.trim()).filter((id) => known.has(id)))]
        : [];
      for (const id of ids) {
        if (value.disabled) disabled.add(id);
        else disabled.delete(id);
      }
      await context.storage.set(storageKey, [...disabled].sort((left, right) => left.localeCompare(right)));
      await context.skill.reload();
      return list();
    },
  });

  // The list handler rebuilds the catalog from the live catalog on every read,
  // so late-loaded Skills need no event handling to appear. The listener only
  // makes sure the disabled-Skill filter is registered as soon as any skill
  // activity happens, instead of waiting for the first RPC list call.
  const events = new AbortController();
  const listener = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: events.signal })) {
        if (event.type !== "skill.updated") continue;
        if (!sameLocation(event.location, context.location)) continue;
        await ensureFilter();
      }
    } catch (error) {
      if (!events.signal.aborted) console.warn("[opencode-tui-extras] Skills listener stopped:", error);
    }
  })();

  return async () => {
    events.abort();
    await listener;
    await installing;
    await filter?.dispose();
    await rpc.dispose();
  };
}
