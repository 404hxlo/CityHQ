import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting,
} from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import {
  highlightSelectionMatches, search, searchKeymap, SearchCursor,
} from '@codemirror/search';
import {
  Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Text,
} from '@codemirror/state';
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, ViewPlugin, type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/* ---- Find bar support: every match is marked and the bar steps between them. ---- */

/** Where the find bar is: which match is selected (1-based, 0 for none) and how many there are. */
export interface FindInfo { current: number; total: number; capped: boolean }
interface Match { from: number; to: number }
interface FindState { text: string; matches: Match[]; capped: boolean }

const MAX_MATCHES = 5000;
const setFindText = StateEffect.define<string>();

/** Every place the text appears, ignoring upper and lower case. */
export function findAll(doc: Text, text: string): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  if (!text) return { matches, capped: false };
  const cursor = new SearchCursor(doc, text, 0, doc.length, (s) => s.toLowerCase());
  while (!cursor.next().done) {
    if (matches.length >= MAX_MATCHES) return { matches, capped: true };
    matches.push({ from: cursor.value.from, to: cursor.value.to });
  }
  return { matches, capped: false };
}

const findField = StateField.define<FindState>({
  create: () => ({ text: '', matches: [], capped: false }),
  update(value, tr) {
    let { text } = value;
    for (const e of tr.effects) if (e.is(setFindText)) text = e.value;
    if (text === value.text && !tr.docChanged) return value;
    return { text, ...findAll(tr.state.doc, text) };
  },
});

const isSelected = (m: Match, sel: { from: number; to: number }) => m.from === sel.from && m.to === sel.to;
const matchMark = Decoration.mark({ class: 'cm-findMatch' });
const currentMark = Decoration.mark({ class: 'cm-findMatch cm-findCurrent' });

/** Marks the matches on screen; the selected one stands out. */
const findHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = this.build(view); }

  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.state.field(findField) !== u.startState.field(findField)) {
      this.decorations = this.build(u.view);
    }
  }

  build(view: EditorView) {
    const { matches } = view.state.field(findField);
    if (!matches.length) return Decoration.none;
    const sel = view.state.selection.main;
    const { from: top, to: bottom } = view.viewport;
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches[mid].to < top) lo = mid + 1; else hi = mid;
    }
    const builder = new RangeSetBuilder<Decoration>();
    for (let i = lo; i < matches.length && matches[i].from <= bottom; i++) {
      builder.add(matches[i].from, matches[i].to, isSelected(matches[i], sel) ? currentMark : matchMark);
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

export function findInfoOf(state: EditorState): FindInfo {
  const { matches, capped } = state.field(findField);
  const sel = state.selection.main;
  return { current: matches.findIndex((m) => isSelected(m, sel)) + 1, total: matches.length, capped };
}

/**
 * Picks the match to select. `start` keeps the selected match while the text is still being typed;
 * 1 and -1 move to the next or previous one, going round at the ends.
 */
export function pickMatch(matches: Match[], sel: { from: number; to: number }, how: 'start' | 1 | -1): Match | null {
  if (!matches.length) return null;
  if (how === 'start') return matches.find((m) => m.from >= sel.from) ?? matches[0];
  if (how === 1) return matches.find((m) => m.from >= sel.to && !isSelected(m, sel)) ?? matches[0];
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].to <= sel.from && !isSelected(matches[i], sel)) return matches[i];
  }
  return matches[matches.length - 1];
}

function selectMatch(view: EditorView, how: 'start' | 1 | -1) {
  const target = pickMatch(view.state.field(findField).matches, view.state.selection.main, how);
  if (!target) return false;
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center', x: 'center' }),
  });
  return true;
}

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'lua': return [StreamLanguage.define(lua)];
    case 'js': return [javascript()];
    case 'ts': return [javascript({ typescript: true })];
    case 'json': return [json()];
    case 'html': case 'htm': case 'xml': case 'meta': case 'svg': return [html()];
    case 'css': return [css()];
    default: return [];
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--ink)', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-faint)', border: 'none', paddingLeft: '4px' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-soft)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(128,102,168,0.42) !important' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(128,102,168,0.38)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,0.09)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', border: '1px solid var(--line-strong)', color: 'var(--ink)', borderRadius: '6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised-2)', border: '1px solid var(--line-strong)', color: 'var(--ink)', borderRadius: '6px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(128,102,168,0.45)', outline: 'none' },
  '.cm-findMatch': { backgroundColor: 'rgba(230,197,111,0.2)', outline: '1px solid rgba(230,197,111,0.4)', borderRadius: '2px' },
  '.cm-findCurrent': { backgroundColor: 'rgba(230,197,111,0.5)', outline: '1px solid #e6c56f', color: '#fff' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#a98bf5' },
  { tag: [t.string, t.special(t.string)], color: '#a9d98a' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#7cc7ff' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6e7780', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#e6c56f' },
  { tag: [t.propertyName, t.attributeName], color: '#d7b6ff' },
  { tag: [t.typeName, t.className, t.tagName], color: '#f2a6b3' },
  { tag: t.invalid, color: '#ff6166' },
]);

interface Props {
  path: string;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  /** 1-based line to show and select when the file opens, such as a search result. */
  line?: number;
  /** Long lines continue on the next row instead of needing a sideways scroll. */
  wrap?: boolean;
  /** Point at a line later on without reopening the file, such as a mistake found on save. */
  jump?: { line: number; token: number } | null;
  /** Text from the find bar: every match is marked and the first one from the cursor is selected. */
  find?: string;
  /** Move to the next (1) or previous (-1) match; a new token moves again. */
  findStep?: { dir: 1 | -1; token: number } | null;
  /** Told which match is selected and how many there are, whenever that changes. */
  onFindInfo?: (info: FindInfo) => void;
  /** Ctrl+F in the editor, with the selected text (empty when nothing or several lines are selected). */
  onFindKey?: (selected: string) => void;
}

/** Selects a line and centers it, moving only the editor and not the panels around it. */
function goToLine(editor: EditorView, line: number) {
  if (line < 1 || line > editor.state.doc.lines) return;
  const target = editor.state.doc.line(line);
  editor.dispatch({ selection: { anchor: target.from, head: target.to } });
  const center = () => {
    const { scrollDOM } = editor;
    scrollDOM.scrollTop = Math.max(0, editor.lineBlockAt(target.from).top - scrollDOM.clientHeight / 2);
  };
  requestAnimationFrame(() => {
    center();
    // Far-away lines are only estimated until they have been drawn once.
    requestAnimationFrame(center);
  });
}

export default function CodeEditor({
  path, value, onChange, readOnly = false, line, wrap = true, jump, find = '', findStep, onFindInfo, onFindKey,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const findRef = useRef(find);
  findRef.current = find;
  const infoRef = useRef(onFindInfo);
  infoRef.current = onFindInfo;
  const findKeyRef = useRef(onFindKey);
  findKeyRef.current = onFindKey;

  useEffect(() => {
    // The find bar's keys come before the built-in search panel's, which then stays out of the way.
    const findKeys = Prec.high(keymap.of([
      {
        key: 'Mod-f',
        run: (v) => {
          if (!findKeyRef.current) return false;
          const { from, to } = v.state.selection.main;
          const selected = v.state.sliceDoc(from, to);
          findKeyRef.current(selected.includes('\n') ? '' : selected);
          return true;
        },
      },
      { key: 'F3', run: (v) => selectMatch(v, 1), shift: (v) => selectMatch(v, -1) },
      { key: 'Mod-g', run: (v) => selectMatch(v, 1), shift: (v) => selectMatch(v, -1) },
    ]));
    const editor = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), indentOnInput(), bracketMatching(),
          highlightSelectionMatches(), search({ top: true }), EditorState.tabSize.of(4),
          findField, findHighlighter, findKeys,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          syntaxHighlighting(highlight), theme, ...languageFor(path),
          EditorState.readOnly.of(readOnly),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString());
            if (u.docChanged || u.selectionSet || u.state.field(findField) !== u.startState.field(findField)) {
              infoRef.current?.(findInfoOf(u.state));
            }
          }),
        ],
      }),
    });
    view.current = editor;
    // A reopened file keeps the find bar's text marked, without moving away from the line it opened at.
    if (findRef.current) editor.dispatch({ effects: setFindText.of(findRef.current) });
    if (line) goToLine(editor, line);
    infoRef.current?.(findInfoOf(editor.state));
    return () => { editor.destroy(); view.current = null; };
    // The editor is recreated for each file; value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly, line]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.field(findField).text === find) return;
    editor.dispatch({ effects: setFindText.of(find) });
    if (find) selectMatch(editor, 'start');
  }, [find]);

  // Only a new press moves; reopening the code view does not replay the last one.
  const lastStep = useRef(findStep?.token);
  useEffect(() => {
    if (!findStep || findStep.token === lastStep.current || !view.current) return;
    lastStep.current = findStep.token;
    selectMatch(view.current, findStep.dir);
  }, [findStep]);

  useEffect(() => {
    if (jump && view.current) {
      goToLine(view.current, jump.line);
      view.current.focus();
    }
  }, [jump]);

  // Switching wrap keeps the cursor, undo history and anything typed so far.
  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="code-editor" ref={host} />;
}
