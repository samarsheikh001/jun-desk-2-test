import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "cn"

/**
 * The root is a flex column and the viewport fills it (and shrinks with it), so a ScrollArea
 * scrolls both when its root gets a height from a grid/flex parent and when it only has a
 * max-height (popovers, dialogs). Children sit in Base UI's Content element, whose resizes
 * update the scrollbar (content that loads later); put their flex/grid layout on `contentClassName`.
 * Vertical only: content is as wide as the viewport.
 */
function ScrollArea({
  className,
  children,
  contentClassName,
  viewportProps,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** Classes for the element around the children inside the viewport (put flex/grid layout here). */
  contentClassName?: string
  /** e.g. `tabIndex: -1` to keep a small scroller out of the tab order, or ARIA attributes. */
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "className" | "children">
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative flex min-h-0 flex-col", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        {...viewportProps}
        className="min-h-0 w-full flex-auto rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {/* Base UI sizes Content to fit-content for horizontal scrolling; we only scroll vertically,
            so children get the viewport's width (otherwise wide selects push the content past it). */}
        <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className={contentClassName} style={{ minWidth: 0 }}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
