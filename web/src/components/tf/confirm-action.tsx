import { useState, type ReactNode } from "react";
import type { ComponentProps } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";

type ButtonProps = ComponentProps<typeof Button>;

export function ConfirmAction({
  label,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  variant = "destructive",
  buttonProps,
}: {
  label: ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  variant?: ButtonProps["variant"];
  buttonProps?: Omit<ButtonProps, "children" | "onClick" | "type" | "variant">;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)} {...buttonProps}>{label}</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={error ? (
          <div className="space-y-3">
            {description}
            <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          </div>
        ) : description}
        confirmLabel={confirmLabel}
        busy={pending}
        onConfirm={() => void confirm()}
      />
    </>
  );
}
