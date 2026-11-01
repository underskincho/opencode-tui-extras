import assert from "node:assert/strict";
import test from "node:test";
import { disabledSkillsStorageKey, installSkillsServer } from "../dist/skills-server.js";

const skill = (id) => ({
  id,
  name: id.toUpperCase(),
  description: `${id} description`,
  path: `/skills/${id}/SKILL.md`,
  content: `# ${id}`,
});

function fakeContext(initialDisabled = []) {
  const stored = new Map([[disabledSkillsStorageKey("project-1"), initialDisabled]]);
  const source = [skill("alpha"), skill("beta")];
  let transform;
  let handlers;
  let transformDisposed = false;
  let rpcDisposed = false;
  let setCount = 0;

  const current = async () => {
    const values = new Map(source.map((item) => [item.id, { ...item }]));
    transform?.({
      list: () => [...values.values()],
      remove: (id) => values.delete(String(id)),
    });
    return [...values.values()];
  };

  const context = {
    location: {
      directory: "/workspace",
      project: { id: "project-1", directory: "/workspace", canonical: "/workspace" },
    },
    storage: {
      get: async (key) => stored.get(key),
      set: async (key, value) => { setCount += 1; stored.set(key, value); },
    },
    skill: {
      transform: async (callback) => {
        transform = callback;
        return {
          dispose: async () => {
            transformDisposed = true;
            transform = undefined;
          },
        };
      },
      // The host API wraps the live catalog in { location, data }.
      list: async () => ({ data: await current() }),
      reload: async () => undefined,
    },
    rpc: {
      register: async (_definition, value) => {
        handlers = value;
        return { dispose: async () => { rpcDisposed = true; } };
      },
    },
    event: {
      subscribe: async function* ({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  };

  return {
    context,
    stored,
    current,
    handlers: () => handlers,
    setCount: () => setCount,
    disposed: () => ({ transform: transformDisposed, rpc: rpcDisposed }),
  };
}

// Models the production host: a registered transform is applied once, when it
// is registered (and re-applied only on reload()). Skills that load later
// appear in the live catalog WITHOUT re-running plugin transforms, and the
// host signals them with a `skill.updated` event (the sidebar re-fetches on
// that event). This is what the fakeContext above cannot reproduce, because it
// re-runs the transform on every list().
function liveContext(initialDisabled = []) {
  const source = [skill("alpha"), skill("beta")];
  const store = new Map();
  const callbacks = [];
  const stored = new Map([[disabledSkillsStorageKey("project-1"), initialDisabled]]);
  let handlers;
  let transformDisposed = false;
  let rpcDisposed = false;
  let setCount = 0;

  const materialize = () => {
    store.clear();
    for (const item of source) store.set(item.id, { ...item });
    for (const callback of callbacks) {
      callback({
        list: () => [...store.values()],
        get: (id) => store.get(String(id)),
        add: (item) => store.set(String(item.id), { ...item }),
        update: (id, mutate) => {
          const item = store.get(String(id));
          if (item) mutate(item);
        },
        remove: (id) => store.delete(String(id)),
      });
    }
  };

  const context = {
    location: {
      directory: "/workspace",
      project: { id: "project-1", directory: "/workspace", canonical: "/workspace" },
    },
    storage: {
      get: async (key) => stored.get(key),
      set: async (key, value) => { setCount += 1; stored.set(key, value); },
    },
    skill: {
      transform: async (callback) => {
        callbacks.push(callback);
        materialize();
        return {
          dispose: async () => {
            transformDisposed = true;
            callbacks.length = 0;
          },
        };
      },
      list: async () => ({ data: [...store.values()] }),
      reload: async () => materialize(),
    },
    rpc: {
      register: async (_definition, value) => {
        handlers = value;
        return { dispose: async () => { rpcDisposed = true; } };
      },
    },
    event: {
      subscribe: async function* ({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  };

  // A late-loaded Skill (e.g. a built-in one) enters the live catalog; the host
  // does not re-run plugin transforms for it.
  const addLateSkills = (items) => {
    for (const item of items) {
      source.push(item);
      store.set(item.id, { ...item });
    }
  };

  return {
    context,
    stored,
    live: () => [...store.values()],
    handlers: () => handlers,
    setCount: () => setCount,
    addLateSkills,
    disposed: () => ({ transform: transformDisposed, rpc: rpcDisposed }),
  };
}

test("uses a project-scoped storage key for disabled Skills", () => {
  assert.equal(disabledSkillsStorageKey("project-1"), "skills.disabled:project-1");
});

test("persists disabled Skills and removes them from the live catalog", async () => {
  const fake = fakeContext(["beta"]);
  const dispose = await installSkillsServer(fake.context);
  const handlers = fake.handlers();

  const initial = await handlers.list({});
  assert.deepEqual(initial.skills.map((item) => [item.id, item.disabled]), [
    ["alpha", false],
    ["beta", true],
  ]);
  assert.deepEqual((await fake.current()).map((item) => item.id), ["alpha"]);

  const enabled = await handlers.setDisabled({ id: "beta", disabled: false });
  assert.equal(enabled.skills.find((item) => item.id === "beta")?.disabled, false);
  assert.deepEqual((await fake.current()).map((item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(fake.stored.get(disabledSkillsStorageKey("project-1")), []);

  await handlers.setDisabled({ id: "alpha", disabled: true });
  assert.deepEqual((await fake.current()).map((item) => item.id), ["beta"]);
  assert.deepEqual(fake.stored.get(disabledSkillsStorageKey("project-1")), ["alpha"]);

  await dispose();
  assert.deepEqual(fake.disposed(), { transform: true, rpc: true });
});

test("setGroupDisabled toggles all members in one write and updates the catalog", async () => {
  const fake = fakeContext(["beta"]);          // alpha enabled, beta disabled
  const dispose = await installSkillsServer(fake.context);
  const handlers = fake.handlers();
  const key = disabledSkillsStorageKey("project-1");

  const before = fake.setCount();
  const result = await handlers.setGroupDisabled({ ids: ["alpha", "beta"], disabled: true });
  assert.equal(fake.setCount() - before, 1);                       // exactly one storage write
  assert.deepEqual(result.skills.filter((s) => s.id === "alpha" || s.id === "beta")
    .map((s) => [s.id, s.disabled]), [["alpha", true], ["beta", true]]);
  assert.deepEqual((await fake.current()).map((s) => s.id), []);   // both removed from live catalog
  assert.deepEqual(fake.stored.get(key), ["alpha", "beta"]);

  const before2 = fake.setCount();
  await handlers.setGroupDisabled({ ids: ["alpha", "beta"], disabled: false });
  assert.equal(fake.setCount() - before2, 1);
  assert.deepEqual((await fake.current()).map((s) => s.id), ["alpha", "beta"]);
  assert.deepEqual(fake.stored.get(key), []);

  // Unknown ids are ignored (no crash, no spurious entries).
  await handlers.setGroupDisabled({ ids: ["alpha", "ghost"], disabled: true });
  assert.deepEqual(fake.stored.get(key), ["alpha"]);

  await dispose();
  assert.deepEqual(fake.disposed(), { transform: true, rpc: true });
});

test("Skills loaded after the first catalog snapshot still appear in the catalog", async () => {
  const fake = liveContext();
  const dispose = await installSkillsServer(fake.context);
  const handlers = fake.handlers();

  // First read: only the Skills loaded before the transform was registered.
  const first = await handlers.list({});
  assert.deepEqual(first.skills.map((item) => item.id).sort(), ["alpha", "beta"]);

  // Built-in Skills load after plugin initialization. The host materializes them
  // in the live catalog and emits `skill.updated`; it does NOT re-run plugin
  // transforms. The sidebar re-fetches on that event, so the RPC list must
  // reflect the complete live catalog, not a stale snapshot.
  fake.addLateSkills([skill("opencode"), skill("report")]);
  const second = await handlers.list({});
  assert.deepEqual(second.skills.map((item) => item.id).sort(), ["alpha", "beta", "opencode", "report"]);

  // A late Skill can still be disabled: hidden from the live catalog, still
  // listed (as disabled) in the RPC catalog, persisted.
  const key = disabledSkillsStorageKey("project-1");
  await handlers.setDisabled({ id: "opencode", disabled: true });
  assert.deepEqual(fake.live().map((item) => item.id).sort(), ["alpha", "beta", "report"]);
  const third = await handlers.list({});
  assert.deepEqual(
    third.skills.filter((item) => item.id === "opencode").map((item) => [item.id, item.disabled]),
    [["opencode", true]],
  );
  assert.deepEqual(fake.stored.get(key), ["opencode"]);

  // Re-enabling restores it to the live catalog.
  await handlers.setDisabled({ id: "opencode", disabled: false });
  assert.deepEqual(fake.live().map((item) => item.id).sort(), ["alpha", "beta", "opencode", "report"]);
  const fourth = await handlers.list({});
  assert.deepEqual(
    fourth.skills.filter((item) => item.id === "opencode").map((item) => [item.id, item.disabled]),
    [["opencode", false]],
  );
  assert.deepEqual(fake.stored.get(key), []);

  await dispose();
  assert.deepEqual(fake.disposed(), { transform: true, rpc: true });
});
