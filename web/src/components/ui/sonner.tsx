import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] shadow-[var(--shadow-md)]",
          description: "text-[var(--text-secondary)]",
          actionButton:
            "bg-[var(--primary)] text-[var(--primary-foreground)]",
          cancelButton: "bg-[var(--bg-muted)] text-[var(--text-secondary)]",
          success: "border-[rgba(62,207,142,0.3)]",
          error: "border-[rgba(240,113,120,0.35)]",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
