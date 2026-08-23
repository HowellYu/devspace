import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertXcodeUiRef,
  parseXcodeUiSnapshot,
  pathIsInsideWorkspace,
  ProjectXcodeSession,
  resolveWorkspacePath,
  xcodeAutomationError,
  type XcodeScriptRunner,
} from "./xcode-project.js";

const RS = "\u001e";
const US = "\u001f";

test("Xcode path checks reject sibling and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-xcode-root-"));
  const inside = join(root, "App.xcodeproj");
  mkdirSync(inside);
  const outsideRoot = mkdtempSync(join(tmpdir(), "devspace-xcode-outside-"));
  const outside = join(outsideRoot, "Other.xcodeproj");
  mkdirSync(outside);
  const linkedOutside = join(root, "LinkedOutside.xcodeproj");
  symlinkSync(outside, linkedOutside);
  try {
    assert.equal(pathIsInsideWorkspace(root, inside), true);
    assert.equal(pathIsInsideWorkspace(root, outside), false);
    assert.equal(pathIsInsideWorkspace(root, linkedOutside), false);
    assert.equal(resolveWorkspacePath(root, "App.xcodeproj"), realpathSync.native(inside));
    assert.throws(() => resolveWorkspacePath(root, outside), /outside the current authorized/);
    assert.throws(() => resolveWorkspacePath(root, linkedOutside), /outside the current authorized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("Xcode status returns authorized project details only for an in-workspace active document", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-xcode-status-"));
  const project = join(root, "HealthHub.xcodeproj");
  mkdirSync(project);
  let calls = 0;
  const runner: XcodeScriptRunner = async () => {
    calls += 1;
    if (calls === 1) return project;
    return ["HealthHub.xcodeproj", "HealthHub", "My iPhone", ["HealthHub", "Tests"].join(US), ["My iPhone", "Simulator"].join(US)].join(RS);
  };
  try {
    const session = new ProjectXcodeSession(root, runner);
    const status = await session.status();
    assert.equal(status.authorizedWorkspace, true);
    assert.equal(status.workspacePath, realpathSync.native(project));
    assert.equal(status.activeScheme, "HealthHub");
    assert.deepEqual(status.schemes, ["HealthHub", "Tests"]);
    assert.deepEqual(status.runDestinations, ["My iPhone", "Simulator"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Xcode status does not reveal the path of an outside active document", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-xcode-status-root-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "devspace-xcode-status-outside-"));
  const outside = join(outsideRoot, "PrivateApp.xcodeproj");
  mkdirSync(outside);
  let calls = 0;
  try {
    const session = new ProjectXcodeSession(root, async () => {
      calls += 1;
      return outside;
    });
    const status = await session.status();
    assert.equal(status.authorizedWorkspace, false);
    assert.match(status.reason ?? "", /outside the current authorized/);
    assert.equal(status.workspacePath, undefined);
    assert.doesNotMatch(JSON.stringify(status), /PrivateApp|devspace-xcode-status-outside/);
    assert.equal(calls, 1, "outside workspace should be rejected before requesting workspace details");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("Xcode UI refs and text-only snapshots are bounded to structured elements", () => {
  assert.doesNotThrow(() => assertXcodeUiRef("x1"));
  assert.doesNotThrow(() => assertXcodeUiRef("x1.2.30"));
  assert.throws(() => assertXcodeUiRef("window1"), /latest xcode_ui_snapshot/);
  const output = [
    ["__WINDOW__", "HealthHub — Signing"].join(US),
    ["x1", "AXGroup", "Signing", "", "", "true", ""].join(US),
    ["x1.2", "AXButton", "Try Again", "Retry signing", "", "true", "AXPress"].join(US),
    ["x1.3", "AXSecureTextField", "Password", "", "[secure]", "true", "AXConfirm"].join(US),
  ].join(RS);
  const snapshot = parseXcodeUiSnapshot("/tmp/HealthHub.xcodeproj", output);
  assert.equal(snapshot.windowTitle, "HealthHub — Signing");
  assert.equal(snapshot.elements.length, 3);
  assert.equal(snapshot.elements[1]?.ref, "x1.2");
  assert.deepEqual(snapshot.elements[1]?.actions, ["AXPress"]);
  assert.equal(snapshot.elements[2]?.value, "[secure]");
});

test("Xcode UI access is rejected before Accessibility inspection when the active project is outside the workspace", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-xcode-ui-root-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "devspace-xcode-ui-outside-"));
  const outside = join(outsideRoot, "PrivateApp.xcodeproj");
  mkdirSync(outside);
  let uiCalls = 0;
  try {
    const session = new ProjectXcodeSession(
      root,
      async () => outside,
      async () => { uiCalls += 1; return ""; },
    );
    await assert.rejects(() => session.uiSnapshot(), /outside the current authorized/);
    assert.equal(uiCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("Xcode permission denials request only the permission needed by the selected Xcode surface", () => {
  const automation = xcodeAutomationError(new Error("A privilege violation occurred. (-10004)"));
  assert.match(automation.message, /Automation access for Xcode/);
  assert.match(automation.message, /xcode_ui_\* additionally requires Accessibility/);
  assert.match(automation.message, /Screen Recording and Full Disk Access are not required/);

  const accessibility = xcodeAutomationError(new Error("osascript is not allowed assistive access. (-1719)"));
  assert.match(accessibility.message, /Accessibility access required for Xcode UI control/);
  assert.match(accessibility.message, /front Xcode window/);
  assert.match(accessibility.message, /Screen Recording and Full Disk Access are not required/);
});
