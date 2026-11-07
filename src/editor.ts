/* CatSim — sketch editor (CodeMirror 6, bundled). */
import { basicSetup } from 'codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, Decoration, keymap, type DecorationSet } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export interface SketchEditor {
  get(): string;
  set(code: string): void;
  onChange(fn: () => void): void;
  refresh(): void;
  /** Highlight a 1-based line as the error line and scroll to it. */
  mark(line: number): void;
  clear(): void;
  focusLine(line: number): void;
}

const setErrorLine = StateEffect.define<number | null>();
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrorLine)) continue;
      if (e.value == null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none;
      else deco = Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(tr.state.doc.line(e.value).from)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Same light palette the CodeMirror 5 theme used.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.typeName, t.standard(t.typeName)], color: '#0b3fd1' },
  { tag: [t.number, t.bool], color: '#0f8a5f' },
  { tag: [t.string, t.character], color: '#b3261e' },
  { tag: [t.processingInstruction, t.meta], color: '#a35a00' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8a93a3', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.function(t.variableName))], color: '#111' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', color: '#1c2230', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: '#fff', border: 'none', color: '#9aa1ae' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
  '.cm-activeLine': { backgroundColor: '#fffaeb' },
  '.cm-activeLineGutter': { backgroundColor: '#fffaeb' },
  '&.cm-focused': { outline: 'none' },
});

export function createEditor(host: HTMLElement, opts: { onRun: () => void }): SketchEditor {
  const listeners: Array<() => void> = [];
  const extensions: Extension[] = [
    basicSetup,
    cpp(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    syntaxHighlighting(highlight),
    theme,
    errorLine,
    keymap.of([{ key: 'Mod-Enter', run: () => { opts.onRun(); return true; } }, indentWithTab]),
    EditorView.updateListener.of((u) => { if (u.docChanged) listeners.forEach((fn) => fn()); }),
  ];
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions }) });

  const ed: SketchEditor = {
    get: () => view.state.doc.toString(),
    set(code) {
      // A fresh state also resets undo history (like CodeMirror 5's clearHistory()).
      view.setState(EditorState.create({ doc: code, extensions }));
    },
    onChange: (fn) => { listeners.push(fn); },
    refresh: () => view.requestMeasure(),
    mark(line) {
      ed.clear();
      if (!(line >= 1 && line <= view.state.doc.lines)) return;
      view.dispatch({ effects: [setErrorLine.of(line), EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'center' })] });
    },
    clear: () => view.dispatch({ effects: setErrorLine.of(null) }),
    focusLine(line) {
      if (!(line >= 1 && line <= view.state.doc.lines)) return;
      const pos = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
  };
  return ed;
}
