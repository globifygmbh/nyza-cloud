// CodeMirror 6 editor, lazy-loaded so its weight stays out of the main bundle.
// Picks a language extension from the file name; falls back to plain text.

import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { python } from '@codemirror/lang-python';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';

function langFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'html': case 'htm': case 'vue': case 'svelte': return [html()];
    case 'css': case 'scss': case 'less': return [css()];
    case 'js': case 'jsx': case 'mjs': case 'cjs': case 'ts': case 'tsx':
      return [javascript({ jsx: ext === 'jsx' || ext === 'tsx', typescript: ext === 'ts' || ext === 'tsx' })];
    case 'json': return [json()];
    case 'md': case 'markdown': return [markdown()];
    case 'xml': case 'svg': case 'rss': return [xml()];
    case 'py': return [python()];
    case 'php': case 'phtml': return [php()];
    case 'sql': return [sql()];
    case 'yml': case 'yaml': return [yaml()];
    default: return [];
  }
}

export default function CodeEditor({ value, onChange, editable, name }) {
  const extensions = React.useMemo(() => [...langFor(name), EditorView.lineWrapping], [name]);
  return (
    <CodeMirror
      value={value}
      height="100%"
      theme="dark"
      editable={editable}
      readOnly={!editable}
      extensions={extensions}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: editable, autocompletion: true, tabSize: 2 }}
      style={{ height: '100%', fontSize: 13 }}
    />
  );
}
