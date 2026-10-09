import { useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';

// Lazy-loaded as raw text (Vite's `?raw` suffix), not executed here — the
// bundle is inlined into a sandboxed iframe's srcdoc, never imported into
// this module's own scope. ~280KB minified, so it only loads the first time
// a ```d3 block actually appears, same tradeoff as mermaid/vega-embed.
let d3SourcePromise: Promise<string> | null = null;
const loadD3Source = () => {
  // `d3-bundle-source` is a Vite resolve.alias (vite.config.js) pointing at
  // d3's own dist/d3.min.js by filesystem path — `d3`'s package.json
  // "exports" map only defines the bare "." specifier, so importing that
  // file as a subpath (`d3/dist/d3.min.js`) is rejected outright.
  // eslint-disable-next-line importx/no-unresolved -- Vite alias + ?raw import
  d3SourcePromise ??= import('d3-bundle-source?raw').then((module) => module.default);
  return d3SourcePromise;
};

type D3SandboxProps = {
  /** Raw JS source, i.e. the body of a ```d3 fenced block. */
  code: string;
};

type SrcDocState = { key: string; srcDoc: string };
type RenderOutcome = { key: string; status: 'ready' | 'failed' };

const RENDER_TIMEOUT_MS = 5000;

/**
 * D3 is Claude-authored *code*, not a data spec like Mermaid/Vega-Lite, so
 * it cannot run in the app's own origin — that would hand untrusted (and
 * prompt-injectable) JS full access to the user's session. It runs inside a
 * `sandbox="allow-scripts"` iframe with no `allow-same-origin`, so the frame
 * has an opaque origin: it can execute JS and draw into its own DOM, but it
 * cannot read the app's cookies, call its authenticated APIs, or reach the
 * parent page. A CSP inside the sandboxed document additionally blocks all
 * network access — the code is expected to visualize data Claude inlines
 * directly, not fetch anything.
 *
 * The fenced block's body becomes the body of
 * `function render(container, d3, width, height) { ... }`, called once
 * against a `<div>` inside the sandbox.
 *
 * Never blank, never a hard error: a syntax error (including an incomplete
 * snippet still streaming in), a runtime error reported by the sandbox, or
 * a render that never reports back within a few seconds all fall back to
 * the raw source — same philosophy as MermaidDiagram and VegaLiteChart.
 */
export default function D3Sandbox({ code }: D3SandboxProps) {
  const { isDarkMode } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const key = `${code}::${isDarkMode}`;

  // A syntax error is pure and synchronous, so it is derived at render time
  // rather than round-tripped through an effect + setState. `new Function`
  // only compiles the body, it never executes it, so this is safe to run
  // outside the sandbox — and it is what keeps a streaming, still-incomplete
  // snippet from reloading a quarter-megabyte iframe on every tick: most
  // partial snippets are a syntax error until the fence closes.
  const compileError = useMemo(() => {
    try {
      // eslint-disable-next-line no-new-func -- compiled, never invoked, here
      new Function('container', 'd3', 'width', 'height', code);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [code]);

  // Keyed the same way as `outcome` below: building the sandboxed document
  // needs the (async, cached) d3 bundle text, so it can't be a plain
  // useMemo. Reads as "no doc yet for this code/theme" until the effect
  // resolves, without a synchronous setState-in-effect reset.
  const [srcDocState, setSrcDocState] = useState<SrcDocState | null>(null);
  const srcDoc = compileError === null && srcDocState?.key === key ? srcDocState.srcDoc : null;

  const [outcome, setOutcome] = useState<RenderOutcome | null>(null);
  const status = compileError !== null
    ? 'failed'
    : outcome && outcome.key === key
      ? outcome.status
      : 'pending';

  useEffect(() => {
    if (compileError !== null) {
      return undefined;
    }

    let cancelled = false;
    loadD3Source().then((d3Source) => {
      if (!cancelled) {
        setSrcDocState({ key, srcDoc: buildSrcDoc(code, d3Source, isDarkMode) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, compileError, isDarkMode, key]);

  useEffect(() => {
    if (srcDoc === null) {
      return undefined;
    }

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        setOutcome({ key, status: 'failed' });
      }
    }, RENDER_TIMEOUT_MS);

    const handleMessage = (event: MessageEvent) => {
      if (settled || event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data as { type?: string } | undefined;
      if (data?.type === 'd3-resize') {
        settled = true;
        window.clearTimeout(timeoutId);
        setOutcome({ key, status: 'ready' });
      } else if (data?.type === 'd3-error') {
        settled = true;
        window.clearTimeout(timeoutId);
        setOutcome({ key, status: 'failed' });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('message', handleMessage);
    };
  }, [srcDoc, key]);

  return (
    <>
      {status !== 'ready' && (
        <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
          {code.trim()}
        </pre>
      )}
      {srcDoc !== null && (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          title="D3 visualization"
          className={`my-3 w-full overflow-hidden rounded-xl border border-border bg-white dark:bg-zinc-900 ${status === 'ready' ? '' : 'hidden'
            }`}
        />
      )}
    </>
  );
}

/**
 * The sandboxed document: CSP blocking all network access, the inlined d3
 * bundle, and a harness that compiles the fenced block's body as
 * `render(container, d3, width, height)`, calls it once against a root
 * `<div>`, and reports back to the parent via `postMessage` — a resize on
 * success (so the chat bubble can size to content) or an error message on
 * failure. `window.onerror` and `unhandledrejection` also report back, so a
 * sync or async runtime error after a partial render still falls back to
 * raw source instead of showing a half-drawn chart or hanging silently
 * until the timeout.
 */
function buildSrcDoc(code: string, d3Source: string, isDarkMode: boolean): string {
  const background = isDarkMode ? '#18181b' : '#ffffff';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; navigate-to 'none'">
<style>html,body{margin:0;padding:0;background:${background};overflow:hidden}#root{width:100%}</style>
</head>
<body>
<div id="root"></div>
<script>${d3Source}</script>
<script>
(function () {
  function post(message) {
    parent.postMessage(message, '*');
  }
  window.onerror = function (message) {
    post({ type: 'd3-error', message: String(message) });
    return true;
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    post({ type: 'd3-error', message: reason && reason.message ? reason.message : String(reason) });
  });
  try {
    var container = document.getElementById('root');
    var render = new Function('container', 'd3', 'width', 'height', ${JSON.stringify(code).replace(/</g, '\\u003c')});
    render(container, d3, container.clientWidth, container.clientHeight);
    var report = function () {
      post({ type: 'd3-resize', height: document.body.scrollHeight });
    };
    report();
    new ResizeObserver(report).observe(document.body);
  } catch (error) {
    post({ type: 'd3-error', message: error && error.message ? error.message : String(error) });
  }
})();
</script>
</body>
</html>`;
}
