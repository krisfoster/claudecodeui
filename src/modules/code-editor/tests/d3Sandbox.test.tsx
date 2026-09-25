import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import D3Sandbox from '@/modules/code-editor/markdown/D3Sandbox';

/**
 * D3Sandbox never runs Claude-authored code in the app's own origin: it
 * builds a sandboxed iframe (`sandbox="allow-scripts"`, no
 * `allow-same-origin`) and only trusts postMessage events whose `source` is
 * that exact iframe's contentWindow. These drive it through the real
 * component, simulating the sandbox's side of the postMessage contract
 * rather than mocking the iframe away, since the source-identity check is
 * the security-relevant behavior worth pinning.
 */

vi.mock('d3-bundle-source?raw', () => ({ default: '/* fake d3 bundle */' }));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

const postFromIframe = (iframe: HTMLIFrameElement, data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
};

// `waitFor`'s callback only retries when it throws — returning a bare
// `null` resolves immediately on the first (too-early) check.
const waitForIframe = (container: HTMLElement) =>
  waitFor(() => {
    const found = container.querySelector('iframe');
    assert.ok(found, 'expected an iframe once the snippet compiles');
    return found as HTMLIFrameElement;
  });

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a syntactically invalid snippet never creates an iframe and shows raw source', async () => {
  const { container, getByText } = render(<D3Sandbox code="function( { not valid" />);

  await waitFor(() => assert.ok(getByText('function( { not valid')));
  assert.equal(container.querySelector('iframe'), null);
});

test('a valid snippet gets a sandboxed iframe with no allow-same-origin and no network', async () => {
  const code = 'container.appendChild(document.createElement("svg"));';
  const { container } = render(<D3Sandbox code={code} />);

  const iframe = await waitForIframe(container);

  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.ok(!iframe.getAttribute('sandbox')?.includes('allow-same-origin'));
  assert.match(iframe.srcdoc, /connect-src 'none'/);
  assert.match(iframe.srcdoc, /fake d3 bundle/);
  assert.match(iframe.srcdoc, new RegExp(JSON.stringify(code).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Regression pins for review findings #1 and #5: without 'unsafe-eval'
  // the harness's own `new Function(...)` call is blocked by CSP in a real
  // browser (jsdom doesn't enforce CSP, so this is the only thing that
  // would have caught it), and `navigate-to 'none'` is the defense-in-depth
  // added against the sandbox navigating itself to attacker content.
  assert.match(iframe.srcdoc, /script-src[^;]*'unsafe-eval'/);
  assert.match(iframe.srcdoc, /navigate-to 'none'/);
});

test('a snippet containing a literal </script> tag cannot break out of the harness script', async () => {
  const code = 'container.textContent = "0</script><img src=x onerror=window.__pwned=1>";';
  const { container } = render(<D3Sandbox code={code} />);

  const iframe = await waitForIframe(container);

  // Review finding #2: JSON.stringify alone doesn't escape `<`, so a raw
  // `</script>` inside the fenced block's source used to close the tag
  // early and leave attacker markup as a sibling of the harness script.
  assert.ok(!/<\/script><img/i.test(iframe.srcdoc));
  assert.match(iframe.srcdoc, /\\u003c\/script/i);
});

test('a d3-resize message from the sandbox reveals the chart and hides the raw source', async () => {
  const { container, queryByText } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const iframe = await waitForIframe(container);

  postFromIframe(iframe, { type: 'd3-resize', height: 200 });

  await waitFor(() => assert.equal(iframe.classList.contains('hidden'), false));
  assert.equal(queryByText("container.textContent = 'chart';"), null);
});

test('a d3-error message from the sandbox falls back to raw source', async () => {
  const code = "container.textContent = 'chart';";
  const { container, findByText } = render(<D3Sandbox code={code} />);

  const iframe = await waitForIframe(container);
  postFromIframe(iframe, { type: 'd3-error', message: 'boom' });

  await findByText(code);
});

test('a render that never reports back falls back to raw source after the timeout', async () => {
  const code = "container.textContent = 'chart';";
  const { container, findByText } = render(<D3Sandbox code={code} />);

  // Real timers until the iframe exists — `waitFor`'s own polling relies on
  // them. Only switch to fake timers to deterministically fast-forward past
  // RENDER_TIMEOUT_MS, then straight back so the rest of the test (and any
  // later tests) polls normally again.
  await waitForIframe(container);

  vi.useFakeTimers();
  vi.advanceTimersByTime(5000);
  vi.useRealTimers();

  await findByText(code);
});

test('rapid successive code changes tear down the stale listener instead of letting it settle the new render', async () => {
  const codeA = "container.textContent = 'a';";
  const codeB = "container.textContent = 'b';";
  const { container, rerender, queryByText } = render(<D3Sandbox code={codeA} />);

  const iframeA = await waitForIframe(container);
  rerender(<D3Sandbox code={codeB} />);
  const iframeB = await waitForIframe(container);
  assert.notEqual(iframeA, iframeB, 'expected a new iframe for the new code/key');

  // A message from the torn-down iframeA's contentWindow must not settle
  // the current (codeB) render — proves the effect cleanup from the
  // previous `code` actually re-points the source check, not just leaves
  // a second listener racing the current one.
  postFromIframe(iframeA, { type: 'd3-resize', height: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(queryByText(codeB));
  assert.ok(iframeB.classList.contains('hidden'));

  postFromIframe(iframeB, { type: 'd3-resize', height: 1 });
  await waitFor(() => assert.equal(iframeB.classList.contains('hidden'), false));
  assert.equal(queryByText(codeA), null);
  assert.equal(queryByText(codeB), null);
});

test('a message from a different source is ignored', async () => {
  const code = "container.textContent = 'chart';";
  const { container, queryByText } = render(<D3Sandbox code={code} />);

  const iframe = await waitForIframe(container);

  // Not `source: iframe.contentWindow` — an unrelated frame trying to spoof
  // a ready signal must not be able to flip this component's state.
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'd3-resize', height: 1 }, source: null }));

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(queryByText(code));
  assert.ok(iframe.classList.contains('hidden'));
});
