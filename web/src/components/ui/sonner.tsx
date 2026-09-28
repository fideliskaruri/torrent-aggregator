import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"
import { useMediaQuery } from "@/hooks/use-media-query"

// TorrentFlow is dark only, so the theme is fixed instead of read from
// next-themes. Phones get top-center toasts under the header so they never
// sit on the bottom nav.
const Toaster = ({
  position,
  visibleToasts = 5,
  expand = true,
  closeButton = true,
  richColors = true,
  duration = 5000,
  offset = "calc(1rem + var(--safe-bottom))",
  mobileOffset = "var(--header-h)",
  ...props
}: ToasterProps) => {
  const isMobile = useMediaQuery("(max-width: 639px)")

  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position={isMobile ? "top-center" : (position ?? "bottom-right")}
      visibleToasts={visibleToasts}
      expand={expand}
      closeButton={closeButton}
      richColors={richColors}
      duration={duration}
      offset={offset}
      mobileOffset={mobileOffset}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast shadow-[var(--shadow-md)]",
          description: "text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground",
          cancelButton: "bg-muted text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
