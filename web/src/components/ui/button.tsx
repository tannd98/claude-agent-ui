import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  // No `outline-none` anywhere: the global :focus-visible rule in styles/index.css is the ring.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] " +
    "font-medium cursor-pointer select-none transition-colors duration-[var(--duration-fast)] " +
    "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-fg-on-accent hover:bg-accent-hover",
        secondary: "bg-surface-raised text-fg border border-border hover:bg-surface-hover",
        ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
        danger: "bg-danger text-fg-on-danger hover:bg-danger-hover",
      },
      size: {
        sm: "h-[var(--button-height-sm)] px-2 text-xs [&_svg]:size-3.5",
        md: "h-[var(--button-height-md)] px-3 text-sm [&_svg]:size-4",
        icon: "h-[var(--button-height-md)] w-[var(--button-height-md)] [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Why this button is disabled. Rendered as the title and announced to assistive tech, so a
   * disabled control is never a dead end the user has to guess at.
   */
  disabledReason?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, disabled, disabledReason, title, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : title}
      {...props}
    />
  );
});

export { buttonVariants };
