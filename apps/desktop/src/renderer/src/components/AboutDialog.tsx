import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppInfo } from '@/hooks/useAppInfo';
import { AppInfoList } from './AppInfoList';

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const info = useAppInfo();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="about-dialog">
        <DialogHeader>
          <DialogTitle>About {info?.appName ?? 'ATLAS'}</DialogTitle>
          <DialogDescription>Autonomous Task Leadership &amp; Agent System</DialogDescription>
        </DialogHeader>
        {info ? (
          <AppInfoList info={info} />
        ) : (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
