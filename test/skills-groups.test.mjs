import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  loadSkillGroups,
  groupStatus,
  groupStatusGlyph,
  groupStatusLabel,
  groupToggleTarget,
  partitionSkills,
} from "../dist/skills-groups.js";

const skill = (id, disabled = false) => ({ id, name: id, path: `/s/${id}`, disabled });
const group = (id, name, members) => ({ id, name, members });
const tmpFile = (content) => {
  const p = path.join(os.tmpdir(), `groups-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(p, content, "utf8");
  return p;
};

test("groupStatus reports all-on / all-off / mixed", () => {
  assert.deepEqual(groupStatus([skill("a"), skill("b")]), { status: "all-on", enabled: 2, disabled: 0 });
  assert.deepEqual(groupStatus([skill("a", true), skill("b", true)]), { status: "all-off", enabled: 0, disabled: 2 });
  assert.deepEqual(groupStatus([skill("a"), skill("b", true)]), { status: "mixed", enabled: 1, disabled: 1 });
});

test("groupToggleTarget: all-on disables all, otherwise enables all", () => {
  assert.equal(groupToggleTarget("all-on"), true);
  assert.equal(groupToggleTarget("all-off"), false);
  assert.equal(groupToggleTarget("mixed"), false);
});

test("glyphs and labels", () => {
  assert.equal(groupStatusGlyph("all-on"), "✓");
  assert.equal(groupStatusGlyph("all-off"), "○");
  assert.equal(groupStatusGlyph("mixed"), "◑");
  assert.equal(groupStatusLabel("all-on", 2, 0), "All on");
  assert.equal(groupStatusLabel("all-off", 0, 2), "All off");
  assert.equal(groupStatusLabel("mixed", 1, 1), "1 on, 1 off");
});

test("partitionSkills splits grouped vs ungrouped and skips empty groups", () => {
  const skills = [skill("a"), skill("b"), skill("c")];
  const groups = [group("g1", "One", ["a", "b"]), group("g2", "Empty", ["zzz"])];
  const { groups: rendered, ungrouped } = partitionSkills(skills, groups);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].group.id, "g1");
  assert.deepEqual(rendered[0].present.map((s) => s.id), ["a", "b"]);
  assert.equal(rendered[0].status, "all-on");
  assert.deepEqual(ungrouped.map((s) => s.id), ["c"]);
});

test("loadSkillGroups parses array and {groups:[...]} shapes, normalizes, skips invalid", async () => {
  const arr = tmpFile(JSON.stringify([
    { id: "g1", name: "One", members: ["a", "a", " b ", 5, "b"] },
    { id: "g1", name: "Dup", members: ["a"] },
    { name: "no id", members: ["a"] },
  ]));
  const got = loadSkillGroups(arr);
  assert.deepEqual([...await got].map((g) => [g.id, g.name, g.members]), [
    ["g1", "One", ["a", "b"]],
  ]);

  const obj = tmpFile(JSON.stringify({ groups: [{ id: "g", name: "G", members: ["x"] }] }));
  assert.deepEqual((await loadSkillGroups(obj)).map((g) => g.id), ["g"]);

  const bad = tmpFile("{ not json");
  assert.deepEqual(await loadSkillGroups(bad), []);

  assert.deepEqual(await loadSkillGroups(path.join(os.tmpdir(), "does-not-exist-xyz.json")), []);
});
