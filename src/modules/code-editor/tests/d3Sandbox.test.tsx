import assert from 'node:assert/strict';

import { act, render, fireEvent, waitFor } from '@testing-library/react';
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

// This file mounts real sandboxed iframes and drives them with genuine
// postMessage round-trips, which — purely from event-loop/CPU contention,
// not a logic issue — can occasionally take several real seconds to settle
// when the *entire* repo test suite (600+ tests across 90+ files) runs
// concurrently on a single machine. Vitest's 5000ms per-test default is
// tight enough that it can fire before the (correct) state change lands in
// that scenario; this file alone or in small groups settles in milliseconds.
vi.setConfig({ testTimeout: 15000 });

// Wrapped in `act` because this is a plain `dispatchEvent`, not something
// Testing Library instruments itself (unlike `fireEvent`) — without it, the
// state update the message handler triggers can flush at a nondeterministic
// point relative to the rest of the test instead of synchronously here,
// which is what produced the flaky/occasionally-hanging escape and height
// assertions below during development of this suite.
const postFromIframe = (iframe: HTMLIFrameElement, data: unknown) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
  });
};

// A plain, self-contained poll (no testing-library `waitFor`/MutationObserver
// involved) for the handful of assertions in this file that, empirically,
// can still take a moment to settle when the whole repo's test suite runs
// at once (hundreds of files contending for the CPU) even though `act`
// normally flushes a dispatchEvent-triggered state update synchronously.
// Generous ceiling (under the file's bumped testTimeout above): this only
// matters under that kind of extreme, CI-style concurrent load — a lone
// file or a small subset settles in single-digit milliseconds, well under
// this.
const waitForCondition = async (check: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// `waitFor`'s callback only retries when it throws — returning a bare
// `null` resolves immediately on the first (too-early) check.
//
// Scoped to `container` and assumes exactly one iframe — true for every
// test below that never opens the zoom dialog. Once zoom is involved, a
// second iframe exists simultaneously (the zoomed copy, portaled into
// `document.body` by Dialog, outside `container` entirely) — use
// `waitForIframeCount`/`getIframes` instead so a test can't silently grab
// the wrong one via a singular `querySelector`.
// A generous timeout on both of these: under the full repo-wide test suite's
// concurrent load, settling can take meaningfully longer wall-clock time
// than testing-library's 1000ms default despite nothing actually being wrong
// — a lone file or small subset settles in single-digit milliseconds.
const waitForIframe = (container: HTMLElement) =>
  waitFor(() => {
    const found = container.querySelector('iframe');
    assert.ok(found, 'expected an iframe once the snippet compiles');
    return found as HTMLIFrameElement;
  }, { timeout: 10000 });

// Dialog portals its content into `document.body`, not into `render()`'s own
// container, so a zoomed copy's iframe has to be found document-wide.
const getIframes = (): HTMLIFrameElement[] => Array.from(document.querySelectorAll('iframe'));

const waitForIframeCount = (count: number) =>
  waitFor(() => {
    const found = getIframes();
    assert.equal(found.length, count, `expected ${count} iframe(s), found ${found.length}`);
    return found;
  }, { timeout: 10000 });

// Posts d3-resize and reveals the zoom button.
const revealButtonFor = async (iframe: HTMLIFrameElement, height = 100): Promise<void> => {
  postFromIframe(iframe, { type: 'd3-resize', height });
  await waitForCondition(() => !iframe.classList.contains('hidden'), 'iframe to stop being hidden');
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a syntactically invalid snippet never creates an iframe and shows raw source', async () => {
  const { container, getByText } = render(<D3Sandbox code="function( { not valid" />);

  await waitFor(() => assert.ok(getByText('function( { not valid')), { timeout: 10000 });
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

  await waitForCondition(() => !iframe.classList.contains('hidden'), 'iframe to stop being hidden');
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
  await waitForCondition(() => !iframeB.classList.contains('hidden'), 'iframeB to stop being hidden');
  assert.equal(queryByText(codeA), null);
  assert.equal(queryByText(codeB), null);
});

test('a message from a different source is ignored', async () => {
  const code = "container.textContent = 'chart';";
  const { container, queryByText } = render(<D3Sandbox code={code} />);

  const iframe = await waitForIframe(container);

  // Not `source: iframe.contentWindow` — an unrelated frame trying to spoof
  // a ready signal must not be able to flip this component's state.
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'd3-resize', height: 1 }, source: null }));
  });

  assert.ok(queryByText(code));
  assert.ok(iframe.classList.contains('hidden'));
});

test("a d3-resize message sets the iframe's actual height (previously dead data)", async () => {
  const { container } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const iframe = await waitForIframe(container);
  assert.equal(iframe.style.height, '');

  postFromIframe(iframe, { type: 'd3-resize', height: 742 });

  await waitForCondition(() => iframe.style.height === '742px', 'iframe height to be set from d3-resize');
});

test('the zoom button only appears once the visualization has rendered', async () => {
  const { container, queryByRole } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const iframe = await waitForIframe(container);
  assert.equal(queryByRole('button'), null);

  await revealButtonFor(iframe);

  assert.ok(queryByRole('button'));
});

test('clicking the zoom button opens a dialog with a second, independently-sized iframe', async () => {
  const { container, getByRole } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const inlineIframe = await waitForIframe(container);
  await revealButtonFor(inlineIframe);

  fireEvent.click(getByRole('button'));

  await waitFor(() => assert.ok(document.querySelector('[role="dialog"]')), { timeout: 10000 });
  await waitForIframeCount(2);
});

test("the zoomed copy's postMessage is handled independently of the inline one", async () => {
  const { container, getByRole } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const inlineIframe = await waitForIframe(container);
  await revealButtonFor(inlineIframe, 100);

  fireEvent.click(getByRole('button'));

  const [, zoomedIframe] = await waitForIframeCount(2);
  // Fresh mount: the zoomed copy starts pending again (hidden), independent
  // of the already-ready inline one.
  assert.ok(zoomedIframe.classList.contains('hidden'));

  postFromIframe(zoomedIframe, { type: 'd3-resize', height: 500 });

  await waitForCondition(() => !zoomedIframe.classList.contains('hidden'), 'zoomedIframe to stop being hidden');
  // The inline iframe's own height from its earlier, separate resize is untouched.
  assert.equal(inlineIframe.style.height, '100px');
  assert.equal(zoomedIframe.style.height, '500px');
});

test('Escape posted from inside the sandboxed iframe closes the zoomed dialog', async () => {
  // Regression for review finding #4: the zoomed iframe is a genuinely
  // separate document, so a keydown inside it never reaches the parent
  // document's own Escape listener — it has to be relayed via postMessage.
  const { container, getByRole } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const inlineIframe = await waitForIframe(container);
  await revealButtonFor(inlineIframe);

  fireEvent.click(getByRole('button'));

  const [, zoomedIframe] = await waitForIframeCount(2);
  assert.ok(document.querySelector('[role="dialog"]'));

  postFromIframe(zoomedIframe, { type: 'd3-escape' });

  await waitFor(() => assert.equal(document.querySelector('[role="dialog"]'), null), { timeout: 10000 });
  // Closing removes the zoomed copy; the inline one stays mounted.
  await waitForIframeCount(1);
});

test('an escape message from a different source does not close the dialog', async () => {
  const { container, getByRole } = render(<D3Sandbox code="container.textContent = 'chart';" />);

  const inlineIframe = await waitForIframe(container);
  await revealButtonFor(inlineIframe);

  fireEvent.click(getByRole('button'));
  await waitForIframeCount(2);

  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'd3-escape' }, source: null }));
  });

  assert.ok(document.querySelector('[role="dialog"]'));
});
