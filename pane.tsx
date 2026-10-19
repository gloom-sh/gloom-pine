/**
 * PINE: a tab per script, the script in an editor, and what it draws or why
 * it does not under it. The pane only edits; scripts run in the Bun process
 * (service.ts), which it reaches through the `pine-scripts` capability, so
 * the same pane works in the terminal and in the desktop view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  confirmDialog,
  EmptyState,
  Notice,
  PaneStatusBody,
  TextPromptDialog,
  usePaneFooter,
  usePaneTabs,
} from "gloomberb/components";
// The field frame came to the kit in 0.17.7. Read through the namespace, not
// imported by name, so an older app can still import the plugin when it
// installs it and then say which version it needs, instead of failing to link.
import * as kit from "gloomberb/components";
import { useDialog, type PromptContext } from "gloomberb/dialog";
import {
  useCapabilityInvoker,
  usePaneTickerIdentity,
  usePluginAppActions,
  usePluginPaneState,
  useShortcut,
} from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import { Box, Textarea, useUiCapabilities, type TextareaRenderable } from "gloomberb/ui";
import { isPlainKey } from "gloomberb/utils";
import { scriptChartSpec } from "./chart";
import { formatScriptError, SCRIPTS_CAPABILITY_ID, type PineScript, type ScriptInfo } from "./model";

/** The composer's template: the chart CAT opens. */
const CHART_TEMPLATE_ID = "chart-composer-pane";
/** The tab of a script not saved yet. */
const NEW_ID = "new";
const PLACEHOLDER = "Paste a Pine Script v5 or v6 indicator";

function describeDrawing(info: ScriptInfo): string {
  const where = info.overlay ? "Over the price" : "In a panel under the price";
  const parts = [`${where}: ${info.lines.map((line) => line.name).join(", ")}`];
  if (info.inputs.length > 0) {
    const inputs = info.inputs.slice(0, 4).map((input) => `${input.title} ${typeof input.defval === "object" ? "" : String(input.defval)}`.trim());
    parts.push(`inputs at their defaults (${inputs.join(", ")}${info.inputs.length > 4 ? ", ..." : ""})`);
  }
  return parts.join("; ");
}

function describeLimits(info: ScriptInfo): string | null {
  const parts: string[] = [];
  if (info.notDrawn.length > 0) parts.push(`Not drawn: ${info.notDrawn.join(", ")}.`);
  if (info.strategy) parts.push("Strategy orders are not run; its plots are drawn.");
  return parts.length > 0 ? parts.join(" ") : null;
}

export function PinePane({ focused }: PaneProps) {
  const dialog = useDialog();
  const { invokeCapability } = useCapabilityInvoker();
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const { symbol: paneSymbol } = usePaneTickerIdentity();
  const { nativePaneChrome } = useUiCapabilities();
  const [scripts, setScripts] = useState<PineScript[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = usePluginPaneState<string | null>("activeScript", null);
  const [lastTicker, setLastTicker] = usePluginPaneState<string>("chartTicker", "");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  // The last save's result, for the script it saved.
  const [saved, setSaved] = useState<{ id: string; text: string } | null>(null);
  // Unsaved text by script, kept while the pane is open so a tab switch loses nothing.
  const drafts = useRef(new Map<string, string>());
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<TextareaRenderable | null>(null);

  const invoke = useCallback(<T,>(operation: string, payload: unknown) => (
    invokeCapability<T>(SCRIPTS_CAPABILITY_ID, operation, payload)
  ), [invokeCapability]);

  const reload = useCallback(() => {
    setLoadError(null);
    return invoke<{ scripts: PineScript[] }>("list", {}).then(
      (result) => setScripts(result.scripts),
      (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)),
    );
  }, [invoke]);

  useEffect(() => { void reload(); }, [reload]);

  const list = scripts ?? [];
  const active = creating && activeId === NEW_ID ? null : list.find((script) => script.id === activeId) ?? list[0] ?? null;
  const shownId = creating && activeId === NEW_ID ? NEW_ID : active?.id ?? null;
  const savedSource = active?.source ?? "";
  const text = shownId ? drafts.current.get(shownId) ?? savedSource : "";

  useEffect(() => {
    setDirty(shownId ? drafts.current.has(shownId) : false);
  }, [shownId]);

  useEffect(() => {
    if (!focused && editing) setEditing(false);
  }, [editing, focused]);

  const readText = useCallback(() => {
    try {
      return textareaRef.current?.editBuffer.getText() ?? text;
    } catch {
      return text;
    }
  }, [text]);

  const onInput = useCallback((value: string) => {
    if (!shownId) return;
    if (value === savedSource && shownId !== NEW_ID) drafts.current.delete(shownId);
    else drafts.current.set(shownId, value);
    setDirty(drafts.current.has(shownId));
    setSaved(null);
  }, [savedSource, shownId]);

  const save = useCallback(async () => {
    if (!shownId || saving) return;
    const source = readText();
    if (shownId === NEW_ID && !source.trim()) return;
    setSaving(true);
    try {
      const { script } = await invoke<{ script: PineScript }>("save", shownId === NEW_ID ? { source } : { id: shownId, source });
      drafts.current.delete(shownId);
      setScripts((current) => {
        const rest = (current ?? []).filter((entry) => entry.id !== script.id);
        const index = (current ?? []).findIndex((entry) => entry.id === script.id);
        if (index < 0) return [...rest, script];
        const next = [...(current ?? [])];
        next[index] = script;
        return next;
      });
      setCreating(false);
      setActiveId(script.id);
      setDirty(false);
      setSaved({ id: script.id, text: script.check?.ok ? "saved" : "saved with an error" });
      if (script.check?.ok) setEditing(false);
    } catch (error) {
      notify({ body: error instanceof Error ? error.message : String(error), type: "error" });
    } finally {
      setSaving(false);
    }
  }, [invoke, notify, readText, saving, setActiveId, shownId]);

  const cancel = useCallback(() => {
    if (!shownId) return;
    drafts.current.delete(shownId);
    setDirty(false);
    setEditing(false);
    if (shownId === NEW_ID) {
      setCreating(false);
      setActiveId(list[0]?.id ?? null);
      return;
    }
    textareaRef.current?.setText(savedSource);
  }, [list, savedSource, setActiveId, shownId]);

  const startNew = useCallback(() => {
    drafts.current.delete(NEW_ID);
    setCreating(true);
    setActiveId(NEW_ID);
    setEditing(true);
  }, [setActiveId]);

  const rename = useCallback(async () => {
    if (!active) return;
    const name = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => (
        <TextPromptDialog {...ctx} title="Rename Script" label="Name" initialValue={active.name} confirmLabel="Rename" width={48} />
      ),
    }).catch(() => undefined);
    if (!name || name === active.name) return;
    try {
      const { script } = await invoke<{ script: PineScript }>("rename", { id: active.id, name });
      setScripts((current) => (current ?? []).map((entry) => (entry.id === script.id ? script : entry)));
    } catch (error) {
      notify({ body: error instanceof Error ? error.message : String(error), type: "error" });
    }
  }, [active, dialog, invoke, notify]);

  const remove = useCallback(async (id: string) => {
    if (id === NEW_ID) {
      cancel();
      return;
    }
    const script = list.find((entry) => entry.id === id);
    if (!script) return;
    if (script.source.trim()) {
      const confirmed = await confirmDialog(dialog, {
        title: "Delete script?",
        body: [`Delete "${script.name}"? Charts that show it stop drawing it.`],
        confirmLabel: "Delete",
        confirmVariant: "danger",
        width: 48,
        footer: "Enter delete · Esc cancel",
      });
      if (!confirmed) return;
    }
    try {
      await invoke("delete", { id });
      drafts.current.delete(id);
      const index = list.findIndex((entry) => entry.id === id);
      const next = list.filter((entry) => entry.id !== id);
      setScripts(next);
      if (activeId === id || !activeId) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
      setEditing(false);
    } catch (error) {
      notify({ body: error instanceof Error ? error.message : String(error), type: "error" });
    }
  }, [activeId, cancel, dialog, invoke, list, notify, setActiveId]);

  const info = active?.check?.ok ? active.check.info : null;
  const chartable = !!info && info.lines.length > 0 && !creating;

  const graph = useCallback(async () => {
    if (!active || !info || info.lines.length === 0) return;
    const ticker = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => (
        <TextPromptDialog {...ctx} title={`Chart ${active.name}`} label="Ticker" initialValue={lastTicker || paneSymbol || "AAPL"} confirmLabel="Chart" width={40} />
      ),
    }).catch(() => undefined);
    const symbol = ticker?.trim().toUpperCase();
    if (!symbol) return;
    setLastTicker(symbol);
    createPaneFromTemplate(CHART_TEMPLATE_ID, { shareData: { chartSpec: scriptChartSpec(active, info, symbol) } });
  }, [active, createPaneFromTemplate, dialog, info, lastTicker, paneSymbol, setLastTicker]);

  useShortcut((event) => {
    if (!focused) return;
    if (editing) {
      if (event.ctrl && event.name === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (isPlainKey(event, "escape")) {
        event.preventDefault();
        setEditing(false);
      }
      return;
    }
    if (isPlainKey(event, "enter", "return") && shownId) {
      event.preventDefault();
      setEditing(true);
    }
  }, { allowEditable: true });

  const onCloseTab = (value: string) => { void remove(value); };
  const tabs = [
    ...list.map((script) => ({ label: script.name, value: script.id, onClose: onCloseTab })),
    ...(creating ? [{ label: "New Script", value: NEW_ID, onClose: onCloseTab }] : []),
  ];
  const { strip } = usePaneTabs(tabs.length > 0 ? {
    tabs,
    activeValue: shownId,
    onSelect: (value: string) => {
      if (value === shownId) return;
      setActiveId(value);
      setEditing(false);
    },
    focused: focused && !editing,
    closeMode: "active",
    onAdd: startNew,
    // New, Rename and Delete are footer hints, already in the pane menu.
    paneMenu: false,
    compact: true,
    variant: "pill",
  } : null);

  usePaneFooter("pine", () => ({
    info: [
      ...(saving ? [{ id: "saving", parts: [{ text: "checking", tone: "muted" as const }] }] : []),
      ...(!saving && dirty ? [{ id: "dirty", parts: [{ text: "unsaved", tone: "warning" as const }] }] : []),
      ...(!saving && !dirty && saved && saved.id === shownId
        ? [{ id: "saved", parts: [{ text: saved.text, tone: saved.text === "saved" ? "positive" as const : "warning" as const }] }]
        : []),
    ],
    hints: editing ? [] : [
      { id: "new", key: "n", label: "ew", title: "New Script", onPress: startNew },
      { id: "save", key: "s", label: "ave", title: "Save Script", onPress: () => { void save(); }, disabled: !dirty || saving },
      { id: "graph", key: "g", label: "raph", title: "Chart Script", onPress: () => { void graph(); }, disabled: !chartable || dirty },
      // Not `r`: that is the app-wide refresh key.
      { id: "title", key: "t", label: "itle", title: "Rename Script", onPress: () => { void rename(); }, disabled: !active || creating },
      { id: "delete", key: "d", label: "elete", title: "Delete Script", onPress: () => { if (shownId) void remove(shownId); }, disabled: !shownId },
    ],
  }), [active, chartable, creating, dirty, editing, graph, rename, remove, save, saved, saving, shownId, startNew]);

  if (scripts === null) {
    return (
      <PaneStatusBody
        loading={!loadError}
        subject="Pine scripts"
        error={loadError}
        retry={{ onRetry: reload }}
      />
    );
  }

  if (!shownId) {
    return (
      <EmptyState
        title="No scripts yet."
        hint="Paste a Pine Script indicator to chart it on any ticker."
        actions={<Button label="New Script" shortcut="n" variant="primary" onPress={startNew} />}
      />
    );
  }

  const error = active?.check && !active.check.ok && !dirty ? formatScriptError(active.check.error) : null;
  const limits = info && !dirty ? describeLimits(info) : null;
  const showActions = editing || dirty;

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {strip && <Box height={1}>{strip}</Box>}
      <Box flexDirection="column" flexGrow={1} minHeight={0} paddingX={1} gap={nativePaneChrome ? 1 : 0}>
        <Box
          flexGrow={1}
          minHeight={3}
          {...(nativePaneChrome
            ? { style: { ...kit.fieldFrameStyle(editing), overflow: "hidden" } }
            : { border: true, borderColor: editing ? colors.borderFocused : colors.border })}
          onMouseDown={() => { if (!editing) setEditing(true); }}
        >
          <Textarea
            key={shownId}
            ref={textareaRef}
            initialValue={text}
            placeholder={PLACEHOLDER}
            focused={focused && editing}
            textColor={colors.text}
            placeholderColor={colors.textDim}
            backgroundColor={nativePaneChrome ? "transparent" : colors.bg}
            flexGrow={1}
            wrapText
            {...(nativePaneChrome ? { style: kit.FRAMED_TEXTAREA_DESKTOP_STYLE } : {})}
            onInput={onInput}
          />
        </Box>
        {error && <Notice tone="negative">{error}</Notice>}
        {info && !dirty && <Notice tone="muted">{describeDrawing(info)}</Notice>}
        {limits && <Notice tone="warning">{limits}</Notice>}
        {showActions && (
          <Box flexDirection="row" gap={1}>
            <Button label="Save" shortcut="Ctrl+S" variant="primary" pending={saving} pendingLabel="Checking..." onPress={() => { void save(); }} disabled={!dirty && shownId !== NEW_ID} />
            <Button label="Cancel" variant="secondary" onPress={cancel} disabled={saving} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
