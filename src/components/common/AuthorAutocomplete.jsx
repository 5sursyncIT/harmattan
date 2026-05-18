import { useEffect, useRef, useState } from 'react';
import { FiCheck, FiLoader, FiUsers } from 'react-icons/fi';
import { searchAuthors } from '../../api/admin';

/**
 * Champ auteur avec autocomplétion (debounce + AbortController + clavier).
 *
 * Props :
 * - value        : nom actuel
 * - onChange     : (newNom) => void (appelé à chaque frappe)
 * - onSelect     : (fullName) => void (appelé quand une suggestion est retenue)
 * - extraQuery   : chaîne ajoutée pour le back (ex: prénom)
 * - onBlur, placeholder, maxLength, autoComplete, ...inputProps
 */
export default function AuthorAutocomplete({
  value,
  onChange,
  onSelect,
  extraQuery = '',
  ...inputProps
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = (newValue) => {
    onChange(newValue);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (!newValue || newValue.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const q = extraQuery ? `${newValue} ${extraQuery}` : newValue;
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const res = await searchAuthors(q.trim(), 8, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSuggestions(res.data.authors || []);
        setShowSuggestions(true);
      } catch (err) {
        if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
        setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
  };

  const handleKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      onSelect(suggestions[activeIndex].name);
      setShowSuggestions(false);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="author-autocomplete" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setShowSuggestions(true);
        }}
        aria-autocomplete="list"
        aria-expanded={showSuggestions}
        aria-controls="author-suggestions-list"
        autoComplete="off"
        {...inputProps}
      />
      {loading && (
        <span className="author-loading">
          <FiLoader className="spin" size={14} aria-label="Recherche en cours" />
        </span>
      )}
      {showSuggestions && suggestions.length > 0 && (
        <ul className="author-suggestions" id="author-suggestions-list" role="listbox">
          <li className="author-suggestions-header" aria-hidden="true">
            <FiUsers size={12} /> {suggestions.length} auteur(s) existant(s) — cliquez pour réutiliser
          </li>
          {suggestions.map((a, i) => (
            <li
              key={i}
              className={`author-suggestion-item ${activeIndex === i ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(a.name);
                setShowSuggestions(false);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              role="option"
              aria-selected={activeIndex === i}
            >
              <span className="author-suggestion-name">{a.name}</span>
              <span className="author-suggestion-count">
                {a.book_count} livre{a.book_count > 1 ? 's' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {showSuggestions && suggestions.length === 0 && !loading && value.length >= 2 && (
        <ul className="author-suggestions">
          <li className="author-suggestions-empty">
            <FiCheck size={12} aria-hidden="true" /> Nouvel auteur — aucun doublon détecté
          </li>
        </ul>
      )}
    </div>
  );
}
