import { useState, useEffect } from 'react';
import { posGetCategories } from '../../api/pos';
import './CategoryBar.css';

export default function CategoryBar({ selected, onSelect }) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    posGetCategories().then((res) => setCategories(res.data)).catch(() => {});
  }, []);

  return (
    <div className="pos-categories">
      <button
        className={`pos-cat-btn ${!selected ? 'active' : ''}`}
        onClick={() => onSelect(null)}
      >
        Tous
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          className={`pos-cat-btn ${selected === c.id ? 'active' : ''}`}
          onClick={() => onSelect(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
