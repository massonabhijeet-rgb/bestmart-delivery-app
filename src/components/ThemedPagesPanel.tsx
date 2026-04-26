import { useEffect, useMemo, useState } from 'react';
import {
  apiCreateThemedPage,
  apiDeleteThemedPage,
  apiListCategories,
  apiListThemedPagesAdmin,
  apiReplaceThemedPageTiles,
  apiUpdateThemedPage,
  apiUploadThemedPageImage,
  apiUploadThemedPageTileImage,
  type Category,
  type ThemedPage,
  type ThemedPageInput,
  type ThemedPageTile,
  type ThemedPageTileInput,
  type ThemedPageTileLinkType,
} from '../services/api';
import { confirm } from './ConfirmDialog';

const LINK_TYPE_OPTIONS: Array<{ value: ThemedPageTileLinkType; label: string }> = [
  { value: 'category',    label: 'Category filter' },
  { value: 'search',      label: 'Search query' },
  { value: 'product_ids', label: 'Specific products (IDs)' },
];

const DEFAULT_TILE_BG = '#FFE6C7';

type EditableTile = ThemedPageTileInput & {
  /** Local-only id used as a React key while a tile is unsaved.
   *  Replaced by the server-issued numeric id after the first save. */
  localKey: string;
  /** Mirrors the server's persisted id when present so per-tile image
   *  uploads can target the right row. Cleared on a fresh "+ Add tile". */
  serverId?: number | null;
  imageUrl?: string | null;
};

// `<input type="datetime-local">` reads/writes in *local* time without
// any timezone marker. The server stores TIMESTAMPTZ (UTC), so we have
// to translate in both directions or "26 Apr 02:16 PM" gets interpreted
// as UTC 14:16 (IST 7:46 PM) and the page sits as "scheduled" instead of
// live.
function toLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInput(local: string | null): string | null {
  if (!local) return null;
  // new Date('2026-04-26T14:16') is parsed as the browser's local time;
  // toISOString() then emits the equivalent UTC instant the server
  // can compare against NOW().
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function newLocalKey() {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

function tileFromServer(t: ThemedPageTile): EditableTile {
  return {
    localKey: newLocalKey(),
    serverId: t.id,
    id: t.id,
    label: t.label,
    sublabel: t.sublabel,
    imageUrl: t.imageUrl,
    bgColor: t.bgColor,
    linkType: t.linkType,
    linkCategoryId: t.linkCategoryId,
    linkSearchQuery: t.linkSearchQuery,
    linkProductIds: t.linkProductIds,
    sortOrder: t.sortOrder,
  };
}

function emptyPageInput(): ThemedPageInput {
  return {
    slug: '',
    title: '',
    subtitle: '',
    themeColor: '#B5DAF8',
    isActive: true,
    sortOrder: 0,
    validFrom: null,
    validTo: null,
  };
}

export default function ThemedPagesPanel() {
  const [pages, setPages] = useState<ThemedPage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // null = list view; 'new' = create form; number = editing existing.
  const [editorMode, setEditorMode] = useState<null | 'new' | number>(null);
  const [editorPage, setEditorPage] = useState<ThemedPageInput>(emptyPageInput());
  const [editorTiles, setEditorTiles] = useState<EditableTile[]>([]);
  const [editorCurrent, setEditorCurrent] = useState<ThemedPage | null>(null);
  const [saving, setSaving] = useState(false);
  const [tilesSaving, setTilesSaving] = useState(false);
  const [editorNotice, setEditorNotice] = useState('');

  const loadAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [list, cats] = await Promise.all([
        apiListThemedPagesAdmin(),
        apiListCategories(),
      ]);
      setPages(list);
      setCategories(cats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load themed pages');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  function openNew() {
    setEditorMode('new');
    setEditorCurrent(null);
    setEditorPage(emptyPageInput());
    setEditorTiles([]);
    setEditorNotice('');
  }

  function openEdit(p: ThemedPage) {
    setEditorMode(p.id);
    setEditorCurrent(p);
    setEditorPage({
      slug: p.slug,
      title: p.title,
      subtitle: p.subtitle ?? '',
      themeColor: p.themeColor ?? '#B5DAF8',
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      validFrom: p.validFrom,
      validTo: p.validTo,
    });
    setEditorTiles(p.tiles.map(tileFromServer));
    setEditorNotice('');
  }

  function closeEditor() {
    setEditorMode(null);
    setEditorCurrent(null);
    setEditorPage(emptyPageInput());
    setEditorTiles([]);
    setEditorNotice('');
  }

  async function handleSavePage() {
    setSaving(true);
    setEditorNotice('');
    try {
      if (editorMode === 'new') {
        const created = await apiCreateThemedPage(editorPage);
        setEditorMode(created.id);
        setEditorCurrent(created);
        setEditorNotice('Page created. Add tiles below, then save tiles.');
      } else if (typeof editorMode === 'number') {
        const updated = await apiUpdateThemedPage(editorMode, editorPage);
        setEditorCurrent(updated);
        setEditorNotice('Page saved.');
      }
      await loadAll();
    } catch (err) {
      setEditorNotice(
        err instanceof Error ? err.message : 'Failed to save page',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveTiles() {
    if (typeof editorMode !== 'number') {
      setEditorNotice('Save the page first, then add tiles.');
      return;
    }
    setTilesSaving(true);
    setEditorNotice('');
    try {
      // Strip local-only fields before sending; backend only cares about
      // the actual tile shape. Sort order is normalized to the current
      // visual order in the editor.
      const payload: ThemedPageTileInput[] = editorTiles.map((t, i) => ({
        id: t.serverId ?? null,
        label: t.label,
        sublabel: t.sublabel ?? null,
        imageUrl: t.imageUrl ?? null,
        bgColor: t.bgColor ?? null,
        linkType: t.linkType,
        linkCategoryId: t.linkCategoryId ?? null,
        linkSearchQuery: t.linkSearchQuery ?? null,
        linkProductIds: t.linkProductIds ?? null,
        sortOrder: i,
      }));
      const updated = await apiReplaceThemedPageTiles(editorMode, payload);
      setEditorCurrent(updated);
      setEditorTiles(updated.tiles.map(tileFromServer));
      setEditorNotice('Tiles saved.');
      await loadAll();
    } catch (err) {
      setEditorNotice(
        err instanceof Error ? err.message : 'Failed to save tiles',
      );
    } finally {
      setTilesSaving(false);
    }
  }

  async function handleDeletePage(p: ThemedPage) {
    const ok = await confirm({
      title: `Delete "${p.title}"?`,
      message:
        'This deletes the page, all its tiles, and any uploaded artwork. ' +
        'There is no undo.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDeleteThemedPage(p.id);
      if (editorMode === p.id) closeEditor();
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete page');
    }
  }

  async function handleHeroUpload(file: File) {
    if (typeof editorMode !== 'number') return;
    try {
      const updated = await apiUploadThemedPageImage(editorMode, 'hero', file);
      setEditorCurrent(updated);
      setEditorNotice('Hero image updated.');
      await loadAll();
    } catch (err) {
      setEditorNotice(
        err instanceof Error ? err.message : 'Hero upload failed',
      );
    }
  }

  async function handleNavUpload(file: File) {
    if (typeof editorMode !== 'number') return;
    try {
      const updated = await apiUploadThemedPageImage(editorMode, 'nav', file);
      setEditorCurrent(updated);
      setEditorNotice('Nav icon updated.');
      await loadAll();
    } catch (err) {
      setEditorNotice(
        err instanceof Error ? err.message : 'Nav icon upload failed',
      );
    }
  }

  async function handleTileImageUpload(tile: EditableTile, file: File) {
    if (typeof editorMode !== 'number' || !tile.serverId) return;
    try {
      const updated = await apiUploadThemedPageTileImage(
        editorMode,
        tile.serverId,
        file,
      );
      setEditorTiles((prev) =>
        prev.map((t) =>
          t.localKey === tile.localKey
            ? { ...t, imageUrl: updated.imageUrl }
            : t,
        ),
      );
      setEditorNotice(`Tile "${tile.label}" image updated.`);
    } catch (err) {
      setEditorNotice(
        err instanceof Error ? err.message : 'Tile image upload failed',
      );
    }
  }

  function addTile() {
    setEditorTiles((prev) => [
      ...prev,
      {
        localKey: newLocalKey(),
        serverId: null,
        label: '',
        sublabel: '',
        bgColor: DEFAULT_TILE_BG,
        linkType: 'category',
        linkCategoryId: null,
        linkSearchQuery: '',
        linkProductIds: null,
        sortOrder: prev.length,
      },
    ]);
  }

  function updateTile(localKey: string, patch: Partial<EditableTile>) {
    setEditorTiles((prev) =>
      prev.map((t) => (t.localKey === localKey ? { ...t, ...patch } : t)),
    );
  }

  function removeTile(localKey: string) {
    setEditorTiles((prev) => prev.filter((t) => t.localKey !== localKey));
  }

  function moveTile(localKey: string, dir: -1 | 1) {
    setEditorTiles((prev) => {
      const idx = prev.findIndex((t) => t.localKey === localKey);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  const inEditor = editorMode !== null;
  const editingExisting = typeof editorMode === 'number';

  // Tile validation summary so we can disable the save button when any
  // tile's link target is missing or invalid.
  const tilesValid = useMemo(() => {
    if (editorTiles.length === 0) return false;
    return editorTiles.every((t) => {
      if (!t.label.trim()) return false;
      if (t.linkType === 'category' && t.linkCategoryId == null) return false;
      if (t.linkType === 'search' && !(t.linkSearchQuery ?? '').trim()) return false;
      if (
        t.linkType === 'product_ids' &&
        !(t.linkProductIds && t.linkProductIds.length > 0)
      )
        return false;
      return true;
    });
  }, [editorTiles]);

  return (
    <div className="themed-pages section-box">
      <div className="section-box__head">
        <div>
          <h2>Themed pages</h2>
          <p>
            Editorial seasonal landing pages — each gets a tab on the storefront
            and a hero + tile grid landing screen.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button type="button" className="ghost-button" onClick={() => void loadAll()} disabled={loading}>
            {loading ? '…' : '↻ Refresh'}
          </button>
          {!inEditor && (
            <button type="button" className="primary-button" onClick={openNew}>
              + New page
            </button>
          )}
          {inEditor && (
            <button type="button" className="ghost-button" onClick={closeEditor}>
              ← Back to list
            </button>
          )}
        </div>
      </div>

      {error && <div className="message message--error">{error}</div>}

      {!inEditor && (
        <div className="themed-pages__list">
          {loading && pages.length === 0 ? (
            <p className="empty-state">Loading…</p>
          ) : pages.length === 0 ? (
            <p className="empty-state">
              No themed pages yet. Click “+ New page” to create the first one
              (e.g. Summer, Diwali).
            </p>
          ) : (
            <ul className="themed-page-row-list">
              {pages.map((p) => {
                const status =
                  !p.isActive
                    ? 'inactive'
                    : p.validFrom && new Date(p.validFrom) > new Date()
                      ? 'scheduled'
                      : p.validTo && new Date(p.validTo) <= new Date()
                        ? 'expired'
                        : 'live';
                return (
                  <li key={p.id} className="themed-page-row">
                    <div className="themed-page-row__icon">
                      {p.navIconUrl ? (
                        <img src={p.navIconUrl} alt="" loading="lazy" />
                      ) : (
                        <div className="themed-page-row__icon-ph" />
                      )}
                    </div>
                    <div className="themed-page-row__main">
                      <div className="themed-page-row__title-line">
                        <strong>{p.title}</strong>
                        <span className={`themed-page-row__status themed-page-row__status--${status}`}>
                          {status}
                        </span>
                      </div>
                      <div className="themed-page-row__meta">
                        slug: <code>{p.slug}</code> · {p.tiles.length} tile
                        {p.tiles.length === 1 ? '' : 's'} · sort {p.sortOrder}
                      </div>
                    </div>
                    <div className="themed-page-row__actions">
                      <button type="button" className="ghost-button" onClick={() => openEdit(p)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="ghost-button danger"
                        onClick={() => void handleDeletePage(p)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {inEditor && (
        <div className="themed-pages__editor">
          <h3>{editingExisting ? `Edit "${editorCurrent?.title ?? ''}"` : 'New themed page'}</h3>

          {editorNotice && <div className="message">{editorNotice}</div>}

          <div className="themed-pages__form-grid">
            <label>
              <span>Slug *</span>
              <input
                type="text"
                value={editorPage.slug}
                onChange={(e) =>
                  setEditorPage({
                    ...editorPage,
                    slug: e.target.value.toLowerCase().replace(/\s+/g, '-'),
                  })
                }
                placeholder="summer"
                disabled={editingExisting && saving}
              />
              <small>Used in URLs. Lowercase, hyphens only.</small>
            </label>

            <label>
              <span>Title *</span>
              <input
                type="text"
                value={editorPage.title}
                onChange={(e) =>
                  setEditorPage({ ...editorPage, title: e.target.value })
                }
                placeholder="Summer"
              />
              <small>Shown in the storefront top-nav tab.</small>
            </label>

            <label className="themed-pages__form-grid__wide">
              <span>Subtitle</span>
              <input
                type="text"
                value={editorPage.subtitle ?? ''}
                onChange={(e) =>
                  setEditorPage({ ...editorPage, subtitle: e.target.value })
                }
                placeholder="Beat the heat this Summer"
              />
            </label>

            <label>
              <span>Theme color</span>
              <input
                type="color"
                value={editorPage.themeColor ?? '#B5DAF8'}
                onChange={(e) =>
                  setEditorPage({ ...editorPage, themeColor: e.target.value })
                }
              />
              <small>Used as the page background tint.</small>
            </label>

            <label>
              <span>Sort order</span>
              <input
                type="number"
                value={editorPage.sortOrder ?? 0}
                onChange={(e) =>
                  setEditorPage({
                    ...editorPage,
                    sortOrder: Number(e.target.value) || 0,
                  })
                }
              />
              <small>Lower numbers show first in the top-nav.</small>
            </label>

            <label>
              <span>Active</span>
              <input
                type="checkbox"
                checked={editorPage.isActive ?? true}
                onChange={(e) =>
                  setEditorPage({ ...editorPage, isActive: e.target.checked })
                }
              />
              <small>Off = hidden from customers regardless of dates.</small>
            </label>

            <label>
              <span>Valid from</span>
              <input
                type="datetime-local"
                value={toLocalDateTimeInput(editorPage.validFrom)}
                onChange={(e) =>
                  setEditorPage({
                    ...editorPage,
                    validFrom: fromLocalDateTimeInput(e.target.value),
                  })
                }
              />
              <small>Leave blank to start immediately. Times are local.</small>
            </label>

            <label>
              <span>Valid to</span>
              <input
                type="datetime-local"
                value={toLocalDateTimeInput(editorPage.validTo)}
                onChange={(e) =>
                  setEditorPage({
                    ...editorPage,
                    validTo: fromLocalDateTimeInput(e.target.value),
                  })
                }
              />
              <small>Leave blank for no end date. Times are local.</small>
            </label>
          </div>

          <div className="themed-pages__form-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleSavePage()}
              disabled={saving || !editorPage.slug.trim() || !editorPage.title.trim()}
            >
              {saving ? 'Saving…' : editingExisting ? 'Save page' : 'Create page'}
            </button>
            {editingExisting && editorCurrent && (
              <button
                type="button"
                className="ghost-button danger"
                onClick={() => void handleDeletePage(editorCurrent)}
              >
                Delete page
              </button>
            )}
          </div>

          {editingExisting && editorCurrent && (
            <>
              <hr className="themed-pages__sep" />
              <h4>Artwork</h4>
              <div className="themed-pages__art-grid">
                <div className="themed-pages__art-slot">
                  <span className="themed-pages__art-label">
                    Nav icon (square, ~192px)
                  </span>
                  <div className="themed-pages__art-preview">
                    {editorCurrent.navIconUrl ? (
                      <img src={editorCurrent.navIconUrl} alt="Nav icon" />
                    ) : (
                      <span className="themed-pages__art-empty">No image</span>
                    )}
                  </div>
                  {/* Native <label> wrapping the input is more reliable
                      than calling .click() on a ref — some browsers /
                      webviews silently block programmatic clicks on
                      display:none file inputs. */}
                  <label className="ghost-button themed-pages__upload-label">
                    Upload nav icon
                    <input
                      type="file"
                      accept="image/*"
                      className="themed-pages__upload-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleNavUpload(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                <div className="themed-pages__art-slot themed-pages__art-slot--wide">
                  <span className="themed-pages__art-label">
                    Hero banner (1080×480 recommended)
                  </span>
                  <div className="themed-pages__art-preview themed-pages__art-preview--wide">
                    {editorCurrent.heroImageUrl ? (
                      <img src={editorCurrent.heroImageUrl} alt="Hero" />
                    ) : (
                      <span className="themed-pages__art-empty">No image</span>
                    )}
                  </div>
                  <label className="ghost-button themed-pages__upload-label">
                    Upload hero image
                    <input
                      type="file"
                      accept="image/*"
                      className="themed-pages__upload-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleHeroUpload(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>

              <hr className="themed-pages__sep" />
              <h4>Tiles</h4>
              <p className="themed-pages__tiles-help">
                Each tile becomes a tappable card on the landing screen. Add up
                to ~6 tiles. Tile artwork uploads only after the tile has been
                saved (it needs a server id).
              </p>

              <div className="themed-pages__tiles">
                {editorTiles.length === 0 && (
                  <p className="empty-state">
                    No tiles yet. Click "+ Add tile" to start.
                  </p>
                )}
                {editorTiles.map((t, i) => (
                  <ThemedPageTileEditor
                    key={t.localKey}
                    tile={t}
                    index={i}
                    total={editorTiles.length}
                    categories={categories}
                    canUpload={!!t.serverId}
                    onChange={(patch) => updateTile(t.localKey, patch)}
                    onMove={(dir) => moveTile(t.localKey, dir)}
                    onRemove={() => removeTile(t.localKey)}
                    onUploadImage={(file) => void handleTileImageUpload(t, file)}
                  />
                ))}
              </div>

              <div className="themed-pages__form-actions">
                <button type="button" className="ghost-button" onClick={addTile}>
                  + Add tile
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleSaveTiles()}
                  disabled={tilesSaving || !tilesValid}
                  title={
                    !tilesValid
                      ? 'Each tile needs a label and a valid link target.'
                      : undefined
                  }
                >
                  {tilesSaving ? 'Saving…' : 'Save tiles'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface TileEditorProps {
  tile: EditableTile;
  index: number;
  total: number;
  categories: Category[];
  canUpload: boolean;
  onChange: (patch: Partial<EditableTile>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onUploadImage: (file: File) => void;
}

function ThemedPageTileEditor({
  tile,
  index,
  total,
  categories,
  canUpload,
  onChange,
  onMove,
  onRemove,
  onUploadImage,
}: TileEditorProps) {
  return (
    <div className="themed-page-tile">
      <div className="themed-page-tile__head">
        <strong>Tile {index + 1}</strong>
        <div className="themed-page-tile__head-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className="ghost-button danger"
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="themed-page-tile__body">
        <div className="themed-page-tile__art">
          <div
            className="themed-page-tile__preview"
            style={{ background: tile.bgColor ?? DEFAULT_TILE_BG }}
          >
            {tile.imageUrl ? (
              <img src={tile.imageUrl} alt={tile.label} />
            ) : (
              <span className="themed-pages__art-empty">No image</span>
            )}
          </div>
          {/* Native <label> + nested <input disabled> handles the gate
              cleanly: a disabled file input ignores its label's click,
              so the picker never opens until canUpload flips to true. */}
          <label
            className={`ghost-button themed-pages__upload-label${
              canUpload ? '' : ' themed-pages__upload-label--disabled'
            }`}
            title={
              !canUpload
                ? 'Save tiles first — image uploads need a tile id.'
                : undefined
            }
          >
            Upload image
            <input
              type="file"
              accept="image/*"
              className="themed-pages__upload-hidden"
              disabled={!canUpload}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadImage(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="themed-page-tile__fields">
          <label>
            <span>Label *</span>
            <input
              type="text"
              value={tile.label}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder="Self Care"
            />
          </label>

          <label>
            <span>Sublabel</span>
            <input
              type="text"
              value={tile.sublabel ?? ''}
              onChange={(e) => onChange({ sublabel: e.target.value })}
              placeholder="Up to 50% OFF"
            />
          </label>

          <label>
            <span>Background color</span>
            <input
              type="color"
              value={tile.bgColor ?? DEFAULT_TILE_BG}
              onChange={(e) => onChange({ bgColor: e.target.value })}
            />
          </label>

          <label>
            <span>Link type</span>
            <select
              value={tile.linkType}
              onChange={(e) => {
                const next = e.target.value as ThemedPageTileLinkType;
                onChange({
                  linkType: next,
                  linkCategoryId: next === 'category' ? tile.linkCategoryId : null,
                  linkSearchQuery: next === 'search' ? tile.linkSearchQuery : null,
                  linkProductIds: next === 'product_ids' ? tile.linkProductIds : null,
                });
              }}
            >
              {LINK_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {tile.linkType === 'category' && (
            <label>
              <span>Category *</span>
              <select
                value={tile.linkCategoryId ?? ''}
                onChange={(e) =>
                  onChange({
                    linkCategoryId: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              >
                <option value="">— Pick a category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {tile.linkType === 'search' && (
            <label>
              <span>Search query *</span>
              <input
                type="text"
                value={tile.linkSearchQuery ?? ''}
                onChange={(e) =>
                  onChange({ linkSearchQuery: e.target.value })
                }
                placeholder="ice cream"
              />
            </label>
          )}

          {tile.linkType === 'product_ids' && (
            <label>
              <span>Product IDs (comma-separated) *</span>
              <input
                type="text"
                value={(tile.linkProductIds ?? []).join(', ')}
                onChange={(e) => {
                  const ids = e.target.value
                    .split(',')
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isFinite(n) && n > 0);
                  onChange({ linkProductIds: ids.length > 0 ? ids : null });
                }}
                placeholder="12, 34, 56"
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
