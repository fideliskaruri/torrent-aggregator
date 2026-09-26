import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";

function Toaster({
  position,
  visibleToasts = 5,
  expand = true,
  closeButton = true,
  richColors = true,
  duration = 5000,
  offset = "calc(1rem + var(--safe-bottom))",
  mobileOffset = "var(--header-h)",
  ...props
}: ToasterProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");

  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position={isMobile ? "top-center" : position ?? "bottom-right"}
      visibleToasts={visibleToasts}
      expand={expand}
      closeButton={closeButton}
      richColors={richColors}
      duration={duration}
      offset={offset}
      mobileOffset={mobileOffset}
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
