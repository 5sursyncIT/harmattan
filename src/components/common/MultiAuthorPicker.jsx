import { useEffect, useRef, useState } from 'react';
import { FiPlus, FiX, FiLoader, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import { getAdminAuthors, createAdminAuthor } from '../../api/admin';

/**
 * Sélecteur multi-auteurs avec autocomplete sur SQLite authors et création inline.
 *
 * Props :
 *   value        : Array<{ id, display_name, slug? }>
 *   onChange     : (newAuthors[]) => void
 *   maxAuthors   : limite (défaut 8)
 */
export default function MultiAuthorPicker({ value = [], onChange, maxAuthors = 8 }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const selectedIds = new Set(value.map((a) => a.id));

  const search = (q) => {
    setQuery(q);
    setCreateErr(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (!q || q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const ctl = new AbortController();
      abortRef.current = ctl;
      setLoading(true);
      try {
        const res = await getAdminAuthors({ q, limit: 10 }, { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        setSuggestions(res.data.authors || []);
        setOpen(true);
      } catch (err) {
        if (err.code === 'ERR_CANCELED') return;
        setSuggestions([]);
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    }, 300);
  };

  const pick = (author) => {
    if (selectedIds.has(author.id)) return;
    if (value.length >= maxAuthors) return;
    onChange([...value, {
      id: author.id,
      display_name: author.display_name || `${author.firstname || ''} ${author.lastname || ''}`.trim(),
      slug: author.slug,
    }]);
    setQuery('');
    setSuggestions([]);
    setOpen(false);
  };

  const remove = (id) => onChange(value.filter((a) => a.id !== id));
  const move = (idx, dir) => {
    const next = [...value];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  const createInline = async () => {
    const raw = query.trim();
    if (!raw || raw.length < 2) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const parts = raw.split(/\s+/);
      const firstname = parts.length > 1 ? parts[0] : '';
      const lastname  = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
      const res = await createAdminAuthor({ firstname, lastname });
      pick(res.data);
    } catch (err) {
      setCreateErr(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  const noExactMatch = query.length >= 2
    && !suggestions.some((s) => (s.display_name || `${s.firstname || ''} ${s.lastname || ''}`.trim()).toLowerCase() === query.trim().toLowerCase());

  return (
    <div className="multi-author-picker" ref={wrapperRef}>
      {value.length > 0 && (
        <ul className="map-chips" aria-label="Auteurs sélectionnés">
          {value.map((a, i) => (
            <li key={a.id} className="map-chip">
              <button type="button" className="map-chip-up" aria-label="Monter" onClick={() => move(i, -1)} disabled={i === 0}>
                <FiArrowUp size={12} />
              </button>
              <button type="button" className="map-chip-down" aria-label="Descendre" onClick={() => move(i, 1)} disabled={i === value.length - 1}>
                <FiArrowDown size={12} />
              </button>
              <span className="map-chip-pos">#{i + 1}</span>
              <span className="map-chip-name">{a.display_name}</span>
              <button type="button" className="map-chip-x" aria-label="Retirer" onClick={() => remove(a.id)}>
                <FiX size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {value.length < maxAuthors && (
        <div className="map-search-wrap">
          <input
            type="text"
            className="map-search"
            placeholder="Rechercher un auteur ou en créer un nouveau…"
            value={query}
            onChange={(e) => search(e.target.value)}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            autoComplete="off"
          />
          {loading && <FiLoader className="map-spin" size={14} />}

          {open && suggestions.length > 0 && (
            <ul className="map-suggestions" role="listbox">
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className={`map-suggestion ${selectedIds.has(s.id) ? 'disabled' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); if (!selectedIds.has(s.id)) pick(s); }}
                  role="option"
                  aria-disabled={selectedIds.has(s.id)}
                >
                  <span>{s.display_name || `${s.firstname || ''} ${s.lastname || ''}`.trim()}</span>
                  {selectedIds.has(s.id) && <span className="map-suggestion-tag">déjà ajouté</span>}
                </li>
              ))}
            </ul>
          )}

          {open && noExactMatch && (
            <div className="map-create-inline">
              <button type="button" onClick={createInline} disabled={creating}>
                <FiPlus size={14} /> Créer « {query.trim()} » comme nouvel auteur
              </button>
              {createErr && <span className="map-create-err">{createErr}</span>}
            </div>
          )}
        </div>
      )}

      {value.length >= maxAuthors && (
        <p className="map-limit">Maximum {maxAuthors} auteurs atteint</p>
      )}
    </div>
  );
}
