import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWorkspaceLog,
  fitWorkspace,
  readWorkspacePreferences,
  validCameraSnapshot,
  workspacePreset,
  type WorkspaceLog,
} from "../components/workspaceModel";

test("saved view preferences roundtrip independently and malformed storage recovers", () => {
  const current = workspacePreset("Wide");
  current.visible.rooms = false;
  current.rightRatio = 0.7;
  const state = { current, saved: { Editing: workspacePreset("Default") } };
  assert.deepEqual(
    readWorkspacePreferences(JSON.stringify(state)).current,
    current,
  );
  assert.deepEqual(
    readWorkspacePreferences(JSON.stringify(state)).saved.Editing,
    state.saved.Editing,
  );
  for (const input of [
    null,
    "broken",
    JSON.stringify({ current: { ...current, rightWidth: null } }),
    "x".repeat(65537),
  ]) {
    assert.deepEqual(
      readWorkspacePreferences(input).current,
      workspacePreset("Default"),
    );
  }
  const badNames = JSON.parse(
    '{"__proto__":{},"constructor":{},"prototype":{}}',
  );
  for (const key of Object.keys(badNames)) badNames[key] = current;
  assert.deepEqual(
    Object.keys(
      readWorkspacePreferences(JSON.stringify({ current, saved: badNames }))
        .saved,
    ),
    [],
  );
});

test("responsive docking reserves a usable scene and clamps resized panels", () => {
  const layout = workspacePreset("Default");
  layout.leftWidth = 500;
  layout.rightWidth = 640;
  layout.bottomHeight = 640;
  for (const width of [760, 800, 1000, 1280, 1920]) {
    for (const height of [240, 400, 700]) {
      const fit = fitWorkspace(layout, width, height, layout.visible);
      assert.equal(fit.compact, false);
      assert.ok(
        fit.left + fit.right + 12 + 240 <= width + 1,
        `Scene remains usable at ${width}`,
      );
      assert.ok(fit.bottom <= height);
    }
  }
  for (const zoomWidth of [400, 640, 759])
    assert.equal(
      fitWorkspace(layout, zoomWidth, 400, layout.visible).compact,
      true,
    );
  const hidden = {
    ...layout.visible,
    rooms: false,
    hierarchy: false,
    inspector: false,
    assets: false,
    console: false,
  };
  assert.deepEqual(fitWorkspace(layout, 1000, 600, hidden), {
    compact: false,
    left: 0,
    right: 0,
    bottom: 0,
  });
  assert.equal(
    fitWorkspace(layout, 1000, 600, { ...hidden, scene: false, console: true })
      .bottom,
    600,
  );
});

test("camera snapshots reject wrong-room, truncated and sparse state", () => {
  const good = {
    roomId: 465,
    position: [10, 30, -70] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  };
  assert.equal(validCameraSnapshot(good, 465), true);
  assert.equal(validCameraSnapshot(good, 466), false);
  for (const position of [[0, 0], [0, NaN, 0], new Array(3)]) {
    assert.equal(
      validCameraSnapshot(
        { ...good, position: position as [number, number, number] },
        465,
      ),
      false,
    );
  }
});

test("console keeps actual order, skips repeated adjacent notices and bounds memory", () => {
  let logs: WorkspaceLog[] = [];
  for (let i = 0; i < 250; i++)
    logs = appendWorkspaceLog(logs, {
      message: `Native warning ${i}`,
      level: "warning",
      source: "Room 465",
      time: i,
    });
  assert.equal(logs.length, 200);
  assert.equal(logs[0].message, "Native warning 50");
  assert.equal(logs.at(-1)?.id, 250);
  const last = logs.at(-1)!;
  assert.equal(appendWorkspaceLog(logs, last), logs);
  assert.equal(appendWorkspaceLog(logs, { ...last, message: " " }), logs);
  assert.equal(
    appendWorkspaceLog(logs, { ...last, level: "error" }).at(-1)?.level,
    "error",
  );
});

test("large failed-build messages are bounded before deduplication for every source", () => {
  const large =
    "MIPS compiler failure\n".repeat(200000) +
    "Final diagnostic: unresolved native symbol";
  const entry = {
    level: "error" as const,
    source: "Build",
    message: large,
    time: 1,
  };
  const logs = appendWorkspaceLog([], entry);
  assert.equal(logs[0].message.length, 32768);
  assert.match(logs[0].message, /^\[Earlier message omitted\]/);
  assert.ok(
    logs[0].message.endsWith("Final diagnostic: unresolved native symbol"),
  );
  assert.equal(
    appendWorkspaceLog(logs, { ...entry, time: 2 }),
    logs,
    "Repeated large output deduplicates its normalized UI representation",
  );
  for (const source of ["Build", "Editor", "Project", "Room 465"])
    for (const level of ["error", "warning", "info"] as const)
      assert.ok(
        appendWorkspaceLog([], { ...entry, source, level })[0].message.length <=
          32768,
      );
});
