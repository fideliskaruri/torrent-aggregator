import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OwnerRequest } from "@/lib/requests";

const REASON_MAX = 500;

export function RequestDeclineDialog({
  request,
  reason,
  onReasonChange,
  onOpenChange,
  onConfirm,
}: {
  request: OwnerRequest | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={request != null}
      onOpenChange={onOpenChange}
      contentData={{ "data-owner-decline-dialog": true }}
      confirmData={{ "data-owner-decline-confirm": true }}
      title={`Decline ${request?.title ?? "this request"}?`}
      description="They'll see it was declined, and your reason if you give one."
      cancelLabel="Keep it"
      variant="destructive"
      confirmLabel="Decline request"
      onConfirm={onConfirm}
    >
      <div className="space-y-1.5">
        <Label htmlFor="decline-reason" className="text-xs text-muted-foreground">
          Reason <span className="font-normal text-subtle-foreground">(optional)</span>
        </Label>
        <Textarea
          id="decline-reason"
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => onReasonChange(event.target.value)}
          rows={3}
          className="min-h-20"
          placeholder="Already on a streaming service, for example"
          data-owner-decline-reason
        />
      </div>
    </ConfirmDialog>
  );
}
