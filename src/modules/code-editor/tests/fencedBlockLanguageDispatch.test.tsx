import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { test, vi } from 'vitest';

import MarkdownCodeBlock from '@/modules/code-editor/markdown/MarkdownCodeBlock';

/**
 * Regression test for a real bug: MarkdownCodeBlock.tsx (and Markdown.tsx,
 * the chat transcript's equivalent) extracted a fence's language from its
 * className with `/language-(\w+)/`. `\w` does not include `-`, so a
 * hyphenated language like "vega-lite" was truncated to "vega" before the
 * `language === 'vega-lite'` dispatch check ever ran, which never matched —
 * every Vega-Lite chart silently fell through to the generic
 * syntax-highlighted code block instead of rendering as a chart. This was
 * invisible to vegaLiteChart.test.tsx because that file renders
 * `<VegaLiteChart>` directly with a hand-built prop, never going through
 * react-markdown's actual className-based language extraction at all —
 * exactly the gap this test closes by driving the real `MarkdownCodeBlock`
 * through `ReactMarkdown` with real fenced markdown text, the same wiring
 * `MarkdownPreview.tsx` uses in production.
 */

vi.mock('vega-embed', () => ({
  default: vi.fn().mockResolvedValue({ view: {}, spec: {}, vgSpec: {}, embedOptions: {}, finalize: vi.fn() }),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"></svg>' }),
  },
}));

vi.mock('d3-bundle-source?raw', () => ({ default: '/* fake d3 bundle */' }));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// react-markdown wraps a fenced block's `code` in its own `pre` by default;
// production (MarkdownPreview.tsx, Markdown.tsx) overrides `pre` to a
// passthrough so MarkdownCodeBlock's own rendering isn't double-wrapped.
// Without this override that wrapper `<pre>` is always present, so a
// `waitFor(() => assert.equal(container.querySelector('pre'), null))`
// assertion never becomes true, and once `waitFor` times out, `node:assert`
// tries to build a failure message by serializing the jsdom container via
// `util.inspect` — which explodes in CPU/memory on jsdom's circular object
// graph instead of failing promptly. Matching production's `pre` override
// avoids the trap entirely.
const renderMarkdown = (markdown: string) =>
  render(
    <ReactMarkdown components={{ code: MarkdownCodeBlock, pre: ({ children }) => <>{children}</> }}>
      {markdown}
    </ReactMarkdown>,
  );

test('a ```vega-lite fence renders as a chart, not a generic code block', async () => {
  const markdown = '```vega-lite\n{"mark":"bar","data":{"values":[]}}\n```';
  const { container, queryByText } = renderMarkdown(markdown);

  // The generic code-block path shows the language as an uppercase-first
  // label next to a Copy button; the chart path shows neither.
  await waitFor(() => assert.ok(container.querySelector('pre') === null));
  assert.ok(queryByText('vega-lite') === null);
  assert.ok(queryByText(/"mark":"bar"/) === null);
});

test('a ```d3 fence renders in a sandboxed iframe, not a generic code block', async () => {
  const markdown = '```d3\ncontainer.textContent = "chart";\n```';
  const { container } = renderMarkdown(markdown);

  await waitFor(() => assert.ok(container.querySelector('iframe') !== null));
});

test('a ```mermaid fence still renders as a diagram (sanity: unhyphenated languages were never broken)', async () => {
  const markdown = '```mermaid\ngraph TD; A-->B;\n```';
  const { container } = renderMarkdown(markdown);

  await waitFor(() => assert.ok(container.querySelector('[data-testid="mermaid-svg"]') !== null));
});
