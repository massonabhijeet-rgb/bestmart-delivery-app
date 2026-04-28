import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { fuzzyRank } from '../lib/fuzzySearch';
import type { Category } from '../services/api';

interface CategoryPickerProps {
  categories: Category[];
  value: number | null; // currently selected category id
  onChange: (id: number | null) => void;
  placeholder?: string;
  required?: boolean;
}

interface CategoryOption {
  id: number;
  name: string; // own name only ("Small")
  depth: number; // 0 = top-level
  breadcrumb: string; // "Baby Care › Diapers & Wipes › Small"
  searchText: string; // lowercase breadcrumb for fuzzy match
}

/// Searchable hierarchical category picker. The same field handles every
/// level — type "small di" and matches surface from anywhere in the tree.
/// Forward-compatible with multi-select / tags / bulk edit (the API
/// contract is `id | null`; flipping to `number[]` is the only client
/// change those features will need).
export function CategoryPicker({
  categories,
  value,
  onChange,
  placeholder = 'Search category...',
  required,
}: CategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Walk the tree once into a flat, hierarchically-sorted list with full
  // breadcrumb labels. useMemo so a parent re-render with the same
  // categories array doesn't rebuild this.
  const options = useMemo<CategoryOption[]>(
    () => buildHierarchicalOptions(categories),
    [categories],
  );

  const selectedOption = useMemo(
    () => (value != null ? options.find((o) => o.id === value) ?? null : null),
    [options, value],
  );

  // Filter via fuzzy search on the breadcrumb so "small di" matches
  // "Baby Care › Diapers & Wipes › Small". Empty query → full list.
  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    return fuzzyRank(query, options, (o) => [o.searchText, o.name]);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Keep the highlighted item in view when arrow-keying through results.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const node = listRef.current.children[activeIdx] as
      | HTMLElement
      | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open, filtered.length]);

  // Reset the highlight when results change (e.g., new query).
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  function commit(id: number) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    onChange(null);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) commit(pick.id);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div className="cat-picker" ref={wrapperRef}>
      {/* Selected chip when collapsed; turns into search input when open. */}
      {!open && selectedOption ? (
        <button
          type="button"
          className="cat-picker__selected"
          onClick={() => {
            setOpen(true);
            // Defer focus so the input mounts before we focus it.
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <span className="cat-picker__selected-path">
            {selectedOption.breadcrumb}
          </span>
          <span
            className="cat-picker__clear"
            role="button"
            aria-label="Clear category"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
          >
            ×
          </span>
        </button>
      ) : (
        <input
          ref={inputRef}
          type="text"
          className="cat-picker__input"
          placeholder={
            selectedOption ? selectedOption.breadcrumb : placeholder
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          required={required && value == null}
        />
      )}

      {open && (
        <div className="cat-picker__panel">
          {filtered.length === 0 ? (
            <div className="cat-picker__empty">No categories match.</div>
          ) : (
            <ul className="cat-picker__list" ref={listRef} role="listbox">
              {filtered.map((opt, i) => (
                <li
                  key={opt.id}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`cat-picker__item${
                    i === activeIdx ? ' cat-picker__item--active' : ''
                  }${value === opt.id ? ' cat-picker__item--selected' : ''}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={(e) => {
                    // mousedown beats the input's blur so the click registers.
                    e.preventDefault();
                    commit(opt.id);
                  }}
                  style={{ paddingLeft: `${10 + opt.depth * 14}px` }}
                >
                  <span className="cat-picker__item-name">{opt.name}</span>
                  {opt.depth > 0 && (
                    <span className="cat-picker__item-crumb">
                      {opt.breadcrumb.replace(` › ${opt.name}`, '')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/// Walks the parent_id tree into a flat array with breadcrumb labels,
/// sorted depth-first (parents directly above their children) and
/// alphabetically within each level. O(n) — categories table is small.
function buildHierarchicalOptions(categories: Category[]): CategoryOption[] {
  const byParent = new Map<number | null, Category[]>();
  for (const c of categories) {
    const key = c.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(c);
    else byParent.set(key, [c]);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  const out: CategoryOption[] = [];
  function walk(parentId: number | null, depth: number, crumbs: string[]) {
    const kids = byParent.get(parentId) ?? [];
    for (const c of kids) {
      const newCrumbs = [...crumbs, c.name];
      const breadcrumb = newCrumbs.join(' › ');
      out.push({
        id: c.id,
        name: c.name,
        depth,
        breadcrumb,
        searchText: breadcrumb.toLowerCase(),
      });
      walk(c.id, depth + 1, newCrumbs);
    }
  }
  walk(null, 0, []);
  return out;
}
