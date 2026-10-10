import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type ChartZoomDialogProps = {
  onClose: () => void;
  /** Accessible name for the dialog (sr-only) and the thing being enlarged. */
  label: string;
  children: ReactNode;
};

/**
 * Large, near-fullscreen Dialog for a zoomed diagram/chart/visualization —
 * same sizing idiom as CommandResultModal.tsx, built on the existing Dialog
 * primitive (portal, backdrop click, Escape, focus trap, scroll lock) rather
 * than the simpler bespoke ImageLightbox, which has none of those. Always
 * mounted with `open` already true by its caller (MermaidDiagram/
 * VegaLiteChart/D3Sandbox only render this at all once `expanded` is true),
 * so there is no separate trigger here.
 *
 * DialogContent itself has no built-in close affordance — every real usage
 * (CommandResultModal, ImageLightbox) adds its own, so this does too.
 */
export default function ChartZoomDialog({ onClose, label, children }: ChartZoomDialogProps) {
  const { t } = useTranslation('chat');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[min(92dvh,56rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-auto rounded-3xl border-border/80 bg-popover p-4 shadow-2xl sm:w-[min(94vw,72rem)]">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('misc.close')}
          className="absolute right-4 top-4 z-10 rounded-full bg-muted/80 p-2 text-foreground/80 transition-colors hover:bg-muted"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
