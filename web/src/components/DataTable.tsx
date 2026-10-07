import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils.ts";
import { EmptyState, ErrorState, LoadingState, type EmptyStateProps } from "./States.tsx";

/**
 * The dense, sortable table the four screens share.
 *
 * Density dial 8: 13px body, 8px/12px cell padding, a sticky header, and a row height a user
 * can scan twenty of. It owns its empty, loading and error states so no screen has to
 * remember to render them.
 *
 * Sorting is single-column, click-to-cycle, and the state is the caller's — a screen usually
 * wants to put it in the URL, and a table that hid it would make that impossible.
 */

export interface Column<Row> {
  id: string;
  header: string;
  /** The cell. Keep it a node, not a string, so a cell can hold a badge or a button. */
  cell: (row: Row) => React.ReactNode;
  /** Supply to make the column sortable. Returns the value to compare. */
  sortValue?: (row: Row) => string | number;
  /** Tailwind width/alignment for both the header and the body cell. */
  className?: string;
  /** Right-align numeric columns so digits line up. */
  align?: "left" | "right";
}

export type SortDirection = "asc" | "desc";

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Describes the table for screen readers. Required — a table with no caption is a grid of noise. */
  caption: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  onRowClick?: (row: Row) => void;
  selectedKey?: string | null;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: Omit<EmptyStateProps, "className">;
  className?: string;
}

/** Cycles asc → desc → asc on the same column; a new column always starts ascending. */
export function nextSort(current: SortState | undefined, columnId: string): SortState {
  if (current?.columnId !== columnId) return { columnId, direction: "asc" };
  return { columnId, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function sortRows<Row>(rows: Row[], columns: Column<Row>[], sort: SortState | undefined): Row[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.id === sort.columnId);
  if (!column?.sortValue) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;
  // Copy first: mutating the caller's array would fight React Query's cached data.
  return [...rows].sort((a, b) => {
    const left = column.sortValue!(a);
    const right = column.sortValue!(b);
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return String(left).localeCompare(String(right), undefined, { numeric: true }) * factor;
  });
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSortChange,
  onRowClick,
  selectedKey,
  isLoading,
  error,
  onRetry,
  empty,
  className,
}: DataTableProps<Row>) {
  const sorted = React.useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading) return <LoadingState label={`Loading ${caption.toLowerCase()}`} />;
  if (sorted.length === 0) return <EmptyState {...empty} />;

  return (
    // px-3 so the first and last columns keep clear of the pane edge; the sticky header's own
    // background runs edge to edge behind it.
    <div className={cn("w-full overflow-auto px-3", className)}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-[var(--table-header-bg)]">
          <tr className="border-b border-[var(--table-border)]">
            {columns.map((column) => {
              const active = sort?.columnId === column.id;
              const sortable = Boolean(column.sortValue && onSortChange);
              return (
                <th
                  key={column.id}
                  scope="col"
                  // aria-sort is how a screen reader user learns the table is sorted at all.
                  aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : "none"}
                  className={cn(
                    "px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)]",
                    "text-2xs font-semibold uppercase tracking-[var(--tracking-wide)]",
                    "text-[var(--table-header-fg)]",
                    column.align === "right" ? "text-right" : "text-left",
                    column.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange!(nextSort(sort, column.id))}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 rounded-sm",
                        "transition-colors duration-[var(--duration-fast)] hover:text-fg",
                        active && "text-fg",
                      )}
                    >
                      {column.header}
                      <SortIcon active={active} direction={sort?.direction} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            return (
              <tr
                key={key}
                aria-selected={onRowClick ? selected : undefined}
                // A clickable row is reachable and activatable from the keyboard, or it is not
                // an affordance at all (ux-guidelines No. 41).
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "button" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        onRowClick(row);
                      }
                    : undefined
                }
                className={cn(
                  "border-b border-[var(--table-border)] transition-colors duration-[var(--duration-fast)]",
                  onRowClick && "cursor-pointer hover:bg-[var(--table-row-bg-hover)]",
                  selected && "bg-[var(--table-row-bg-selected)]",
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      "px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)] align-middle",
                      column.align === "right" ? "text-right" : "text-left",
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortIcon({ active, direction }: { active: boolean; direction?: SortDirection }) {
  const Icon = !active ? ChevronsUpDown : direction === "asc" ? ChevronUp : ChevronDown;
  return <Icon aria-hidden="true" className={cn("size-3", !active && "text-fg-subtle")} />;
}
