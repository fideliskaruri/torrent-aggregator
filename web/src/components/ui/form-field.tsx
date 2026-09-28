import * as React from "react"

import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"

/**
 * A labelled form field built on the shadcn `Field` parts.
 *
 * Placeholder-only forms lose their labels the moment a value is typed, and a
 * bare numeric input tells the user nothing at all. Every control that takes
 * user input should say what it is.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Field className={className}>
      <FieldLabel
        htmlFor={htmlFor}
        className="text-xs font-normal text-subtle-foreground"
      >
        {label}
      </FieldLabel>
      {children}
      {hint ? (
        <FieldDescription className="text-xs text-subtle-foreground">
          {hint}
        </FieldDescription>
      ) : null}
    </Field>
  )
}
