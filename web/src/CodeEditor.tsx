import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting,
} from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

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
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,138,61,0.26) !important' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(255,138,61,0.22)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,0.09)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', border: '1px solid var(--line-strong)', color: 'var(--ink)', borderRadius: '6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised-2)', border: '1px solid var(--line-strong)', color: 'var(--ink)', borderRadius: '6px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255,138,61,0.28)', outline: 'none' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#ff9d5c' },
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

export default function CodeEditor({ path, value, onChange, readOnly = false, line, wrap = true, jump }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), indentOnInput(), bracketMatching(),
          highlightSelectionMatches(), search({ top: true }), EditorState.tabSize.of(4),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          syntaxHighlighting(highlight), theme, ...languageFor(path),
          EditorState.readOnly.of(readOnly),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((u) => { if (u.docChanged) changeRef.current(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = editor;
    if (line) goToLine(editor, line);
    return () => { editor.destroy(); view.current = null; };
    // The editor is recreated for each file; value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly, line]);

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
