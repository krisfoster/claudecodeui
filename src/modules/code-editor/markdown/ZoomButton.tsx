import { Maximize2 } from 'lucide-react';

type ZoomButtonProps = {
  onClick: () => void;
  label: string;
};

/**
 * Hover-reveal zoom affordance for a rendered diagram/chart/visualization.
 * A whole-surface click (like the image lightbox uses) would compete with
 * Vega-Lite's own hover tooltips, so this is an explicit corner button
 * instead — same `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`
 * idiom as the code-block Copy buttons in Markdown.tsx/MarkdownCodeBlock.tsx,
 * so it's also reachable by keyboard, not just a mouse hover.
 */
export default function ZoomButton({ onClick, label }: ZoomButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 p-1.5 text-foreground/80 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
    >
      <Maximize2 className="h-4 w-4" />
    </button>
  );
}
