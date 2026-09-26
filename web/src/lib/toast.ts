import { toast as sonnerToast } from "sonner";

type ErrorOptions = NonNullable<Parameters<typeof sonnerToast.error>[1]> & {
  id?: string;
};

const toast = Object.assign(
  ((...args: Parameters<typeof sonnerToast>) => sonnerToast(...args)) as typeof sonnerToast,
  sonnerToast,
  {
    error(message: string, options?: ErrorOptions) {
      return sonnerToast.error(message, {
        duration: Infinity,
        id: message,
        ...options,
      });
    },
  },
);

export { toast };
