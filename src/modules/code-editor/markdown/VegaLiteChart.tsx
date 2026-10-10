import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Type-only: erased at build time, so it does not pull vega-embed into the main chunk.
import type embed from 'vega-embed';
import type { VisualizationSpec } from 'vega-embed';

import { useTheme } from '@/shared/context/ThemeContext';
import ZoomButton from '@/modules/code-editor/markdown/ZoomButton';
import ChartZoomDialog from '@/modules/code-editor/markdown/ChartZoomDialog';

// vega-embed pulls in vega + vega-lite + vega-themes, well over a megabyte
// minified, so it is loaded on demand the first time a chart renders and
// shared by every instance afterwards — same tradeoff as mermaid.
let vegaEmbedPromise: Promise<typeof embed> | null = null;
const loadVegaEmbed = () => {
  vegaEmbedPromise ??= import('vega-embed').then((module) => module.default);
  return vegaEmbedPromise;
};

type VegaLiteChartProps = {
  /** Raw JSON source, i.e. the body of a ```vega-lite fenced block. */
  spec: string;
  /**
   * Whether this instance offers its own zoom button. Set to `false` for the
   * instance mounted inside the zoomed dialog itself, so there is no
   * zoom-inside-zoom nesting. Defaults to `true`.
   */
  zoomable?: boolean;
};

type RenderOutcome = { key: string; status: 'ready' | 'failed' };

/**
 * Renders a ```vega-lite code block as a chart, GitHub-preview style.
 *
 * Used by the chat module to render vega-lite blocks in assistant messages,
 * and by MarkdownCodeBlock inside code-editor for markdown previews — same
 * two call sites as MermaidDiagram, which this mirrors closely.
 *
 * While vega-embed is loading, the spec doesn't parse (e.g. still streaming
 * in), or embedding fails, the raw source is shown instead, so the content
 * is never blank or replaced by an error box.
 *
 * Zooming mounts a second instance of this same component inside a dialog —
 * a genuinely fresh, independent `vega-embed` view with its own event
 * listeners, which is what keeps tooltips/interactivity working when zoomed
 * (a CSS-scaled copy of the same rendered node could not guarantee that).
 * vega-scenegraph's SVG clip-path/gradient ids are page-global monotonic
 * counters, never collide between simultaneous views, so no extra isolation
 * is needed beyond mounting a second instance.
 */
export default function VegaLiteChart({ spec, zoomable = true }: VegaLiteChartProps) {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Keyed by what was requested so a spec/theme change reads as "pending"
  // until the new render settles, without resetting state synchronously in
  // the effect — same trick as MarkdownImage's useMarkdownImageSrc.
  const [outcome, setOutcome] = useState<RenderOutcome | null>(null);
  const key = `${spec}::${isDarkMode}`;
  // A parse failure is pure and synchronous, so it is derived at render time
  // rather than round-tripped through an effect + setState.
  const parsedSpec = useMemo<VisualizationSpec | null>(() => {
    try {
      return JSON.parse(spec) as VisualizationSpec;
    } catch {
      return null;
    }
  }, [spec]);
  const status = parsedSpec === null ? 'failed' : outcome && outcome.key === key ? outcome.status : 'pending';

  useEffect(() => {
    if (parsedSpec === null) {
      return undefined;
    }

    let cancelled = false;
    let finalizeView: (() => void) | null = null;

    loadVegaEmbed()
      .then((embedFn) => {
        if (cancelled || !containerRef.current) {
          return null;
        }
        // Defends against a rendered-but-not-yet-finalized previous view
        // still occupying this node if a spec change re-fires this effect
        // faster than the prior embed() promise settles.
        containerRef.current.innerHTML = '';
        return embedFn(containerRef.current, parsedSpec, {
          actions: false,
          theme: isDarkMode ? 'dark' : undefined,
        });
      })
      .then((result) => {
        if (cancelled) {
          result?.finalize();
          return;
        }
        if (result) {
          finalizeView = result.finalize;
          setOutcome({ key, status: 'ready' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOutcome({ key, status: 'failed' });
        }
      });

    return () => {
      cancelled = true;
      finalizeView?.();
    };
  }, [parsedSpec, isDarkMode, key]);

  return (
    <>
      {status !== 'ready' && (
        <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
          {spec.trim()}
        </pre>
      )}
      <div className={`group relative my-3 ${status === 'ready' ? '' : 'hidden'}`}>
        <div
          ref={containerRef}
          className="flex justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
        />
        {zoomable && status === 'ready' && (
          <ZoomButton onClick={() => setExpanded(true)} label={t('codeBlock.zoomChart')} />
        )}
      </div>
      {expanded && (
        <ChartZoomDialog onClose={() => setExpanded(false)} label={t('codeBlock.zoomChart')}>
          <VegaLiteChart spec={spec} zoomable={false} />
        </ChartZoomDialog>
      )}
    </>
  );
}
