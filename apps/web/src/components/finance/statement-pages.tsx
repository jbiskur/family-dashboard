"use client";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";

/** Bounded rendering for one statement; pagination never changes imported rows. */
export function StatementPages<T>({
  items,
  label,
  children,
}: {
  items: T[];
  label: string;
  children: (page: T[]) => ReactNode;
}) {
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / 25));
  const page = Math.min(requestedPage, pageCount - 1);
  return (
    <div className="statement-pages">
      {children(items.slice(page * 25, (page + 1) * 25))}
      {items.length > 25 && (
        <nav className="statement-pagination" aria-label={`${label} pages`}>
          <p aria-live="polite">
            {label}: {page * 25 + 1}–{Math.min((page + 1) * 25, items.length)}{" "}
            of {items.length.toLocaleString("en")}
          </p>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`First ${label.toLowerCase()} page`}
              disabled={page === 0}
              onClick={() => setPage(0)}
            >
              <ChevronsLeft size={18} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Previous ${label.toLowerCase()} page`}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={18} /> Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Next ${label.toLowerCase()} page`}
              disabled={page === pageCount - 1}
              onClick={() => setPage(page + 1)}
            >
              Next <ChevronRight size={18} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Last ${label.toLowerCase()} page`}
              disabled={page === pageCount - 1}
              onClick={() => setPage(pageCount - 1)}
            >
              <ChevronsRight size={18} />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
