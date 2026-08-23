import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RECORD_SEPARATOR = "\u001e";
const LIST_SEPARATOR = "\u001f";
const MAX_BUILD_LOG = 24_000;
const MAX_UI_ELEMENTS = 250;
const DEFAULT_UI_DEPTH = 6;

export interface XcodeStatus {
  running: boolean;
  authorizedWorkspace: boolean;
  workspacePath?: string;
  workspaceName?: string;
  activeScheme?: string;
  activeRunDestination?: string;
  schemes?: string[];
  runDestinations?: string[];
  reason?: string;
}

export interface XcodeActionResult {
  action: XcodeAction;
  workspacePath: string;
  completed: boolean;
  status: string;
  buildLog?: string;
}

export interface XcodeUiElementSnapshot {
  ref: string;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  enabled?: boolean;
  actions: string[];
}

export interface XcodeUiSnapshot {
  workspacePath: string;
  windowTitle?: string;
  elements: XcodeUiElementSnapshot[];
}

export type XcodeAction = "build" | "clean" | "run" | "test" | "debug";
export type XcodeScriptRunner = (script: string, args?: string[]) => Promise<string>;

export class ProjectXcodeSession {
  readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    private readonly runScript: XcodeScriptRunner = runAppleScript,
    private readonly runUiScript: XcodeScriptRunner = runAppleScript,
  ) {
    this.workspaceRoot = canonicalExistingPath(workspaceRoot);
  }

  async status(): Promise<XcodeStatus> {
    if (process.platform !== "darwin") {
      return { running: false, authorizedWorkspace: false, reason: "Xcode automation is supported on macOS only." };
    }

    let activePath: string;
    try {
      activePath = (await this.runScript(activeWorkspacePathScript())).trim();
    } catch (error) {
      throw xcodeAutomationError(error);
    }

    if (activePath === "__DEVSPACE_XCODE_NOT_RUNNING__") {
      return { running: false, authorizedWorkspace: false, reason: "Xcode is not running." };
    }
    if (activePath === "__DEVSPACE_XCODE_NO_WORKSPACE__" || activePath.length === 0) {
      return { running: true, authorizedWorkspace: false, reason: "Xcode has no active workspace document." };
    }
    if (!pathIsInsideWorkspace(this.workspaceRoot, activePath)) {
      return {
        running: true,
        authorizedWorkspace: false,
        reason: "The active Xcode workspace is outside the current authorized DevSpace project.",
      };
    }

    const canonicalPath = canonicalExistingPath(activePath);
    let details: string;
    try {
      details = await this.runScript(workspaceDetailsScript(), [canonicalPath]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    const [workspaceName = "", activeScheme = "", activeRunDestination = "", schemes = "", destinations = ""] = details.trim().split(RECORD_SEPARATOR);
    return {
      running: true,
      authorizedWorkspace: true,
      workspacePath: canonicalPath,
      workspaceName: workspaceName || undefined,
      activeScheme: activeScheme || undefined,
      activeRunDestination: activeRunDestination || undefined,
      schemes: splitList(schemes),
      runDestinations: splitList(destinations),
    };
  }

  async openWorkspace(inputPath: string): Promise<XcodeStatus> {
    const projectPath = resolveWorkspacePath(this.workspaceRoot, inputPath);
    if (!existsSync(projectPath)) throw new Error(`Xcode project does not exist: ${inputPath}`);
    if (!projectPath.endsWith(".xcodeproj") && !projectPath.endsWith(".xcworkspace")) {
      throw new Error("xcode_open_workspace only accepts .xcodeproj or .xcworkspace paths inside the current workspace.");
    }
    try {
      await this.runScript(openWorkspaceScript(), [projectPath]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.authorizedWorkspace && status.workspacePath === canonicalExistingPath(projectPath)) return status;
      await sleep(200);
    }
    throw new Error("Xcode opened the project but it did not become the active authorized workspace within 10 seconds.");
  }

  async openFile(inputPath: string): Promise<{ opened: true; path: string }> {
    const filePath = resolveWorkspacePath(this.workspaceRoot, inputPath);
    if (!existsSync(filePath)) throw new Error(`Xcode file does not exist: ${inputPath}`);
    await this.requireAuthorizedWorkspace();
    try {
      await this.runScript(openFileScript(), [filePath]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    return { opened: true, path: filePath };
  }

  async selectScheme(name: string): Promise<XcodeStatus> {
    if (!name.trim()) throw new Error("Scheme name is required.");
    const status = await this.requireAuthorizedWorkspace();
    try {
      await this.runScript(selectSchemeScript(), [status.workspacePath!, name]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    return this.status();
  }

  async selectRunDestination(name: string): Promise<XcodeStatus> {
    if (!name.trim()) throw new Error("Run destination name is required.");
    const status = await this.requireAuthorizedWorkspace();
    try {
      await this.runScript(selectRunDestinationScript(), [status.workspacePath!, name]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    return this.status();
  }

  async action(action: XcodeAction, timeoutSeconds?: number): Promise<XcodeActionResult> {
    const status = await this.requireAuthorizedWorkspace();
    const waitSeconds = timeoutSeconds ?? (action === "build" || action === "clean" || action === "test" ? 120 : 0);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
      throw new Error("Xcode action timeout must be an integer from 0 to 600 seconds.");
    }
    let output: string;
    try {
      output = await this.runScript(actionScript(), [status.workspacePath!, action, String(waitSeconds)]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    const [completedText = "false", actionStatus = "unknown", buildLog = ""] = output.split(RECORD_SEPARATOR);
    return {
      action,
      workspacePath: status.workspacePath!,
      completed: completedText.trim().toLowerCase() === "true",
      status: actionStatus.trim() || "unknown",
      buildLog: buildLog ? buildLog.slice(0, MAX_BUILD_LOG) : undefined,
    };
  }

  async uiSnapshot(maxDepth = DEFAULT_UI_DEPTH): Promise<XcodeUiSnapshot> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
      throw new Error("Xcode UI snapshot depth must be an integer from 1 to 8.");
    }
    const status = await this.requireAuthorizedWorkspace();
    let output: string;
    try {
      output = await this.runUiScript(xcodeUiSnapshotScript(), [
        status.workspacePath!,
        String(maxDepth),
        String(MAX_UI_ELEMENTS),
      ]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    return parseXcodeUiSnapshot(status.workspacePath!, output);
  }

  async uiClick(ref: string): Promise<XcodeUiSnapshot> {
    assertXcodeUiRef(ref);
    const status = await this.requireAuthorizedWorkspace();
    try {
      await this.runUiScript(xcodeUiClickScript(), [status.workspacePath!, ref]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    await sleep(100);
    return this.uiSnapshot();
  }

  async uiSetValue(ref: string, text: string): Promise<XcodeUiSnapshot> {
    assertXcodeUiRef(ref);
    if (text.length > 20_000) throw new Error("Xcode UI text input is limited to 20,000 characters per call.");
    const status = await this.requireAuthorizedWorkspace();
    try {
      await this.runUiScript(xcodeUiSetValueScript(), [status.workspacePath!, ref, text]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    await sleep(80);
    return this.uiSnapshot();
  }

  async stop(): Promise<{ stopped: true; workspacePath: string }> {
    const status = await this.requireAuthorizedWorkspace();
    try {
      await this.runScript(stopScript(), [status.workspacePath!]);
    } catch (error) {
      throw xcodeAutomationError(error);
    }
    return { stopped: true, workspacePath: status.workspacePath! };
  }

  private async requireAuthorizedWorkspace(): Promise<XcodeStatus> {
    const status = await this.status();
    if (!status.authorizedWorkspace || !status.workspacePath) {
      throw new Error(status.reason ?? "No authorized Xcode workspace is active.");
    }
    return status;
  }
}

export function pathIsInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  let root: string;
  let path: string;
  try {
    root = canonicalExistingPath(workspaceRoot);
    path = canonicalExistingPath(candidate);
  } catch {
    return false;
  }
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

export function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  const root = canonicalExistingPath(workspaceRoot);
  const absolute = resolve(root, candidate);
  if (!pathIsInsideWorkspace(root, absolute)) {
    throw new Error("Xcode path is outside the current authorized DevSpace workspace.");
  }
  return canonicalExistingPath(absolute);
}

export async function runAppleScript(script: string, args: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, ...args], {
    encoding: "utf8",
    timeout: 620_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

export function xcodeAutomationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not allowed assistive access|assistive access|accessibility.*denied|-1719|-25211/i.test(message)) {
    return new Error(
      "macOS denied Accessibility access required for Xcode UI control. DevSpace exposes this only through project-gated xcode_ui_* tools targeting the front Xcode window; Screen Recording and Full Disk Access are not required.",
    );
  }
  if (/privilege violation|-10004|not authorized to send apple events|-1743|not permitted to send apple events/i.test(message)) {
    return new Error(
      "macOS denied Automation access for Xcode. Native Xcode commands require Xcode Automation; xcode_ui_* additionally requires Accessibility. Screen Recording and Full Disk Access are not required.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export function assertXcodeUiRef(ref: string): void {
  if (!/^x[1-9]\d*(?:\.[1-9]\d*)*$/.test(ref)) {
    throw new Error("Xcode UI ref must come from the latest xcode_ui_snapshot (for example x1 or x1.2.3).");
  }
}

export function parseXcodeUiSnapshot(workspacePath: string, output: string): XcodeUiSnapshot {
  const records = output.trim().split(RECORD_SEPARATOR).filter(Boolean);
  let windowTitle: string | undefined;
  const elements: XcodeUiElementSnapshot[] = [];
  for (const record of records) {
    const fields = record.split(LIST_SEPARATOR);
    if (fields[0] === "__WINDOW__") {
      windowTitle = fields[1] || undefined;
      continue;
    }
    const [ref = "", role = "", name = "", description = "", value = "", enabled = "", actions = ""] = fields;
    if (!/^x[1-9]\d*(?:\.[1-9]\d*)*$/.test(ref)) continue;
    elements.push({
      ref,
      role: role || undefined,
      name: name || undefined,
      description: description || undefined,
      value: value || undefined,
      enabled: enabled === "true" ? true : enabled === "false" ? false : undefined,
      actions: actions ? actions.split(",").map((item) => item.trim()).filter(Boolean) : [],
    });
  }
  return { workspacePath, windowTitle, elements };
}

function canonicalExistingPath(value: string): string {
  const absolute = resolve(value);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function splitList(value: string): string[] {
  return value ? value.split(LIST_SEPARATOR).map((item) => item.trim()).filter(Boolean) : [];
}

function xcodeUiSnapshotScript(): string {
  return `property itemCount : 0

on replaceText(sourceText, findText, replacementText)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set pieces to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set outputText to pieces as text
  set AppleScript's text item delimiters to oldDelimiters
  return outputText
end replaceText

on cleanField(theValue)
  try
    if theValue is missing value then return ""
    set textValue to theValue as text
  on error
    return ""
  end try
  set textValue to my replaceText(textValue, ASCII character 30, " ")
  set textValue to my replaceText(textValue, ASCII character 31, " ")
  set textValue to my replaceText(textValue, return, " ")
  set textValue to my replaceText(textValue, linefeed, " ")
  if (count of textValue) > 500 then set textValue to text 1 thru 500 of textValue
  return textValue
end cleanField

on joinItems(valuesList, delimiterText)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiterText
  set resultText to valuesList as text
  set AppleScript's text item delimiters to oldDelimiters
  return resultText
end joinItems

on verifyWorkspace(expectedPath)
  tell application "Xcode"
    if not running then error "Xcode is not running."
    try
      set currentPath to path of active workspace document
    on error
      error "Xcode has no active workspace document."
    end try
  end tell
  if currentPath is not expectedPath then error "The active Xcode workspace changed outside the authorized project."
end verifyWorkspace

on walkElement(theElement, refText, depthValue, maxDepthValue, maxItemsValue)
  if itemCount >= maxItemsValue then return {}
  set itemCount to itemCount + 1
  set listSeparator to ASCII character 31
  tell application "System Events"
    set roleText to ""
    set nameText to ""
    set descriptionText to ""
    set valueText to ""
    set enabledText to ""
    set actionNames to {}
    try
      set roleText to my cleanField(role of theElement)
    end try
    try
      set nameText to my cleanField(name of theElement)
    end try
    try
      set descriptionText to my cleanField(description of theElement)
    end try
    if roleText is "AXSecureTextField" then
      set valueText to "[secure]"
    else
      try
        set valueText to my cleanField(value of theElement)
      end try
    end if
    try
      set enabledText to (enabled of theElement) as text
    end try
    try
      repeat with actionItem in actions of theElement
        try
          set end of actionNames to my cleanField(name of actionItem)
        end try
      end repeat
    end try
    set childItems to {}
    if depthValue < maxDepthValue then
      try
        set childItems to UI elements of theElement
      end try
    end if
  end tell

  set outputLine to refText & listSeparator & roleText & listSeparator & nameText & listSeparator & descriptionText & listSeparator & valueText & listSeparator & enabledText & listSeparator & my joinItems(actionNames, ",")
  set outputLines to {outputLine}
  if depthValue < maxDepthValue then
    repeat with childIndex from 1 to count of childItems
      if itemCount >= maxItemsValue then exit repeat
      set childElement to item childIndex of childItems
      set childRef to refText & "." & childIndex
      set childLines to my walkElement(childElement, childRef, depthValue + 1, maxDepthValue, maxItemsValue)
      set outputLines to outputLines & childLines
    end repeat
  end if
  return outputLines
end walkElement

on run argv
  set expectedPath to item 1 of argv
  set maxDepthValue to (item 2 of argv) as integer
  set maxItemsValue to (item 3 of argv) as integer
  set itemCount to 0
  set recordSeparator to ASCII character 30
  set listSeparator to ASCII character 31
  my verifyWorkspace(expectedPath)
  tell application "System Events"
    if not (exists process "Xcode") then error "Xcode is not running."
    tell process "Xcode"
      set frontmost to true
      if (count of windows) is 0 then error "Xcode has no visible window."
      set targetWindow to front window
      set windowName to ""
      try
        set windowName to my cleanField(name of targetWindow)
      end try
      set rootElements to UI elements of targetWindow
    end tell
  end tell
  set outputRecords to {"__WINDOW__" & listSeparator & windowName}
  repeat with rootIndex from 1 to count of rootElements
    if itemCount >= maxItemsValue then exit repeat
    set rootElement to item rootIndex of rootElements
    set rootLines to my walkElement(rootElement, "x" & rootIndex, 1, maxDepthValue, maxItemsValue)
    set outputRecords to outputRecords & rootLines
  end repeat
  my verifyWorkspace(expectedPath)
  return my joinItems(outputRecords, recordSeparator)
end run`;
}

function xcodeUiClickScript(): string {
  return `${xcodeUiRefHelpersScript()}

on run argv
  set expectedPath to item 1 of argv
  set refText to item 2 of argv
  my verifyWorkspace(expectedPath)
  tell application "System Events"
    if not (exists process "Xcode") then error "Xcode is not running."
    tell process "Xcode"
      set frontmost to true
      if (count of windows) is 0 then error "Xcode has no visible window."
      set targetElement to my resolveRef(front window, refText)
      click targetElement
    end tell
  end tell
  my verifyWorkspace(expectedPath)
  return "ok"
end run`;
}

function xcodeUiSetValueScript(): string {
  return `${xcodeUiRefHelpersScript()}

on run argv
  set expectedPath to item 1 of argv
  set refText to item 2 of argv
  set requestedValue to item 3 of argv
  my verifyWorkspace(expectedPath)
  tell application "System Events"
    if not (exists process "Xcode") then error "Xcode is not running."
    tell process "Xcode"
      set frontmost to true
      if (count of windows) is 0 then error "Xcode has no visible window."
      set targetElement to my resolveRef(front window, refText)
      set roleText to ""
      try
        set roleText to role of targetElement
      end try
      if roleText is "AXSecureTextField" then error "DevSpace refuses to enter values into secure Xcode fields."
      set value of targetElement to requestedValue
    end tell
  end tell
  my verifyWorkspace(expectedPath)
  return "ok"
end run`;
}

function xcodeUiRefHelpersScript(): string {
  return `on verifyWorkspace(expectedPath)
  tell application "Xcode"
    if not running then error "Xcode is not running."
    try
      set currentPath to path of active workspace document
    on error
      error "Xcode has no active workspace document."
    end try
  end tell
  if currentPath is not expectedPath then error "The active Xcode workspace changed outside the authorized project."
end verifyWorkspace

on refParts(refText)
  if refText does not start with "x" then error "Invalid Xcode UI ref."
  set pathText to text 2 thru -1 of refText
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "."
  set parts to text items of pathText
  set AppleScript's text item delimiters to oldDelimiters
  return parts
end refParts

on resolveRef(targetWindow, refText)
  set parts to my refParts(refText)
  set currentElement to targetWindow
  tell application "System Events"
    repeat with partText in parts
      set childIndex to (partText as text) as integer
      set childItems to UI elements of currentElement
      if childIndex < 1 or childIndex > (count of childItems) then error "Xcode UI ref is stale; take a new xcode_ui_snapshot."
      set currentElement to item childIndex of childItems
    end repeat
  end tell
  return currentElement
end resolveRef`;
}

function activeWorkspacePathScript(): string {
  return `on run argv
  tell application "Xcode"
    if not running then return "__DEVSPACE_XCODE_NOT_RUNNING__"
    try
      set targetDoc to active workspace document
      return path of targetDoc
    on error
      return "__DEVSPACE_XCODE_NO_WORKSPACE__"
    end try
  end tell
end run`;
}

function workspaceDetailsScript(): string {
  return `on joinItems(valuesList, delimiterText)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiterText
  set resultText to valuesList as text
  set AppleScript's text item delimiters to oldDelimiters
  return resultText
end joinItems

on run argv
  set targetPath to item 1 of argv
  set recordSeparator to ASCII character 30
  set listSeparator to ASCII character 31
  tell application "Xcode"
    set targetDocs to every workspace document whose path is targetPath
    if (count of targetDocs) is 0 then error "Authorized Xcode workspace is no longer open."
    set targetDoc to item 1 of targetDocs
    set schemeName to ""
    set destinationName to ""
    try
      set schemeName to name of active scheme of targetDoc
    end try
    try
      set destinationName to name of active run destination of targetDoc
    end try
    set schemeNames to {}
    repeat with schemeItem in schemes of targetDoc
      set end of schemeNames to name of schemeItem
    end repeat
    set destinationNames to {}
    repeat with destinationItem in run destinations of targetDoc
      set end of destinationNames to name of destinationItem
    end repeat
    set documentName to name of targetDoc
  end tell
  return documentName & recordSeparator & schemeName & recordSeparator & destinationName & recordSeparator & my joinItems(schemeNames, listSeparator) & recordSeparator & my joinItems(destinationNames, listSeparator)
end run`;
}

function openWorkspaceScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  tell application "Xcode"
    activate
    open POSIX file targetPath
  end tell
  return "ok"
end run`;
}

function openFileScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  tell application "Xcode"
    activate
    open POSIX file targetPath
  end tell
  return "ok"
end run`;
}

function selectSchemeScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  set requestedName to item 2 of argv
  tell application "Xcode"
    set targetDocs to every workspace document whose path is targetPath
    if (count of targetDocs) is 0 then error "Authorized Xcode workspace is no longer open."
    set targetDoc to item 1 of targetDocs
    set matchingSchemes to every scheme of targetDoc whose name is requestedName
    if (count of matchingSchemes) is 0 then error "No scheme named " & requestedName
    set active scheme of targetDoc to item 1 of matchingSchemes
  end tell
  return "ok"
end run`;
}

function selectRunDestinationScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  set requestedName to item 2 of argv
  tell application "Xcode"
    set targetDocs to every workspace document whose path is targetPath
    if (count of targetDocs) is 0 then error "Authorized Xcode workspace is no longer open."
    set targetDoc to item 1 of targetDocs
    set matchingDestinations to every run destination of targetDoc whose name is requestedName
    if (count of matchingDestinations) is 0 then error "No run destination named " & requestedName
    set active run destination of targetDoc to item 1 of matchingDestinations
  end tell
  return "ok"
end run`;
}

function actionScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  set actionName to item 2 of argv
  set waitSeconds to (item 3 of argv) as integer
  set recordSeparator to ASCII character 30
  tell application "Xcode"
    set targetDocs to every workspace document whose path is targetPath
    if (count of targetDocs) is 0 then error "Authorized Xcode workspace is no longer open."
    set targetDoc to item 1 of targetDocs
    if actionName is "build" then
      set actionResult to build targetDoc
    else if actionName is "clean" then
      set actionResult to clean targetDoc
    else if actionName is "run" then
      set actionResult to run targetDoc
    else if actionName is "test" then
      set actionResult to test targetDoc
    else if actionName is "debug" then
      set actionResult to debug targetDoc
    else
      error "Unsupported Xcode action: " & actionName
    end if

    if waitSeconds > 0 then
      set startedAt to current date
      repeat until completed of actionResult
        if ((current date) - startedAt) > waitSeconds then exit repeat
        delay 0.25
      end repeat
    end if

    set completedText to (completed of actionResult) as text
    set statusText to (status of actionResult) as text
    set logText to ""
    try
      set logText to build log of actionResult
    end try
  end tell
  return completedText & recordSeparator & statusText & recordSeparator & logText
end run`;
}

function stopScript(): string {
  return `on run argv
  set targetPath to item 1 of argv
  tell application "Xcode"
    set targetDocs to every workspace document whose path is targetPath
    if (count of targetDocs) is 0 then error "Authorized Xcode workspace is no longer open."
    stop item 1 of targetDocs
  end tell
  return "ok"
end run`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
